// 생성 평가(T-104): 평가셋의 비유 있는 문장마다 확장과 같은 생성(runAnalogy, 규칙 1·근거 검사 포함)을 돌리고,
// --judge 면 생성과 다른 모델이 근거 준수·구조 대응·자연스러움을 채점한다.
// 사용법 (프로젝트 루트에서, 키는 환경변수 <ID>_API_KEY 에서만 읽는다):
//   npm run eval:gen                         # 생성만. admin.json fallbackChain 중 키가 있는 제공자로
//   npm run eval:gen -- --judge              # 생성 + 채점 (JUDGE_PROVIDER=gemini, JUDGE_MODEL=gemini-3.8-flash 기본)
//   npm run eval:gen -- --limit 5            # 앞 5문장만 (기본: 비유 있는 문장 전부)
//   npm run eval:gen -- --rpm 10             # 분당 LLM 호출 수 상한(기본 10, 무료 한도용)
//   npm run eval:gen -- --provider nvidia    # 생성 제공자 강제(체인 없음). 모델은 <ID>_MODEL 또는 admin.defaultModels
//   npm run eval:gen -- --judge --from .tmp/eval-gen-2026-11-08.json   # 저장된 생성 결과만 다시 채점
// 결과: .tmp/eval-gen-<YYYY-MM-DD>.json (커밋 안 함). 키는 출력·파일에 남기지 않는다.
import fs from 'node:fs';
import { mergeGraphs, tagText, nodeText } from '../extension/lib/graph.js';
import { retrieve } from '../extension/lib/retrieval.js';
import { PROVIDERS, complete } from '../extension/lib/providers.js';
import { buildChain, completeWithFallback } from '../extension/lib/fallback.js';
import { providerFor } from '../extension/lib/config.js';
import { runAnalogy } from '../extension/lib/pipeline.js';
import { openBrowserEmbedder } from './browser-embedder.mjs';
import { buildJudgePrompt, parseJudge, summarize, assertDifferentModels, modelKey, evalLogRow } from './eval-gen-lib.mjs';

const here = new URL('.', import.meta.url);
const admin = JSON.parse(fs.readFileSync(new URL('../extension/config/admin.json', here)));
const common = JSON.parse(fs.readFileSync(new URL('../extension/data/common/maplestory.json', here)));
const evalSet = JSON.parse(fs.readFileSync(new URL('./eval-set.json', here)));

const argAfter = flag => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : null; };
const doJudge = process.argv.includes('--judge');
const limit = Number(argAfter('--limit')) || Infinity;
const rpm = Number(argAfter('--rpm')) || 10;
const forced = argAfter('--provider');
const fromFile = argAfter('--from');
// 로컬 날짜(UTC로 하면 한국 오전에 전날로 찍힌다)
const today = new Date().toLocaleDateString('sv-SE');
const outFile = new URL(`../.tmp/eval-gen-${today}.json`, here);

// ── 제공자: 키는 환경변수에서만 ──
const envKeys = Object.fromEntries(Object.keys(PROVIDERS).map(id => [id, process.env[`${id.toUpperCase()}_API_KEY`] || '']).filter(([, k]) => k));
const settings = { apiKeys: envKeys };

async function reachable(baseUrl) {
  try { const r = await fetch(baseUrl.replace(/\/v1$/, '') + '/api/version', { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
}

async function generationChain() {
  if (forced) {
    if (!PROVIDERS[forced]) throw new Error(`알 수 없는 제공자: ${forced}`);
    const p = providerFor(forced, process.env[`${forced.toUpperCase()}_MODEL`] || null, admin, settings);
    if (!p.apiKey && !p.def.keyOptional) throw new Error(`${forced.toUpperCase()}_API_KEY가 없어요.`);
    return [p];
  }
  // admin 체인에서 쓸 수 있는 첫 항목을 1순위로 두고 buildChain 으로 나머지를 붙인다(확장과 같은 규칙)
  const usable = [];
  for (const { provider, model } of admin.fallbackChain || []) {
    if (!PROVIDERS[provider]) continue;
    const p = providerFor(provider, model, admin, settings);
    if (p.def.local ? await reachable(p.baseUrl) : !!p.apiKey) usable.push(p);
  }
  if (!usable.length) throw new Error('생성에 쓸 제공자가 없어요. GEMINI_API_KEY 같은 키를 환경변수로 넣어 주세요.');
  const unreachable = new Set((admin.fallbackChain || []).filter(e => PROVIDERS[e.provider]?.local && !usable.some(u => u.id === e.provider)).map(e => e.provider));
  return buildChain(usable[0], admin, settings).filter(p => !unreachable.has(p.id));
}

function judgeProvider() {
  const id = process.env.JUDGE_PROVIDER || 'gemini';
  if (!PROVIDERS[id]) throw new Error(`알 수 없는 채점 제공자: ${id}`);
  const p = providerFor(id, process.env.JUDGE_MODEL || 'gemini-3.8-flash', admin, settings);
  if (!p.apiKey && !p.def.keyOptional) throw new Error(`채점에 쓸 ${id.toUpperCase()}_API_KEY가 없어요.`);
  return p;
}

// ── 호출 간격(분당 rpm회)과 한도 재시도 ──
let lastCall = 0;
async function paced(fn) {
  const gap = 60_000 / rpm, wait = lastCall + gap - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();
  return fn();
}
// 체인을 다 돌고도 429·5xx·시간 초과면 기다렸다 다시(평가 도구 전용, eval.mjs --rewrite 와 같은 방식).
// 시간 초과(30초)는 providers.js 고정값이라, 생각이 긴 채점 모델은 여기서 다시 부른다
const transient = e => e.status === 429 || e.status >= 500 || /시간이 초과/.test(e.message);
async function withLimitRetry(fn) {
  for (let tries = 0; ; tries++) {
    try { return await paced(fn); } catch (e) {
      if (tries >= 4 || !transient(e)) throw e;
      console.log(`  ${e.status || e.message}, 30초 뒤 다시 (${tries + 1}/4)`);
      await new Promise(r => setTimeout(r, 30_000));
    }
  }
}

const cooldownState = {};
const cooldowns = { get: async () => ({ ...cooldownState }), set: async obj => { Object.assign(cooldownState, obj); } };

// ── 생성 ──
async function generate(cases) {
  const chain = await generationChain();
  console.log(`생성 체인: ${chain.map(modelKey).join(' → ')}`);
  if (doJudge) assertDifferentModels(chain[0], judgeProvider());

  console.log(`확장 안에서 임베딩 모델 준비 중: ${admin.embedding.model} (${admin.embedding.dtype})`);
  const be = await openBrowserEmbedder();
  const graph = mergeGraphs(common, null);
  const tagMap = new Map(graph.tags.map(t => [t.id, t]));
  const keys = [...graph.tags.map(t => 'tag:' + t.id), ...graph.nodes.map(n => 'node:' + n.id)];
  const vs = await be.embed([...graph.tags.map(tagText), ...graph.nodes.map(n => nodeText(n, tagMap))], 'passage');
  const vecs = new Map(keys.map((k, i) => [k, vs[i]]));
  const qs = await be.embed(cases.map(c => c.sentence), 'query');
  await be.close();

  const rows = [];
  for (const [i, c] of cases.entries()) {
    const candidates = retrieve(qs[i], graph, vecs, admin.retrieval);
    let used = null, fallbacks = [];
    const ask = async (system, user, opts) => {
      const r = await withLimitRetry(() => completeWithFallback(chain, system, user, opts, { cooldowns, cooldown: admin.cooldown }));
      used = r.provider; fallbacks = r.fallbacks;
      return r.text;
    };
    const t0 = Date.now();
    const base = { sentence: c.sentence, expectNodes: c.expectNodes, candidates: candidates.map(x => ({ id: x.id, label: x.label, score: x.score, facts: x.facts })) };
    try {
      const r = await runAnalogy({ sentence: c.sentence, word: '', context: '', pageTitle: '', graph, candidates, ask, providerKind: chain[0].def.kind });
      const { meaning, analogy, nodeId, usedFact } = r.answer;
      rows.push({ ...base, answer: { meaning, analogy, nodeId, usedFact }, rejected: r.rejected, grounding: r.grounding, provider: used && modelKey(used), fallbacks, ms: Date.now() - t0 });
      console.log(`  ${i + 1}/${cases.length} ${analogy ? `[${nodeId}]` : `(숨김${r.rejected ? ': ' + r.rejected : ''})`} ${c.sentence.slice(0, 28)}… ${Date.now() - t0}ms`);
    } catch (e) {
      rows.push({ ...base, error: e.message.slice(0, 200), provider: used && modelKey(used), ms: Date.now() - t0 });
      console.log(`  ${i + 1}/${cases.length} ✗ ${e.message.slice(0, 80)}`);
    }
  }
  return rows;
}

// ── 채점 ──
async function judgeRows(rows) {
  const judge = judgeProvider();
  console.log(`\n채점 모델: ${modelKey(judge)}`);
  for (const [i, r] of rows.entries()) {
    if (r.error || !r.answer?.analogy) continue;
    // 체인이 넘어갔을 수 있어 행마다 실제로 답한 모델과 비교한다
    if (r.provider) assertDifferentModels(r.provider, judge);
    const chosen = r.candidates.find(c => c.id === r.answer.nodeId) || null;
    const p = buildJudgePrompt({ sentence: r.sentence, candidates: r.candidates, chosen, analogy: r.answer.analogy });
    try {
      const text = await withLimitRetry(() => complete(judge, p.system, p.user, { json: true }));
      r.judge = parseJudge(text);
      if (!r.judge) r.judgeError = '채점 응답을 해석하지 못했어요: ' + text.slice(0, 120);
    } catch (e) {
      r.judge = null;
      r.judgeError = e.message.slice(0, 200);
    }
    r.judgeModel = modelKey(judge);
    console.log(`  ${i + 1}/${rows.length} ${r.judge ? `근거 ${r.judge.grounded ? '○' : '✗'} 구조 ${r.judge.structure} 자연 ${r.judge.natural}` : `✗ ${r.judgeError.slice(0, 60)}`}`);
  }
  return modelKey(judge);
}

// ── 실행 ──
// 설정 오류(키 없음, 채점 모델 같음 등)는 스택 없이 한 줄로 알리고 멈춘다
process.on('uncaughtException', e => { console.error(`\n멈췄어요: ${e.message}`); process.exit(1); });
process.on('unhandledRejection', e => { console.error(`\n멈췄어요: ${e?.message ?? e}`); process.exit(1); });
let rows;
if (fromFile) {
  rows = JSON.parse(fs.readFileSync(fromFile)).rows;
  console.log(`저장된 생성 결과 ${rows.length}건: ${fromFile}`);
} else {
  const cases = evalSet.filter(c => c.expectNodes?.length).slice(0, limit);
  console.log(`비유 있는 문장 ${cases.length}개 · 분당 ${rpm}회`);
  rows = await generate(cases);
}
const save = judgeModel => {
  fs.mkdirSync(new URL('../.tmp/', here), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ date: today, judgeModel: judgeModel || null, rows }, null, 2));
};
save();
const judgeModel = doJudge ? await judgeRows(rows) : null;
save(judgeModel);

const s = summarize(rows);
const pct = v => (v == null ? '—' : `${Math.round(v * 100)}%`);
const fix2 = v => (v == null ? '—' : v.toFixed(2));
const genModels = [...new Set(rows.map(r => r.provider).filter(Boolean))];
console.log(`\n결과 저장: ${outFile.pathname}`);
console.log(`문장 ${s.n} · 숨김 ${s.hidden} · 생성 실패 ${s.errors} · 채점 ${s.judged}${s.unjudged ? ` · 채점 안 됨 ${s.unjudged}` : ''}`);
if (doJudge) {
  console.log(`근거 준수율 ${pct(s.groundedRate)} · 구조 평균 ${fix2(s.structureAvg)} · 자연스러움 평균 ${fix2(s.naturalAvg)}`);
  for (const v of s.violations) console.log(`  ✗ 근거 위반 [${v.nodeId}] ${v.sentence.slice(0, 32)}… — ${v.reason}`);
  for (const v of s.weak) console.log(`  △ 구조 ${v.structure} [${v.nodeId}] ${v.sentence.slice(0, 32)}… — ${v.reason}`);
  console.log(`\nEVAL_LOG 한 줄:\n${evalLogRow(s, { date: today, gen: genModels, judge: judgeModel, embedder: `${admin.embedding.model} ${admin.embedding.dtype} · 실제 확장` })}`);
}

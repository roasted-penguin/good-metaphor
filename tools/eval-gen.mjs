// 생성 평가(T-104): 평가셋의 비유 있는 문장마다 확장과 같은 생성(runAnalogy, 규칙 1·근거 검사 포함)을 돌리고,
// --judge 면 생성과 다른 모델이 근거 준수·구조 대응·자연스러움을 채점한다.
// 사용법 (프로젝트 루트에서, 키는 환경변수 <ID>_API_KEY 에서만 읽는다):
//   npm run eval:gen                         # 생성만. admin.json fallbackChain 중 키가 있는 제공자로
//   npm run eval:gen -- --judge              # 생성 + 채점 (기본 JUDGE_PROVIDER=nvidia, JUDGE_MODEL=nvidia/nemotron-3.5-super-vl-120b-a12b)
//                                            # 채점 모델은 생성 체인에서 빠진다(생성 모델 ≠ 채점 모델)
//   npm run eval:gen -- --limit 5            # 앞 5문장만 (기본: 비유 있는 문장 전부, 0 이상 정수)
//   npm run eval:gen -- --rpm 10             # 분당 LLM 호출 수 상한(기본 10, 무료 한도용)
//   npm run eval:gen -- --provider nvidia    # 생성 제공자 강제(체인 없음). 모델은 <ID>_MODEL 또는 admin.defaultModels
//   npm run eval:gen -- --judge --from .tmp/eval-gen-2026-11-08.json   # 저장된 생성 결과만 다시 채점
//                                            # 채점 모델이 생성한 행은 건너뛰고 '채점 안 됨'으로 센다
// 결과: .tmp/eval-gen-<YYYY-MM-DD>.json (커밋 안 함). 키는 출력·파일에 남기지 않는다.
import fs from 'node:fs';
import { mergeGraphs, embedItems } from '../extension/lib/graph.js';
import { loadCommonGraphFromDisk } from './load-graph.mjs';
import { retrieve } from '../extension/lib/retrieval.js';
import { PROVIDERS, complete } from '../extension/lib/providers.js';
import { buildChain, completeWithFallback } from '../extension/lib/fallback.js';
import { providerFor } from '../extension/lib/config.js';
import { runAnalogy } from '../extension/lib/pipeline.js';
import { openBrowserEmbedder } from './browser-embedder.mjs';
import { buildJudgePrompt, parseJudge, summarize, assertDifferentModels, modelKey, evalLogRow, withoutModel, judgePlan, parseLimit, pct, fix2 } from './eval-gen-lib.mjs';

const here = new URL('.', import.meta.url);
const admin = JSON.parse(fs.readFileSync(new URL('../extension/config/admin.json', here)));
const common = loadCommonGraphFromDisk(); // 그래프 + tags.json (T-304)
const evalSet = JSON.parse(fs.readFileSync(new URL('./eval-set.json', here)));
// 금칙어 목록(T-114). 확장 background.js와 같은 번들 파일을 runAnalogy에 준다
const blocklist = JSON.parse(fs.readFileSync(new URL('../extension/data/common/blocklist.json', here))).terms;

const argAfter = flag => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : null; };
const doJudge = process.argv.includes('--judge');
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
  const judge = doJudge ? judgeProvider() : null;
  // 채점을 하면 채점 모델을 체인에서 뺀다(생성 모델이 채점 모델이 될 수 없게)
  const finish = chain => {
    const out = judge ? withoutModel(chain, judge) : chain;
    if (!out.length) throw new Error(`채점 모델(${modelKey(judge)})을 빼고 나니 생성에 쓸 모델이 없어요. --provider나 JUDGE_MODEL을 바꿔 주세요.`);
    if (judge) for (const p of out) assertDifferentModels(p, judge);
    return out;
  };
  if (forced) {
    if (!PROVIDERS[forced]) throw new Error(`알 수 없는 제공자: ${forced}`);
    const p = providerFor(forced, process.env[`${forced.toUpperCase()}_MODEL`] || null, admin, settings);
    if (!p.apiKey && !p.def.keyOptional) throw new Error(`${forced.toUpperCase()}_API_KEY가 없어요.`);
    return finish([p]);
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
  return finish(buildChain(usable[0], admin, settings).filter(p => !unreachable.has(p.id)));
}

function judgeProvider() {
  // 기본 채점 모델: NVIDIA(gemini-3.8-flash는 이 키로 시간 초과, T-104 Task 2 결정)
  const id = process.env.JUDGE_PROVIDER || 'nvidia';
  if (!PROVIDERS[id]) throw new Error(`알 수 없는 채점 제공자: ${id}`);
  const p = providerFor(id, process.env.JUDGE_MODEL || (id === 'nvidia' ? 'nvidia/nemotron-3.5-super-vl-120b-a12b' : null), admin, settings);
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
// 결과 행은 실행 중에 바로 이 배열에 쌓는다(오류로 멈춰도 그때까지의 결과·채점을 저장하려고)
let rows = [];
let judgeModel = null;
const save = () => {
  fs.mkdirSync(new URL('../.tmp/', here), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ date: today, judgeModel, rows }, null, 2));
};

async function generate(cases) {
  const chain = await generationChain();
  console.log(`생성 체인: ${chain.map(modelKey).join(' → ')}`);
  if (!cases.length) return;

  const graph = mergeGraphs(common, null);
  let vecs, qs;
  console.log(`확장 안에서 임베딩 모델 준비 중: ${admin.embedding.model} (${admin.embedding.dtype})`);
  const be = await openBrowserEmbedder();
  try {
    const items = embedItems(graph, admin.retrieval); // 확장과 같은 구성 (T-154)
    const vs = await be.embed(items.map(it => it.text), 'passage');
    vecs = new Map(items.map((it, i) => [it.key, vs[i]]));
    qs = await be.embed(cases.map(c => c.sentence), 'query');
  } finally {
    await be.close();
  }

  for (const [i, c] of cases.entries()) {
    const candidates = retrieve(qs[i], graph, vecs, { ...admin.retrieval, aliasText: c.sentence });
    let used = null, fallbacks = [];
    const ask = async (system, user, opts) => {
      const r = await withLimitRetry(() => completeWithFallback(chain, system, user, opts, { cooldowns, cooldown: admin.cooldown }));
      used = r.provider; fallbacks = r.fallbacks;
      return r.text;
    };
    const t0 = Date.now();
    const base = { sentence: c.sentence, expectNodes: c.expectNodes, candidates: candidates.map(x => ({ id: x.id, label: x.label, score: x.score, facts: x.facts })) };
    try {
      const r = await runAnalogy({ sentence: c.sentence, word: '', context: '', pageTitle: '', graph, candidates, ask, providerKind: chain[0].def.kind, blocklist });
      const { meaning, analogy, nodeId, usedFact } = r.answer;
      rows.push({ ...base, answer: { meaning, analogy, nodeId, usedFact }, rejected: r.rejected, grounding: r.grounding, provider: used && modelKey(used), fallbacks, ms: Date.now() - t0 });
      console.log(`  ${i + 1}/${cases.length} ${analogy ? `[${nodeId}]` : `(숨김${r.rejected ? ': ' + r.rejected : ''})`} ${c.sentence.slice(0, 28)}… ${Date.now() - t0}ms`);
    } catch (e) {
      rows.push({ ...base, error: e.message.slice(0, 200), provider: used && modelKey(used), ms: Date.now() - t0 });
      console.log(`  ${i + 1}/${cases.length} ✗ ${e.message.slice(0, 80)}`);
    }
  }
}

// ── 채점 ──
async function judgeRows() {
  const judge = judgeProvider();
  judgeModel = modelKey(judge);
  console.log(`\n채점 모델: ${judgeModel}`);
  for (const [i, r] of rows.entries()) {
    // 생성 체인에서 채점 모델을 뺐으니 새 생성에선 안 생긴다. --from 입력에서 채점 모델이 생성한 행은 표시만 하고 건너뛴다
    const plan = judgePlan(r, judge);
    if (!plan.judge) {
      if (plan.judgeError) { r.judge = null; r.judgeError = plan.judgeError; console.log(`  ${i + 1}/${rows.length} 건너뜀: ${plan.judgeError}`); }
      continue;
    }
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
    r.judgeModel = judgeModel;
    save(); // 채점 호출마다 저장(유료·한도 호출 결과를 잃지 않게)
    console.log(`  ${i + 1}/${rows.length} ${r.judge ? `근거 ${r.judge.grounded ? '○' : '✗'} 구조 ${r.judge.structure} 자연 ${r.judge.natural}` : `✗ ${r.judgeError.slice(0, 60)}`}`);
  }
}

// ── 실행 ──
// 설정 오류(키 없음, 채점 모델 같음 등)는 스택 없이 한 줄로 알리고 멈춘다
// 멈추기 전에 그때까지의 결과를 저장한다(행이 있을 때만, 빈 결과로 이전 파일을 덮지 않게)
const stop = e => {
  if (rows.length) { try { save(); console.error(`\n지금까지 결과 ${rows.length}건 저장: ${outFile.pathname}`); } catch {} }
  console.error(`\n멈췄어요: ${e?.message ?? e}`);
  process.exit(1);
};
process.on('uncaughtException', stop);
process.on('unhandledRejection', stop);
if (fromFile) {
  rows = JSON.parse(fs.readFileSync(fromFile)).rows;
  console.log(`저장된 생성 결과 ${rows.length}건: ${fromFile}`);
} else {
  // 오류 처리기를 건 뒤에 읽는다(잘못된 값이면 한 줄 오류로 멈추게)
  const limit = parseLimit(process.argv.includes('--limit') ? argAfter('--limit') ?? '' : null);
  const cases = evalSet.filter(c => c.expectNodes?.length).slice(0, limit);
  console.log(`비유 있는 문장 ${cases.length}개 · 분당 ${rpm}회`);
  await generate(cases);
}
// 행이 없으면(--limit 0) 같은 날 파일을 빈 결과로 덮지 않는다
if (rows.length) save();
if (doJudge) { await judgeRows(); if (rows.length) save(); }

const s = summarize(rows);
const genModels = [...new Set(rows.map(r => r.provider).filter(Boolean))];
console.log(rows.length ? `\n결과 저장: ${outFile.pathname}` : '\n결과 없음(저장 안 함)');
console.log(`문장 ${s.n} · 숨김 ${s.hidden} · 생성 실패 ${s.errors} · 채점 ${s.judged}${s.unjudged ? ` · 채점 안 됨 ${s.unjudged}` : ''}`);
if (doJudge) {
  console.log(`근거 준수율 ${pct(s.groundedRate)} · 구조 평균 ${fix2(s.structureAvg)} · 자연스러움 평균 ${fix2(s.naturalAvg)}`);
  for (const v of s.violations) console.log(`  ✗ 근거 위반 [${v.nodeId}] ${v.sentence.slice(0, 32)}… — ${v.reason}`);
  for (const v of s.weak) console.log(`  △ 구조 ${v.structure} [${v.nodeId}] ${v.sentence.slice(0, 32)}… — ${v.reason}`);
  console.log(`\nEVAL_LOG 한 줄:\n${evalLogRow(s, { date: today, gen: genModels, judge: judgeModel, embedder: `${admin.embedding.model} ${admin.embedding.dtype} · 실제 확장` })}`);
}

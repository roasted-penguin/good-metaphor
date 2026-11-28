// 이어 묻기 평가(T-218, ADR 0017 에이전트 1). tools/eval-followup.json 문항마다
//   1) 호버와 같은 생성(runAnalogy)으로 "방금 보인 결과"와 후보를 만들고
//   2) 확장과 같은 이어 묻기 루프(runFollowup, agent-tools.js)를 돈 뒤
//   3) --judge 면 생성과 다른 계열 모델이 근거 준수·도움됨·해요체를 채점한다.
// 코드로 재는 지표: 규칙 1·근거 검사로 숨김, 기대(없음/개념/다른 개념) 지킴, JSON 액션 형식, 호출·단계 수, 지연.
// 사용법 (프로젝트 루트에서, 키는 환경변수 <ID>_API_KEY 에서만 읽는다):
//   npm run eval:followup                          # 생성만. admin.json fallbackChain 중 키가 있는 제공자로
//   npm run eval:followup -- --judge               # + 채점(기본 JUDGE_PROVIDER=nvidia). 채점 계열(제공자)은 생성 체인에서 빠진다
//   npm run eval:followup -- --provider gemini     # 생성 제공자 강제(체인 없음). 모델은 <ID>_MODEL 또는 admin.defaultModels
//   npm run eval:followup -- --limit 12            # 앞 12문항만(앞쪽은 문장이 겹쳐 호버 호출이 적다)
//   npm run eval:followup -- --max-calls 40        # 생성 LLM 호출(호버 + 이어 묻기) 상한. 넘길 수 있는 문항 앞에서 멈추고 저장
//   npm run eval:followup -- --fallback            # 크롬 없이 글자 n-gram 대체 임베더로 검색(형식 확인용, 검색 품질은 실제와 다름)
//   npm run eval:followup -- --rpm 10              # 분당 LLM 호출 상한(기본 10)
//   npm run eval:followup -- --fresh               # 캐시를 쓰지 않고 다시
//   npm run eval:followup -- --judge --from .tmp/eval-followup-2026-11-28.json   # 저장된 결과만 다시 채점
// 기본 검색은 실제 확장(크롬) 안 임베딩이다. e2e·eval과 크롬을 같이 쓰므로 공용 잠금 안에서 돌린다.
// 결과: .tmp/eval-followup-<날짜>.json, 캐시: .tmp/eval-followup-cache.json (호버·이어 묻기·채점 결과, 커밋 안 함). 키는 남기지 않는다.
import fs from 'node:fs';
import { mergeGraphs, embedItems } from '../extension/lib/graph.js';
import { loadCommonGraphFromDisk } from './load-graph.mjs';
import { retrieve, retrievalFor } from '../extension/lib/retrieval.js';
import { PROVIDERS, complete } from '../extension/lib/providers.js';
import { buildChain, completeWithFallback } from '../extension/lib/fallback.js';
import { providerFor } from '../extension/lib/config.js';
import { runAnalogy } from '../extension/lib/pipeline.js';
import { hashEmbed } from '../extension/lib/fallback-embed.js';
import { AGENT_MAX_CALLS } from '../extension/lib/agent.js';
import { modelKey, parseLimit } from './eval-gen-lib.mjs';
import {
  validateFollowupSet, makeSearchGraph, hoverToPrev, runFollowupCase, scoreRow, buildFollowupJudgePrompt, parseFollowupJudge,
  summarizeFollowup, summaryLines, followupLogRow, hoverKey, agentKey, judgeKey, withoutFamily, familyOf
} from './eval-followup-lib.mjs';

const here = new URL('.', import.meta.url);
const admin = JSON.parse(fs.readFileSync(new URL('../extension/config/admin.json', here)));
const blocklist = JSON.parse(fs.readFileSync(new URL('../extension/data/common/blocklist.json', here))).terms;
const graph = mergeGraphs(loadCommonGraphFromDisk(), null);
const items = validateFollowupSet(JSON.parse(fs.readFileSync(new URL('./eval-followup.json', here))), graph);

const argAfter = flag => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : null; };
const has = flag => process.argv.includes(flag);
const doJudge = has('--judge');
const useFallback = has('--fallback');
const fresh = has('--fresh');
const rpm = Number(argAfter('--rpm')) || 10;
const maxCalls = Number(argAfter('--max-calls')) || Infinity;
const forced = argAfter('--provider');
const fromFile = argAfter('--from');
const today = new Date().toLocaleDateString('sv-SE');
const outFile = new URL(`../.tmp/eval-followup-${today}.json`, here);
const cacheFile = new URL('../.tmp/eval-followup-cache.json', here);

const envKeys = Object.fromEntries(Object.keys(PROVIDERS).map(id => [id, process.env[`${id.toUpperCase()}_API_KEY`] || '']).filter(([, k]) => k));
const settings = { apiKeys: envKeys };

let cache = {};
try { if (!fresh) cache = JSON.parse(fs.readFileSync(cacheFile)); } catch {}
const saveCache = () => { fs.mkdirSync(new URL('../.tmp/', here), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 1)); };

function judgeProvider() {
  const id = process.env.JUDGE_PROVIDER || 'nvidia';
  if (!PROVIDERS[id]) throw new Error(`알 수 없는 채점 제공자: ${id}`);
  const p = providerFor(id, process.env.JUDGE_MODEL || null, admin, settings);
  if (!p.apiKey && !p.def.keyOptional) throw new Error(`채점에 쓸 ${id.toUpperCase()}_API_KEY가 없어요.`);
  return p;
}

async function reachable(baseUrl) {
  try { const r = await fetch(baseUrl.replace(/\/v1$/, '') + '/api/version', { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
}

async function generationChain() {
  const judge = doJudge ? judgeProvider() : null;
  const finish = chain => {
    const out = judge ? withoutFamily(chain, judge) : chain;
    if (!out.length) throw new Error(`채점 계열(${familyOf(judge)})을 빼고 나니 생성에 쓸 모델이 없어요. --provider나 JUDGE_PROVIDER를 바꿔 주세요.`);
    return out;
  };
  if (forced) {
    if (!PROVIDERS[forced]) throw new Error(`알 수 없는 제공자: ${forced}`);
    const p = providerFor(forced, process.env[`${forced.toUpperCase()}_MODEL`] || null, admin, settings);
    if (!p.apiKey && !p.def.keyOptional) throw new Error(`${forced.toUpperCase()}_API_KEY가 없어요.`);
    return finish([p]);
  }
  const usable = [];
  for (const { provider, model } of admin.fallbackChain || []) {
    if (!PROVIDERS[provider]) continue;
    const p = providerFor(provider, model, admin, settings);
    if (p.def.local ? await reachable(p.baseUrl) : !!p.apiKey) usable.push(p);
  }
  if (!usable.length) throw new Error('생성에 쓸 제공자가 없어요. GEMINI_API_KEY 같은 키를 환경변수로 넣어 주세요.');
  const unreachable = new Set((admin.fallbackChain || []).filter(e => PROVIDERS[e.provider]?.local && !usable.some(u => u.id === e.provider)).map(e => e.provider));
  return finish(buildChain(usable[0], admin, settings).filter(p => !unreachable.has(p.id) && (p.def.local || p.apiKey)));
}

// 호출 간격과 한도 재시도(eval-gen과 같은 방식)
// waited: 간격·재시도로 기다린 시간. 지연 지표에서 뺀다(모델 시간만 보이게)
let lastCall = 0, waited = 0;
const modelClock = () => Date.now() - waited;
async function paced(fn) {
  const gap = 60_000 / rpm, wait = lastCall + gap - Date.now();
  if (wait > 0) { await new Promise(r => setTimeout(r, wait)); waited += wait; }
  lastCall = Date.now();
  return fn();
}
const transient = e => e.status === 429 || e.status >= 500 || /시간이 초과/.test(e.message);
async function withLimitRetry(fn) {
  for (let tries = 0; ; tries++) {
    try { return await paced(fn); } catch (e) {
      if (tries >= 3 || !transient(e)) throw e;
      console.log(`  ${e.status || e.message}, 30초 뒤 다시 (${tries + 1}/3)`);
      await new Promise(r => setTimeout(r, 30_000));
      waited += 30_000;
    }
  }
}
const cooldownState = {};
const cooldowns = { get: async () => ({ ...cooldownState }), set: async obj => { Object.assign(cooldownState, obj); } };

let rows = [];
let meta = {};
const save = () => {
  fs.mkdirSync(new URL('../.tmp/', here), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ date: today, ...meta, rows }, null, 2));
};

async function openEmbedder() {
  if (useFallback) return { id: 'fallback-ngram', embed: async (texts) => texts.map(t => hashEmbed(t)), close: async () => {} };
  const { openBrowserEmbedder } = await import('./browser-embedder.mjs');
  console.log(`확장 안에서 임베딩 모델 준비 중: ${admin.embedding.model} (${admin.embedding.dtype})`);
  const be = await openBrowserEmbedder();
  return { id: `${admin.embedding.model} ${admin.embedding.dtype}`, embed: (texts, kind) => be.embed(texts, kind), close: () => be.close() };
}

async function generate(cases) {
  const chain = await generationChain();
  const gen = chain.map(modelKey).join('>');
  console.log(`생성 체인: ${chain.map(modelKey).join(' → ')}`);
  const emb = await openEmbedder();
  meta = { ...meta, embedder: emb.id, chain: chain.map(modelKey) };
  let calls = 0;
  try {
    const its = embedItems(graph, admin.retrieval);
    const vs = await emb.embed(its.map(it => it.text), 'passage');
    const vecs = new Map(its.map((it, i) => [it.key, vs[i]]));
    const qcache = new Map();
    const embedQuery = async t => { if (!qcache.has(t)) qcache.set(t, (await emb.embed([t], 'query'))[0]); return qcache.get(t); };
    const searchGraph = makeSearchGraph({ graph, vecs, embedQuery, retrieval: admin.retrieval });
    const used = new Set();
    const ask = async (system, user, opts) => {
      if (calls >= maxCalls) throw Object.assign(new Error('--max-calls 상한'), { budget: true });
      calls++;
      const r = await withLimitRetry(() => completeWithFallback(chain, system, user, opts, { cooldowns, cooldown: admin.cooldown }));
      used.add(modelKey(r.provider));
      return r.text;
    };

    for (const [i, item] of cases.entries()) {
      // 1) 호버(문장이 같으면 캐시)
      const hk = hoverKey(gen, emb.id, item.sentence);
      if (!cache[hk]) {
        if (calls + 2 > maxCalls) { console.log(`  --max-calls ${maxCalls}에 닿아 멈춰요`); break; }
        const q = await embedQuery(item.sentence);
        const candidates = retrieve(q, graph, vecs, { ...retrievalFor(admin.retrieval, graph), aliasText: item.sentence });
        try {
          const r = await runAnalogy({ sentence: item.sentence, word: '', context: '', pageTitle: '', graph, candidates, ask, providerKind: chain[0].def.kind, blocklist });
          cache[hk] = hoverToPrev(r, candidates);
          saveCache();
        } catch (e) {
          if (e.budget) { console.log(`  --max-calls ${maxCalls}에 닿아 멈춰요`); break; }
          rows.push({ id: item.id, sentence: item.sentence, question: item.question, expect: item.expect, error: `호버: ${e.message.slice(0, 160)}`, calls: 0, ms: 0 });
          console.log(`  ${i + 1}/${cases.length} ✗ 호버 ${e.message.slice(0, 80)}`);
          continue;
        }
      }
      const { prev, candidateIds } = cache[hk];
      // 2) 이어 묻기
      const ak = agentKey(gen, emb.id, item);
      let row = cache[ak];
      if (!row) {
        // 이어 묻기는 최대 AGENT_MAX_CALLS(4)회. 상한을 넘길 수 있으면 시작하지 않는다
        if (calls + AGENT_MAX_CALLS > maxCalls) { console.log(`  --max-calls ${maxCalls}에 닿아 멈춰요`); break; }
        used.clear();
        row = await runFollowupCase({ item, graph, prev, candidateIds, ask, searchGraph, blocklist, now: modelClock });
        row.provider = [...used].join(',');
        if (!row.error && row.stop !== 'llm-error') { cache[ak] = row; saveCache(); }
      } else row = { ...row, cached: true };
      row.score = scoreRow(row, item);
      rows.push(row);
      const tag = row.error ? `✗ ${row.error.slice(0, 60)}` : row.answer ? `[${row.evidence?.nodeId || '개념 없음'}]` : row.stop ? `(멈춤 ${row.stop})` : `(숨김 ${row.score.hidden})`;
      console.log(`  ${i + 1}/${cases.length} ${item.id} ${tag} 기대 ${row.score.expectOk ? '○' : '✗'} 호출 ${row.calls} ${row.ms}ms${row.cached ? ' (캐시)' : ''}  ${item.question}`);
      if (row.answer) console.log(`      → ${row.answer}`);
    }
  } finally {
    await emb.close();
  }
  meta.genCalls = calls;
  console.log(`이번 실행 생성 LLM 호출 ${calls}회`);
}

async function judgeRows() {
  const judge = judgeProvider();
  const jk = modelKey(judge);
  meta.judgeModel = jk;
  console.log(`\n채점 모델: ${jk}`);
  for (const [i, r] of rows.entries()) {
    if (r.error || !r.rawFinal) continue;
    if ((r.provider || '').split(',').some(m => m && m.split('/')[0] === familyOf(judge))) {
      r.judge = null; r.judgeError = '채점 계열과 같은 제공자가 생성함'; continue;
    }
    const key = judgeKey(jk, r);
    if (cache[key]) { r.judge = cache[key]; r.judgeModel = jk; continue; }
    const p = buildFollowupJudgePrompt(r, graph);
    try {
      const text = await withLimitRetry(() => complete(judge, p.system, p.user, { json: true }));
      r.judge = parseFollowupJudge(text);
      if (!r.judge) r.judgeError = '채점 응답을 해석하지 못했어요: ' + text.slice(0, 120);
      else { cache[key] = r.judge; saveCache(); }
    } catch (e) {
      r.judge = null;
      r.judgeError = e.message.slice(0, 200);
    }
    r.judgeModel = jk;
    save();
    console.log(`  ${i + 1}/${rows.length} ${r.id} ${r.judge ? `근거 ${r.judge.grounded ? '○' : '✗'} 도움 ${r.judge.helpful} 해요 ${r.judge.haeyo ? '○' : '✗'}` : `✗ ${r.judgeError.slice(0, 60)}`}`);
  }
}

const stop = e => {
  if (rows.length) { try { save(); console.error(`\n지금까지 결과 ${rows.length}건 저장: ${outFile.pathname}`); } catch {} }
  console.error(`\n멈췄어요: ${e?.message ?? e}`);
  process.exit(1);
};
process.on('uncaughtException', stop);
process.on('unhandledRejection', stop);

if (fromFile) {
  const saved = JSON.parse(fs.readFileSync(fromFile));
  rows = saved.rows;
  meta = { embedder: saved.embedder, chain: saved.chain, genCalls: saved.genCalls };
  const byId = new Map(items.map(it => [it.id, it]));
  for (const r of rows) r.score = scoreRow(r, byId.get(r.id) || {});
  console.log(`저장된 결과 ${rows.length}건: ${fromFile}`);
} else {
  const limit = parseLimit(has('--limit') ? argAfter('--limit') ?? '' : null);
  const cases = items.slice(0, limit);
  console.log(`이어 묻기 ${cases.length}문항 · 분당 ${rpm}회${Number.isFinite(maxCalls) ? ` · 생성 호출 상한 ${maxCalls}` : ''}`);
  await generate(cases);
}
if (rows.length) save();
if (doJudge) { await judgeRows(); if (rows.length) save(); }

const s = summarizeFollowup(rows);
console.log(rows.length ? `\n결과 저장: ${outFile.pathname}` : '\n결과 없음(저장 안 함)');
for (const l of summaryLines(s)) console.log(l);
for (const v of s.violations) console.log(`  ✗ 근거 위반 ${v.id}: ${v.answer.slice(0, 50)} — ${v.reason}`);
const gens = [...new Set(rows.flatMap(r => (r.provider || '').split(',')).filter(Boolean))];
console.log(`\nEVAL_LOG 한 줄:\n${followupLogRow(s, { date: today, gen: gens, judge: meta.judgeModel || '—', embedder: `${meta.embedder || '—'}${useFallback ? '' : ' · 실제 확장'}` })}`);

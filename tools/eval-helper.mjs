// 새 관심사 도우미 품질 평가(T-226, ADR 0017 에이전트 2 "재는 방법").
// 관심사마다
//   1) 확장과 같은 도우미 상태 머신(helperStep, interest-helper.js)을 Node에서 끝까지 돌린다(mode new, 쓰기는 가짜)
//   2) 같은 관심사로 T-301 한 번 호출 초안(buildDraftPrompt → parseDraft)도 만든다
//   3) --judge(기본 켬)면 생성과 다른 계열 모델(기본 NVIDIA)이 노드마다 사실 그럴듯함·익숙함·태그 적합을 채점한다
//   4) 남은 노드를 검수를 마친 것으로 보고 새 그래프를 만들어, 기존 평가 문장(eval-set·unseen·holdout의 expectTag)으로
//      1위 노드가 expectTag를 가진 비율을 잰다. 검색은 **대체 임베더(글자 n-gram)**다. 실제 모델 수치가 아니다.
// 사용법 (프로젝트 루트에서, 키는 환경변수 <ID>_API_KEY 에서만 읽는다. 값은 출력하지 않는다):
//   npm run eval:helper                               # 기본 관심사 5개, 생성 체인 = admin fallbackChain을 agent.providerOrder로(키 있는 것만), 채점 계열은 뺀다
//   npm run eval:helper -- --interests 축구,커피       # 관심사 고르기
//   npm run eval:helper -- --only helper|oneshot      # 한쪽만
//   npm run eval:helper -- --no-judge                 # 채점 없이
//   npm run eval:helper -- --provider gemini          # 생성 제공자 강제(체인 없음)
//   npm run eval:helper -- --max-calls 120            # 이번 실행 실제 LLM 호출(생성 + 채점, 캐시 제외) 상한. 기본 120
//   npm run eval:helper -- --rpm 10                   # 분당 호출 상한(기본 10)
//   npm run eval:helper -- --fresh                    # 캐시를 쓰지 않고 다시
// 결과: .tmp/eval-helper-<날짜>.json, 캐시: .tmp/eval-helper-cache.json(호출 글 → 답, 프롬프트가 바뀌면 자연히 새로 부른다). 커밋 안 함.
import fs from 'node:fs';
import { loadCommonGraphFromDisk, loadInterestGraph } from './load-graph.mjs';
import { mergeGraphs } from '../extension/lib/graph.js';
import { PROVIDERS, complete } from '../extension/lib/providers.js';
import { buildChain, completeWithFallback, reorderChain } from '../extension/lib/fallback.js';
import { providerFor } from '../extension/lib/config.js';
import { hashEmbed } from '../extension/lib/fallback-embed.js';
import { newHelperState, helperStep, HELPER_LIMITS } from '../extension/lib/interest-helper.js';
import { parseDraft } from '../extension/lib/draft.js';
import { buildDraftPrompt } from '../extension/lib/prompt.js';
import { modelKey } from './eval-gen-lib.mjs';
import { withoutFamily, familyOf } from './eval-followup-lib.mjs';
import {
  DEFAULT_INTERESTS, sha, callKey, helperMetrics, oneShotMetrics, JUDGE_BATCH, buildNodeJudgePrompt, parseNodeJudge, judgeSummary,
  expectTagItems, graphFromDrafts, expectTagRate, rowLine, totals, totalLines
} from './eval-helper-lib.mjs';

const here = new URL('.', import.meta.url);
const readJson = p => JSON.parse(fs.readFileSync(new URL(p, here)));
const admin = readJson('../extension/config/admin.json');
const blockTerms = readJson('../extension/data/common/blocklist.json').terms;
const common = loadCommonGraphFromDisk();
const tags = common.tags;
const items = expectTagItems(readJson('./eval-set.json'), readJson('./eval-unseen.json'), readJson('./eval-holdout.json'));

const argAfter = flag => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : null; };
const has = flag => process.argv.includes(flag);
const doJudge = !has('--no-judge');
const fresh = has('--fresh');
const rpm = Number(argAfter('--rpm')) || 10;
const maxCalls = Number(argAfter('--max-calls')) || 120;
const forced = argAfter('--provider');
const only = argAfter('--only');
const interests = (argAfter('--interests') || DEFAULT_INTERESTS.join(',')).split(',').map(s => s.trim()).filter(Boolean);
const today = new Date().toLocaleDateString('sv-SE');
const outFile = new URL(`../.tmp/eval-helper-${today}.json`, here);
const cacheFile = new URL('../.tmp/eval-helper-cache.json', here);

const envKeys = Object.fromEntries(Object.keys(PROVIDERS).map(id => [id, process.env[`${id.toUpperCase()}_API_KEY`] || '']).filter(([, k]) => k));
const settings = { apiKeys: envKeys };
console.log(`키: ${Object.keys(PROVIDERS).filter(id => !PROVIDERS[id].local && PROVIDERS[id].kind !== 'demo').map(id => `${id} ${envKeys[id] ? '있음' : '없음'}`).join(', ')}`);

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
// 확장 background agentDeps와 같은 체인: buildChain → agent.providerOrder로 자리만 바꿈. 키 없는 것·꺼진 로컬은 빼고, 채점 계열도 뺀다
async function generationChain(judge) {
  const finish = chain => {
    const out = judge ? withoutFamily(chain, judge) : chain;
    if (!out.length) throw new Error(`채점 계열(${familyOf(judge)})을 빼고 나니 생성에 쓸 모델이 없어요.`);
    return out;
  };
  if (forced) {
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
  const ok = new Set(usable.map(p => p.id));
  const chain = buildChain(usable[0], admin, settings).filter(p => ok.has(p.id));
  return finish(reorderChain(chain, admin.agent?.providerOrder));
}

// 호출 간격과 한도 재시도(eval-followup과 같은 방식). waited는 지연 지표에서 뺀다
let lastCall = 0, waited = 0, liveCalls = 0;
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

// 같은 글이면 캐시. 실제 호출만 상한에 센다.
// 같은 글을 한 실행에서 두 번 부르면(평가 답을 못 읽어 다시 묻기) 두 번째는 다른 칸(#1)이라 캐시가 같은 실패를 되풀이하지 않는다
const asked = new Map();
function cachedAsk(chain, used) {
  const ck = chain.map(modelKey).join('>');
  return async (system, user, opts) => {
    const base = callKey(ck, system, user);
    const nth = asked.get(base) || 0;
    asked.set(base, nth + 1);
    const key = nth ? `${base}#${nth}` : base;
    if (cache[key]) { used.add(cache[key].model + ' (캐시)'); return cache[key].text; }
    if (liveCalls >= maxCalls) throw Object.assign(new Error('--max-calls 상한'), { budget: true });
    liveCalls++;
    const r = await withLimitRetry(() => completeWithFallback(chain, system, user, opts, { cooldowns, cooldown: admin.cooldown }));
    cache[key] = { model: modelKey(r.provider), text: r.text };
    saveCache();
    used.add(modelKey(r.provider));
    return r.text;
  };
}

// 관심사마다 같은 id가 나오게(캐시 키에 노드 id가 들어간다) 씨앗 있는 난수
function seeded(str) {
  let a = parseInt(sha(str).slice(0, 8), 16) >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

async function runHelperFor(name, chain) {
  const used = new Set();
  const deps = {
    ask: cachedAsk(chain, used), tags, blockTerms, existing: [], reservedIds: common.nodes.map(n => n.id),
    write: async nodes => ({ written: nodes.length }), rand: seeded(`helper:${name}`), now: () => 0
  };
  let s = newHelperState({ name, mode: 'new', now: 0 });
  const states = [s];
  const t0 = Date.now(), w0 = waited;
  while (s.status === 'running') {
    s = await helperStep(s, deps);
    states.push(s);
    const last = s.log.at(-1);
    if (last) console.log(`    [${last.phase}] ${last.text}`);
  }
  const metrics = helperMetrics(states, { tagCount: tags.length });
  return {
    metrics, ms: Date.now() - t0 - (waited - w0), provider: [...used],
    nodes: s.accepted.map(n => ({ id: n.id, label: n.label, facts: n.facts, tags: n.tags, target: n.target, rewrites: n.rewrites })),
    dropped: s.dropped, absentTags: s.absentTags, log: s.log, error: s.status === 'error' ? s.error : null
  };
}

async function runOneShotFor(name, chain) {
  const used = new Set();
  const ask = cachedAsk(chain, used);
  const { system, user } = buildDraftPrompt({ name, tags });
  const t0 = Date.now(), w0 = waited;
  const text = await ask(system, user, { json: true, maxTokens: 4000 });
  const parsed = parseDraft(text, { tags, existingIds: common.nodes.map(n => n.id), blockTerms, rand: seeded(`oneshot:${name}`) });
  const nodes = parsed.nodes.map(n => ({ id: n.id, label: n.label, facts: n.facts, tags: n.tags }));
  return { metrics: oneShotMetrics(nodes, { tagCount: tags.length }), ms: Date.now() - t0 - (waited - w0), provider: [...used], nodes, dropped: parsed.dropped, error: parsed.error || null };
}

async function judgeRow(row, judge) {
  const jk = modelKey(judge);
  const verdicts = new Map();
  for (let i = 0; i < row.nodes.length; i += JUDGE_BATCH) {
    const batch = row.nodes.slice(i, i + JUDGE_BATCH);
    const { system, user } = buildNodeJudgePrompt({ name: row.interest, nodes: batch, tags });
    const key = callKey(jk, system, user);
    let text = cache[key]?.text;
    if (!text) {
      if (liveCalls >= maxCalls) { row.judgeError = '--max-calls 상한'; break; }
      liveCalls++;
      try { text = await withLimitRetry(() => complete(judge, system, user, { json: true, maxTokens: 6000 })); }
      catch (e) { row.judgeError = String(e.message).slice(0, 160); break; }
    }
    const v = parseNodeJudge(text);
    if (!v) { row.judgeError = '채점 답을 읽지 못했어요: ' + String(text).slice(0, 80); continue; }
    cache[key] = { model: jk, text }; saveCache();
    for (const [id, x] of v) verdicts.set(id, x);
  }
  row.judgeModel = jk;
  row.verdicts = Object.fromEntries([...verdicts].map(([id, v]) => [id, { ...v, tags: Object.fromEntries(v.tags) }]));
  row.judge = judgeSummary(row.nodes, verdicts);
}

const embed = t => hashEmbed(t);
const rows = [];
const save = meta => { fs.mkdirSync(new URL('../.tmp/', here), { recursive: true }); fs.writeFileSync(outFile, JSON.stringify({ date: today, ...meta, rows }, null, 2)); };

const judge = doJudge ? judgeProvider() : null;
const chain = await generationChain(judge);
console.log(`생성 체인(에이전트 순서): ${chain.map(modelKey).join(' → ')}${judge ? ` · 채점: ${modelKey(judge)}` : ''}`);
console.log(`관심사 ${interests.join(', ')} · 호출 상한 ${maxCalls}(캐시 제외) · 분당 ${rpm}회 · expectTag 문장 ${items.length}개(대체 임베더)`);
const methods = only ? [only] : ['helper', 'oneshot'];
const meta = { chain: chain.map(modelKey), judge: judge ? modelKey(judge) : null, embedder: 'fallback-ngram(대체 임베더, 실제 모델 아님)', maxCalls, helperLimits: HELPER_LIMITS };

for (const name of interests) {
  for (const method of methods) {
    const need = method === 'helper' ? HELPER_LIMITS.maxCalls : 1;
    if (liveCalls + need > maxCalls) { console.log(`  호출 상한에 닿을 수 있어 ${name} ${method}는 건너뛰어요(캐시에 있으면 다음에 상한을 늘려 다시)`); continue; }
    console.log(`\n${name} · ${method === 'helper' ? '도우미' : 'T-301 한 번'}`);
    let row;
    try {
      const r = method === 'helper' ? await runHelperFor(name, chain) : await runOneShotFor(name, chain);
      row = { interest: name, method, tagCount: tags.length, ...r };
    } catch (e) {
      row = { interest: name, method, tagCount: tags.length, error: String(e.message).slice(0, 160), metrics: null };
    }
    if (!row.error || row.nodes?.length) {
      row.expect = expectTagRate(graphFromDrafts(common, name, row.nodes), items, { embed, retrieval: admin.retrieval });
      if (judge && row.nodes.length) await judgeRow(row, judge);
    }
    rows.push(row);
    save(meta);
    console.log('  ' + (row.metrics ? rowLine(row) : `오류 ${row.error}`));
  }
}

// 기준선: 같은 대체 임베더로 공통 그래프(메이플·식당)의 expectTag 1위 비율
const baseline = {};
for (const id of ['maplestory', 'restaurant']) {
  const g = mergeGraphs(id === 'maplestory' ? common : loadInterestGraph(id), null);
  const e = expectTagRate(g, items, { embed, retrieval: admin.retrieval });
  baseline[id] = { nodes: g.nodes.length, tags: new Set(g.nodes.flatMap(n => n.tags)).size, hit: e.hit, n: e.n, coveredHit: e.coveredHit, coveredN: e.coveredN };
}
meta.baseline = baseline;
meta.liveCalls = liveCalls;
save(meta);

console.log(`\n결과 저장: ${outFile.pathname}`);
console.log(`이번 실행 실제 LLM 호출 ${liveCalls}회(캐시 제외)`);
for (const r of rows) console.log(r.metrics ? rowLine(r) : `${r.interest} ${r.method}: 오류 ${r.error}`);
console.log('\n합계');
for (const l of totalLines(totals(rows), tags.length)) console.log('  ' + l);
for (const [id, b] of Object.entries(baseline)) console.log(`  기준선 ${id}(노드 ${b.nodes}, 태그 ${b.tags}): expectTag 1위 ${b.hit}/${b.n}(${Math.round(b.hit / b.n * 100)}%), 덮은 태그 안 ${b.coveredHit}/${b.coveredN}(${Math.round(b.coveredHit / b.coveredN * 100)}%)`);
console.log('※ expectTag 1위 비율은 대체 임베더(글자 n-gram) 수치예요. 실제 모델(e5) 결과가 아니에요.');

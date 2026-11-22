#!/usr/bin/env node
// 노드 파이프라인(T-194) 명령줄. 사용법은 같은 폴더 README.md.
//   node tools/node-pipeline/cli.mjs index  --interest maplestory [--pages 1] [--probe-seeds]
//   node tools/node-pipeline/cli.mjs draft  --interest maplestory [--limit 10] [--max-calls 40] [--kind guide,update] [--provider gemini] [--model ...]
//   node tools/node-pipeline/cli.mjs check  --interest maplestory [--batch N] [--no-probe] [--no-reground] [--no-near-dup] [--dup-embedder e5|fallback] [--no-tag-fit] [--max-calls 14] [--provider gemini]
//   node tools/node-pipeline/cli.mjs gate   --interest maplestory --batch N|all [--approve ids.json] [--embedder fallback|browser] [--margin 0.005] [--strict-margin] [--cases-dir 경로] [--explain [--explain-max 30]] [--results 입력.json] [--regate]
//   node tools/node-pipeline/cli.mjs accept-alt <대안 표 .alt-*.json> [--dir tools] [--all]
//   node tools/node-pipeline/cli.mjs explain-alt <대안 표 .alt-*.json> --results <관문 입력.json> [--provider gemini] [--explain-max 30]
//   node tools/node-pipeline/cli.mjs apply  --interest maplestory --batch N|all --approve ids.json [--gate browser|fallback|none] [--out 경로] [--write-real]
// 작업 파일은 모두 .tmp/node-pipeline/(커밋 안 함). 페이지 본문은 어디에도 쓰지 않는다(D-5).
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS, complete as providerComplete } from '../../extension/lib/providers.js';
import { loadInterestGraph, commonGraphPath } from '../load-graph.mjs';
import { interestConfig } from './sources.mjs';
import { politeFetcher } from './web.mjs';
import { buildIndex, pickPages, draftPages, indexKey, probeSeeds, markProbes, regroundLabels } from './run.mjs';
import { resolveCrossBatch, describeGroups } from './dedupe.mjs';
import { checkBatch, sourceProber, renderSheet, summarize } from './check.mjs';
import { buildPatch, applyPatch, today } from './apply.mjs';
import { loadGateCases, memoEmbedder, scoreGraph, gateCandidates, altRows, buildAltExplainPrompt, parseAltExplain, altPendingRefusals, applyAltToText, altTargetFiles, renderAltTable } from './gate.mjs';
import { applyTagFit, BudgetError } from './tag-fit.mjs';
import { applyNearDup, applyTagDensity } from './near-dup.mjs';
import { createHash } from 'node:crypto';
import { hashEmbed } from '../../extension/lib/fallback-embed.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORK = join(ROOT, '.tmp', 'node-pipeline');
const COMMON = join(ROOT, 'extension', 'data', 'common');

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (name, def) => { const i = argv.indexOf('--' + name); return i < 0 ? def : argv[i + 1]; };
const flag = name => argv.includes('--' + name);
const readJson = p => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); };
const log = m => console.log('  ' + m);

const interest = arg('interest', 'maplestory');
const cfg = interestConfig(interest);
const indexPath = join(WORK, `${interest}-index.json`);
const batchFile = (n, ext) => join(WORK, `${interest}-batch-${n}${ext}`);

// 지금까지 있는 묶음 번호(초안 파일 기준)
function batches() {
  if (!existsSync(WORK)) return [];
  const re = new RegExp(`^${interest}-batch-(\\d+)\\.draft\\.json$`);
  return readdirSync(WORK).map(f => f.match(re)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
}
const batchArg = () => Number(arg('batch', batches().at(-1) ?? 0)) || (() => { throw new Error('묶음이 없어요. 먼저 draft를 돌려 주세요.'); })();

const blockTerms = () => readJson(join(COMMON, 'blocklist.json'));

async function cmdIndex() {
  const prev = existsSync(indexPath) ? readJson(indexPath).entries : [];
  const fetcher = politeFetcher({ log });
  console.log(`[index] ${interest}: 목록 ${cfg.listings.length}곳 × ${arg('pages', 1)}쪽 + 씨앗 ${cfg.seeds.length}개 (1초에 1번 이하, robots 준수)`);
  let { entries, listings, failures } = await buildIndex({ cfg, fetcher, pages: Number(arg('pages', 1)), prev, log });
  // 씨앗 확인(T-198): 응답하지 않는 씨앗은 probe.ok=false로 표시(초안 순서 맨 뒤)
  if (flag('probe-seeds')) {
    const probes = await probeSeeds({ cfg, fetcher, log });
    entries = markProbes(entries, probes);
    const dead = probes.filter(p => !p.ok);
    console.log(`[index] 씨앗 확인 ${probes.length}개 · 응답 없음 ${dead.length}${dead.length ? ': ' + dead.map(p => `${p.title || p.url}(${p.body ? '본문 ' + p.body.status : p.status}${p.blocked ? ' robots' : ''})`).join(', ') : ''}`);
  }
  writeJson(indexPath, { interest, updatedAt: new Date().toISOString(), note: 'URL·제목·시각·본문 해시만(D-5, 본문 저장 금지)', entries });
  const byKind = entries.reduce((m, e) => ({ ...m, [e.kind]: (m[e.kind] || 0) + 1 }), {});
  console.log(`[index] 페이지 ${entries.length}개 ${JSON.stringify(byKind)} · 목록 요청 ${listings} · 실패 ${failures.length} · robots 막힘 ${fetcher.stats.robotsBlocked}`);
  console.log(`[index] → ${indexPath}`);
}

// LLM 답 캐시(T-195): 같은 (제공자, 모델, 프롬프트)는 다시 부르지 않는다. 저장하는 것은 LLM 답(우리 문장)뿐, 본문은 해시 키로만(D-5)
// maxCalls(T-197): 상한을 넘는 새 호출은 BudgetError(캐시 적중은 상한과 무관)
function cachedComplete(p, { json = true, maxCalls = Infinity } = {}) {
  const dir = join(WORK, 'cache');
  let calls = 0, hits = 0, lastCall = 0;
  const fn = async (system, user) => {
    const key = createHash('sha256').update([p.id, p.model, system, user].join('\u0000')).digest('hex').slice(0, 32);
    const file = join(dir, `llm-${key}.json`);
    if (existsSync(file)) { hits++; return readJson(file).answer; }
    if (calls >= maxCalls) throw new BudgetError();
    calls++;
    // 분당 한도(T-207): --gap-ms만큼 호출 사이를 띄우고, 429면 --retry-429번까지 기다렸다 다시(하루 한도면 결국 429로 멈춤)
    const gap = Number(arg('gap-ms', 0));
    if (gap && lastCall) await new Promise(r => setTimeout(r, Math.max(0, gap - (Date.now() - lastCall))));
    let answer;
    for (let tries = Number(arg('retry-429', 0)); ; tries--) {
      lastCall = Date.now();
      try { answer = await providerComplete(p, system, user, { json, timeoutMs: 90_000 }); break; }
      catch (e) {
        if (e.status !== 429 || tries <= 0) throw e;
        log('429: 60초 기다렸다 다시 불러요');
        await new Promise(r => setTimeout(r, 60_000));
      }
    }
    writeJson(file, { provider: p.id, model: p.model, at: new Date().toISOString(), answer });
    return answer;
  };
  fn.calls = () => calls;
  fn.hits = () => hits;
  return fn;
}

function provider() {
  const id = arg('provider', 'gemini');
  const def = PROVIDERS[id];
  if (!def || id === 'demo') throw new Error(`알 수 없는 제공자: ${id}`);
  const apiKey = def.keyOptional ? '' : process.env[`${id.toUpperCase()}_API_KEY`] || '';
  if (!apiKey && !def.keyOptional) throw new Error(`${id.toUpperCase()}_API_KEY가 없어요(값은 출력하지 않아요).`);
  return { id, def, model: arg('model', def.defaultModel), apiKey, baseUrl: def.baseUrl };
}

async function cmdDraft() {
  if (!existsSync(indexPath)) throw new Error('색인이 없어요. 먼저 index를 돌려 주세요.');
  const idx = readJson(indexPath);
  const only = arg('kind') ? arg('kind').split(',') : undefined;
  const pages = pickPages(idx.entries, { kindOrder: cfg.kindOrder, limit: Number(arg('limit', 10)), only, pageSkip: cfg.pageSkip || null });
  if (!pages.length) { console.log('[draft] 초안할 새 페이지가 없어요.'); return; }
  const p = provider();
  const graph = loadInterestGraph(interest);
  const fetcher = politeFetcher({ log });
  const complete = cachedComplete(p);
  const maxCalls = Number(arg('max-calls', Infinity));
  console.log(`[draft] ${interest}: 페이지 ${pages.length}개 · ${p.id}/${p.model} · 호출 상한 ${maxCalls}`);
  const { candidates, dropped, pages: report } = await draftPages({ cfg, pages, fetcher, complete, graph, tags: graph.tags, log, maxCalls });
  const calls = complete.calls();
  const n = (batches().at(-1) || 0) + 1;
  writeJson(batchFile(n, '.draft.json'), { interest, batch: n, createdAt: new Date().toISOString(), provider: p.id, model: p.model, llmCalls: calls, cacheHits: complete.hits(), pages: report, candidates, dropped });
  // 색인 갱신: 초안한 페이지에 시각·해시·drafted 표시(본문은 없음)
  const byKey = new Map(report.map(r => [indexKey(r.url), r]));
  idx.entries = idx.entries.map(e => {
    const r = byKey.get(indexKey(e.url));
    // 가져오기 실패·LLM 오류는 다음 실행에 다시 시도한다
    return r && ['ok', 'parse-error', 'short'].includes(r.status) ? { ...e, fetchedAt: r.fetchedAt, hash: r.hash, drafted: n } : e;
  });
  writeJson(indexPath, idx);
  const ok = report.filter(r => r.status === 'ok').length;
  const secs = report.reduce((m, r) => m + (r.sections || 0), 0);
  console.log(`[draft] 후보 ${candidates.length}개(태그 없음으로 버림 ${dropped.length}) / 초안 페이지 ${ok}개 · 절 ${secs}개 (LLM 호출 ${calls}번, 캐시 ${complete.hits()}번) · 페이지 상태 ${JSON.stringify(report.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {}))}`);
  console.log(`[draft] → ${batchFile(n, '.draft.json')}`);
}

async function cmdCheck() {
  const n = batchArg();
  const draft = readJson(batchFile(n, '.draft.json'));
  const graph = loadInterestGraph(interest);
  const fetcher = flag('no-probe') ? null : politeFetcher({ log });
  const probe = fetcher ? sourceProber(fetcher, cfg) : null;
  // 이름 핵심 낱말 신호(T-205): T-205 전 초안의 조문 꼴 후보는 페이지를 다시 가져와 잰다(LLM 없음). --no-probe·--no-reground면 건너뜀
  let candidates = draft.candidates;
  if (fetcher && !flag('no-reground') && cfg.articleHosts?.length) {
    const rg = await regroundLabels({ cfg, candidates, fetcher, log });
    candidates = rg.candidates;
    if (rg.regrounded || rg.failed.length) console.log(`[check] 이름 신호 다시 잼(조문 꼴): 후보 ${rg.regrounded} · 못 가져온 쪽 ${rg.failed.length}`);
  }
  let results = await checkBatch(candidates, { cfg, graph, tags: graph.tags, blockTerms: blockTerms(), probe });
  // 앞 묶음에서 실패 안 한 후보(근접 중복·태그 밀도 비교용, 같은 개념이 다른 묶음에 또 나오는 일이 있다)
  const prior = batches().filter(b => b < n && existsSync(batchFile(b, '.json'))).flatMap(b => readJson(batchFile(b, '.json')).results.filter(r => r.status !== 'fail').map(r => r.node));
  // 근접 중복(T-197, ADR 0015 제안 2): LLM 전에(실패 후보에는 태그 적합성을 묻지 않아 한도를 아낀다)
  let nearDup = null;
  if (!flag('no-near-dup')) {
    const { embed, embedderId } = await nearDupEmbedder(arg('dup-embedder', 'e5'));
    nearDup = await applyNearDup(results, { existing: graph.nodes, prior, embed, embedderId });
    console.log(`[check] 근접 중복(${embedderId}): 바닥 ${nearDup.floor.score} (${nearDup.floor.a}~${nearDup.floor.b}) · 실패 ${nearDup.failed} · 같은 사실 ${nearDup.reused} · 가까움 ${nearDup.close}`);
  }
  // 태그 적합성(T-197): 후보마다 LLM 한 번(캐시). --no-tag-fit이면 건너뜀, 키가 없으면 모두 tagFitPending
  let tagFit = null;
  if (!flag('no-tag-fit')) {
    let p = null;
    try { p = provider(); } catch (e) { console.log(`[check] 태그 적합성 건너뜀: ${e.message}`); }
    const complete = p ? cachedComplete(p, { maxCalls: Number(arg('max-calls', Infinity)) }) : async () => { throw new BudgetError(); };
    const stat = await applyTagFit(results, { complete, tags: graph.tags, model: p?.model || '', log });
    tagFit = { ...stat, model: p?.model || null, calls: p ? complete.calls() : 0, cacheHits: p ? complete.hits() : 0 };
    console.log(`[check] 태그 적합성: 물은 후보 ${stat.asked} · 태그 yes ${stat.yes} · no ${stat.no} · 태그 다 빠져 실패 ${stat.failed} · 못 함 ${stat.pending} (LLM 호출 ${tagFit.calls}번, 캐시 ${tagFit.cacheHits}번)`);
  }
  // 태그 밀도 상한(T-197, ADR 0015 제안 3, 경고만): 태그 적합성으로 태그가 바뀐 뒤에 센다
  const density = applyTagDensity(results, { graphNodes: graph.nodes, prior });
  const dense = density.counts.filter(c => c[2] > density.cap);
  console.log(`[check] 태그 밀도: 상한 ${density.cap}(노드 ${density.total}) · 넘는 태그 ${dense.map(c => `${c[0]} ${c[1]}→${c[2]}`).join(', ') || '없음'}`);
  // 묶음 사이 중복(T-205): 다른 묶음(앞·뒤 모두)에 같은 id·이름이 있으면 하나만 남긴다(dedupe.mjs 판정 순서)
  const others = batches().filter(b => b !== n && existsSync(batchFile(b, '.json'))).map(b => ({ batch: b, results: readJson(batchFile(b, '.json')).results }));
  const cross = resolveCrossBatch([...others, { batch: n, results }]);
  results = cross.batches.at(-1).results;
  const crossBatch = cross.groups.filter(g => g.keep.batch === n || g.drop.some(d => d.batch === n));
  if (crossBatch.length) { console.log(`[check] 묶음 사이 중복 ${crossBatch.length}무리:`); for (const l of describeGroups(crossBatch)) console.log('  ' + l); }
  const sum = summarize(results);
  const pagesOk = draft.pages.filter(p => p.status === 'ok').length;
  writeJson(batchFile(n, '.json'), { interest, batch: n, checkedAt: new Date().toISOString(), graphVersion: graph.version, probed: !!probe, nearDup, density, tagFit, crossBatch, summary: sum, pages: draft.pages, dropped: draft.dropped || [], results });
  writeFileSync(batchFile(n, '.md'), renderSheet({ interest, batch: n, results, pages: pagesOk, generatedAt: new Date().toISOString(), nearDup, density }));
  const nd = (draft.dropped || []).length;
  console.log(`[check] 묶음 ${n}: 후보 ${sum.total} (통과 ${sum.pass} · 확인 ${sum.warn} · 실패 ${sum.fail}) · 초안에서 태그 없음으로 버림 ${nd} · 페이지당 ${(sum.total / Math.max(1, pagesOk)).toFixed(1)}개`);
  for (const [k, c] of sum.reasons.slice(0, 8)) console.log(`  ${k} ${c}`);
  console.log(`[check] → ${batchFile(n, '.md')}`);
}

// 근접 중복용 임베더(T-197). e5 = Node에서 admin.embedding 모델(한 문장씩, passage 접두어), 벡터는 .tmp 캐시(우리 문장만).
// 모델을 못 불러오면 대체 임베더로 같은 규칙(바닥도 같은 임베더로 잰다). 미리 계산 벡터(크롬)와는 섞지 않는다(near-dup.mjs 머리말)
async function nearDupEmbedder(kind) {
  const fallback = { embed: async texts => texts.map(t => hashEmbed(t)), embedderId: 'fallback-ngram' };
  if (kind === 'fallback') return fallback;
  const admin = readJson(join(ROOT, 'extension', 'config', 'admin.json'));
  const cfg = admin.embedding;
  try {
    const { pipeline } = await import('@huggingface/transformers');
    const { embedEach } = await import('../../extension/lib/embed-each.js');
    const ex = await pipeline('feature-extraction', cfg.model, { dtype: cfg.dtype });
    const run = async t => (await ex(t, { pooling: 'mean', normalize: true })).tolist();
    const embedderId = `${cfg.model}@${cfg.dtype}-node`;
    const cacheFile = join(WORK, 'cache', `vec-${createHash('sha1').update(embedderId).digest('hex').slice(0, 12)}.json`);
    const cache = existsSync(cacheFile) ? readJson(cacheFile) : {};
    const embed = async texts => {
      const key = t => createHash('sha1').update(t).digest('hex');
      const need = [...new Set(texts.filter(t => !cache[key(t)]))];
      if (need.length) {
        const vs = await embedEach(need.map(t => (cfg.passagePrefix || '') + t), run);
        need.forEach((t, i) => { cache[key(t)] = vs[i]; });
        writeJson(cacheFile, cache);
      }
      return texts.map(t => cache[key(t)]);
    };
    return { embed, embedderId };
  } catch (e) {
    console.log(`[check] e5 모델을 못 불러와 대체 임베더로 근접 중복을 재요: ${String(e.message || e).slice(0, 80)}`);
    return fallback;
  }
}

// 묶음 번호 또는 all(그 관심사 묶음을 모두 합침) → 검사 결과
const batchSel = () => (arg('batch') === 'all' ? 'all' : batchArg());
// all이면 묶음 사이 중복(T-205)을 다시 판정해 남길 후보 하나만 실패 아닌 채로 둔다(묶음마다 따로 check한 결과가 겹칠 수 있다)
function loadResults(n) {
  if (n !== 'all') return readJson(batchFile(n, '.json')).results;
  const all = batches().filter(b => existsSync(batchFile(b, '.json'))).map(b => ({ batch: b, results: readJson(batchFile(b, '.json')).results }));
  const { batches: out, groups } = resolveCrossBatch(all);
  if (groups.length) { console.log(`  묶음 사이 중복 ${groups.length}무리(하나만 남김):`); for (const l of describeGroups(groups)) console.log('    ' + l); }
  return out.flatMap(b => b.results);
}

async function cmdApply() {
  const n = batchSel();
  const approvePath = arg('approve');
  if (!approvePath) throw new Error('--approve <승인 id 목록 JSON>이 필요해요.');
  const approved = readJson(approvePath);
  if (!Array.isArray(approved)) throw new Error('승인 파일은 id 문자열 배열이어야 해요.');
  const checked = { results: loadResults(n) };
  const day = arg('day', today());
  // 회귀 관문 통과분만(기본 = 실제 확장 판정 browser). --gate fallback은 사본 시연용, none은 관문 없이(실제 그래프에는 못 씀)
  const gate = arg('gate', 'browser');
  let gated = approved;
  if (gate !== 'none') {
    const gp = batchFile(n, `.accepted-${gate}.json`);
    if (!existsSync(gp)) throw new Error(`관문 결과가 없어요: ${gp} (먼저 gate --embedder ${gate})`);
    const ok = new Set(readJson(gp));
    gated = approved.filter(id => ok.has(id));
    for (const id of approved.filter(id => !ok.has(id))) console.log(`  관문 미통과라 뺌 ${id}`);
    // 대안 정답 후보가 남은 노드는 accept-alt로 expectNodes에 더한 뒤에만(T-195)
    const gr = batchFile(n, `.gate-${gate}.json`);
    if (existsSync(gr)) {
      const pending = altPendingRefusals(readJson(gr), loadGateCases(interest, casesIo()));
      for (const [id, ss] of pending) if (gated.includes(id)) console.log(`  대안 정답 미승인이라 뺌 ${id} (${ss.length}문장, accept-alt 먼저)`);
      gated = gated.filter(id => !pending.has(id));
    }
  }
  if (flag('write-real') && gate !== 'browser') throw new Error('실제 그래프에는 실제 확장 관문(--gate browser)을 통과한 노드만 써요.');
  const patch = buildPatch(checked.results, gated, { rules: cfg.rules, day });
  writeJson(batchFile(n, '.patch.json'), { interest, batch: n, createdAt: new Date().toISOString(), verifiedAt: day, ...patch });
  const realPath = commonGraphPath(interest);
  // 기본은 사본: --graph(입력)와 --out(출력)을 안 주면 실제 그래프를 읽어 .tmp에 결과를 쓴다
  const src = arg('graph', realPath);
  const out = flag('write-real') ? realPath : resolve(arg('out', join(WORK, `${interest}.patched.json`)));
  if (out === realPath && !flag('write-real')) throw new Error('실제 그래프에 쓰려면 --write-real이 필요해요.');
  const raw = readJson(src);
  const tagsFile = readJson(join(COMMON, 'tags.json'));
  const { graph, added, skippedEdges, errors } = applyPatch(raw, patch, { tagsFile, day });
  if (errors.length) { console.error('[apply] 검증 실패, 쓰지 않았어요:\n  ' + errors.join('\n  ')); process.exitCode = 1; return; }
  writeJson(out, graph);
  console.log(`[apply] 노드 +${added.nodes} · 엣지 +${added.edges} (뺀 엣지 ${skippedEdges.length}) · 거절 ${patch.refused.length} · 판본 ${raw.version} → ${graph.version}`);
  for (const r of patch.refused) console.log(`  거절 ${r.id}: ${r.reason}`);
  console.log(`[apply] 패치 → ${batchFile(n, '.patch.json')}`);
  console.log(`[apply] 그래프 → ${out}`);
}

// --cases-dir: 평가 파일을 tools/ 대신 다른 폴더(예: accept-alt를 시연한 .tmp 사본)에서 읽는다
function casesIo() {
  const dir = arg('cases-dir');
  if (!dir) return {};
  const base = resolve(dir);
  return { read: f => readJson(join(base, f)), exists: f => existsSync(join(base, f)) };
}

// 회귀 관문: 승인 후보(없으면 실패 아닌 후보 전부)를 그래프 사본에 넣어 1위 회귀 0·여유 악화 0인 것만 채택 목록으로.
// --batch all이면 그 관심사 묶음을 모두 합쳐 잰다(결과 파일 이름은 batch-all)
async function cmdGate() {
  // --results(T-196): .tmp 묶음 대신 커밋한 최소 입력(tools/node-pipeline/batches/*.json, { interest, results: [{ status, node, edges }] })에서 읽는다.
  // CI(eval 워크플로 gate_args)에서 .tmp 없이 실제 확장 관문을 돌리려고. 결과 파일 이름은 --batch(기본 all)
  const resultsFile = arg('results');
  const n = resultsFile ? arg('batch', 'all') : batchSel();
  const results = resultsFile ? gateInputResults(readJson(resultsFile)) : loadResults(n);
  const embedderId = arg('embedder', 'fallback');
  const ids = arg('approve') ? readJson(arg('approve')) : results.filter(r => r.status !== 'fail').map(r => r.node.id);
  const day = arg('day', today());
  const patch = buildPatch(results, ids, { rules: cfg.rules, day });
  for (const r of patch.refused) console.log(`  거절 ${r.id}: ${r.reason}`);
  let rawGraph = readJson(arg('graph', commonGraphPath(interest)));
  // --regate(T-196): 이미 그래프에 넣은 후보를 다시 잰다. 그래프에서 후보 노드(와 닿는 엣지)를 빼고 기준을 잰 뒤 다시 넣는다.
  // accept-alt로 expectNodes가 바뀐 뒤, 앞 관문에서 다른 후보에 가려 안 보였던 2위 침범을 찾으려고
  if (flag('regate')) rawGraph = withoutNodes(rawGraph, patch.nodes.map(x => x.id));
  const tagsFile = readJson(join(COMMON, 'tags.json'));
  const admin = readJson(join(ROOT, 'extension', 'config', 'admin.json'));
  const cases = loadGateCases(interest, casesIo());
  let embed, close = async () => {};
  if (embedderId === 'fallback') embed = async texts => texts.map(t => hashEmbed(t));
  else if (embedderId === 'browser') {
    const { openBrowserEmbedder } = await import('../browser-embedder.mjs');
    console.log('[gate] 실제 확장(크롬) 임베더 준비 중(첫 실행은 모델 다운로드)');
    const be = await openBrowserEmbedder();
    embed = be.embed; close = be.close;
  } else throw new Error(`--embedder는 fallback 또는 browser예요: ${embedderId}`);
  const embedder = memoEmbedder(embed);
  console.log(`[gate] ${interest} 묶음 ${n}: 후보 ${patch.nodes.length}개 · 문장 ${cases.length}개(가드 ${cases.filter(c => c.guarded).length}) · ${embedderId}${arg('cases-dir') ? ' · 평가 파일 ' + arg('cases-dir') : ''}`);
  let res;
  try {
    res = await gateCandidates({
      rawGraph, nodes: patch.nodes, cases, log,
      evaluate: raw => scoreGraph(raw, { tagsFile, cases, admin, embedder }),
      threshold: Number(arg('margin', 0.005)), strictGuard: flag('strict-margin'),
      // T-195 판정 (2): 비유 없음 침범은 대체 임베더 잡음이 커서 실제 확장 관문에서만 회귀로 판정
      deferNoMatch: embedderId !== 'browser'
    });
  } finally { await close(); }
  // 대안 정답 후보 표(회귀 아님, 메인 확인). --explain이면 LLM이 이유 칸을 한 번 더 채운다(캐시)
  const rows = altRows(res.alternatives, { interest, nodes: patch.nodes, cases, tags: tagsFile.tags || [] });
  if (flag('explain') && rows.length) {
    const p = provider();
    // --explain-max = 이번 실행 새 호출 상한(T-197: 캐시 적중은 세지 않음, 전에는 줄 수였다)
    const complete = cachedComplete(p, { maxCalls: Number(arg('explain-max', 30)) });
    for (const r of rows) {
      const node = patch.nodes.find(x => x.id === r.newNode);
      const { system, user } = buildAltExplainPrompt({ sentence: r.sentence, expectTag: r.expectTag, tag: (tagsFile.tags || []).find(t => t.id === r.expectTag), node });
      try { const v = parseAltExplain(await complete(system, user)); if (v) r.llm = { ...v, model: p.model }; }
      catch (e) { if (e.budget) break; console.log(`  이유 LLM 실패: ${String(e.message || e).slice(0, 80)}`); if (e.status === 429) break; }
    }
    console.log(`[gate] 대안 이유 LLM 호출 ${complete.calls()}번(캐시 ${complete.hits()}번)`);
  }
  const out = batchFile(n, `.gate-${embedderId}.json`);
  writeJson(out, { interest, batch: n, embedder: embedderId, gatedAt: new Date().toISOString(), graphVersion: rawGraph.version, cases: cases.length, ...res, embedStats: embedder.stats() });
  const acceptedPath = batchFile(n, `.accepted-${embedderId}.json`);
  writeJson(acceptedPath, res.accepted);
  const altPath = batchFile(n, `.alt-${embedderId}.json`);
  writeJson(altPath, { interest, batch: n, embedder: embedderId, note: '대안 정답 후보(회귀 아님). 메인이 줄마다 확인해 approve를 true로 바꾸고 npm run node-pipeline:accept-alt -- <이 파일>', rows });
  writeFileSync(altPath.replace(/\.json$/, '.md'), renderAltTable(rows, { interest, batch: n, embedderId }));
  const kinds = res.rejected.flatMap(r => r.issues.map(i => i.kind)).reduce((m, k) => ({ ...m, [k]: (m[k] || 0) + 1 }), {});
  if (res.deferred.length) console.log(`[gate] 비유 없음 침범 ${res.deferred.length}줄(노드 ${res.deferredIds.length}개)은 실제 관문에서 판정: ${res.deferredIds.join(', ')}`);
  console.log(`[gate] 채택 ${res.accepted.length}(그중 대안 정답 확인 필요 ${res.altPending.length}, 실제 관문에서 판정 ${res.deferredIds.length}) · 뺌 ${res.rejected.length} (혼자 ${res.rejected.filter(r => r.stage === 'solo').length} · 함께 ${res.rejected.filter(r => r.stage === 'joint').length}) · 뺀 사유 문장 ${JSON.stringify(kinds)} · 대안 정답 후보 ${rows.length}줄(2위 ${rows.filter(r => r.via === 'margin').length}) · 평가 ${res.evaluations}번`);
  for (const r of res.rejected) console.log(`  뺌 ${r.id}: ${r.issues.slice(0, 2).map(i => `${i.kind} "${i.sentence.slice(0, 24)}…" ${i.before ?? ''}→${i.after ?? ''}`).join(' / ')}`);
  console.log(`[gate] 채택 목록 → ${acceptedPath}${embedderId === 'fallback' ? ' (다음: --embedder browser --approve 이 파일)' : ' (다음: apply --approve 이 파일)'}`);
  console.log(`[gate] 대안 정답 후보 표 → ${altPath.replace(/\.json$/, '.md')}`);
}

// 그래프에서 노드와 그 노드에 닿는 엣지를 뺀 사본
function withoutNodes(graph, ids) {
  const drop = new Set(ids);
  return { ...graph, nodes: graph.nodes.filter(x => !drop.has(x.id)), edges: (graph.edges || []).filter(e => !drop.has(e.from) && !drop.has(e.to)) };
}

// 최소 입력 → 검사 결과 꼴. 관심사가 다르면 멈춘다(엉뚱한 그래프에 넣지 않게)
function gateInputResults(input) {
  if (input.interest && input.interest !== interest) throw new Error(`입력 관심사(${input.interest})와 --interest(${interest})가 달라요.`);
  if (!Array.isArray(input.results)) throw new Error('입력에 results 배열이 없어요.');
  return input.results.map(r => ({ status: r.status || 'warn', fails: r.fails || [], node: r.node, edges: r.edges || [] }));
}

// 승인한 대안 정답을 평가 파일 expectNodes에 더한다(두 관심사 파일 모두 본다). --dir로 사본 폴더, --all이면 approve 무시하고 모두(시연용)
async function cmdAcceptAlt() {
  const file = argv[1] && !argv[1].startsWith('--') ? argv[1] : arg('file');
  if (!file) throw new Error('사용법: accept-alt <대안 표 .alt-*.json> [--dir tools] [--all]');
  const table = readJson(file);
  const rows = (table.rows || []).filter(r => flag('all') || r.approve === true);
  if (!rows.length) { console.log('[accept-alt] approve가 true인 줄이 없어요.'); return; }
  const dir = resolve(arg('dir', join(ROOT, 'tools')));
  const done = new Set();
  for (const [f, fileInterest] of altTargetFiles()) {
    const p = join(dir, f);
    const mine = rows.filter(r => (r.interest || table.interest) === fileInterest);
    if (!mine.length || !existsSync(p)) continue;
    const { text, changed } = applyAltToText(readFileSync(p, 'utf8'), mine);
    if (!changed.length) continue;
    writeFileSync(p, text);
    for (const c of changed) { done.add(c.sentence + '\u0000' + c.node); console.log(`  ${f}: "${c.sentence.slice(0, 30)}…" + ${c.node}`); }
  }
  const missing = rows.filter(r => !done.has(r.sentence + '\u0000' + r.newNode));
  console.log(`[accept-alt] 반영 ${rows.length - missing.length}/${rows.length}줄 → ${dir}`);
  for (const r of missing) console.log(`  반영 안 됨(이미 있거나 문장을 못 찾음): "${r.sentence.slice(0, 30)}…" ${r.newNode}`);
}

// 대안 표에 LLM 이유 칸만 채운다(T-207): CI 실제 관문(gate_args)은 키가 없어 --explain을 못 하니, 받은 .alt-browser.json에 나중에 붙인다.
// 노드 사실은 같은 관문 입력(--results)에서 읽고, 표 .json·.md를 그 자리에서 다시 쓴다(approve 칸은 그대로)
async function cmdExplainAlt() {
  const file = argv[1] && !argv[1].startsWith('--') ? argv[1] : arg('file');
  if (!file || !arg('results')) throw new Error('사용법: explain-alt <대안 표 .alt-*.json> --results <관문 입력.json> [--provider gemini] [--model ...] [--explain-max 30]');
  const table = readJson(file);
  const nodes = gateInputResults(readJson(arg('results'))).map(r => r.node);
  const tags = readJson(join(COMMON, 'tags.json')).tags || [];
  const p = provider();
  const complete = cachedComplete(p, { maxCalls: Number(arg('explain-max', 30)) });
  for (const r of table.rows || []) {
    const node = nodes.find(x => x.id === r.newNode);
    if (!node) { console.log(`  입력에 없는 노드: ${r.newNode}`); continue; }
    const { system, user } = buildAltExplainPrompt({ sentence: r.sentence, expectTag: r.expectTag, tag: tags.find(t => t.id === r.expectTag), node });
    try { const v = parseAltExplain(await complete(system, user)); if (v) r.llm = { ...v, model: p.model }; }
    catch (e) { if (e.budget) break; console.log(`  이유 LLM 실패: ${String(e.message || e).slice(0, 80)}`); if (e.status === 429) break; }
  }
  writeJson(file, table);
  writeFileSync(file.replace(/\.json$/, '.md'), renderAltTable(table.rows || [], { interest: table.interest, batch: table.batch, embedderId: table.embedder }));
  console.log(`[explain-alt] ${(table.rows || []).filter(r => r.llm).length}/${(table.rows || []).length}줄 · LLM 호출 ${complete.calls()}번(캐시 ${complete.hits()}번) → ${file}`);
}

const CMDS = { index: cmdIndex, draft: cmdDraft, check: cmdCheck, gate: cmdGate, apply: cmdApply, 'accept-alt': cmdAcceptAlt, 'explain-alt': cmdExplainAlt };
if (!CMDS[cmd]) {
  console.error('사용법: node tools/node-pipeline/cli.mjs <index|draft|check|gate|apply|accept-alt|explain-alt> --interest <maplestory|restaurant> ... (README.md)');
  process.exit(2);
}
CMDS[cmd]().catch(e => { console.error(`[${cmd}] ${e.message}`); process.exit(1); });

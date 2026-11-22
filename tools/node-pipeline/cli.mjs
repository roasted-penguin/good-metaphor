#!/usr/bin/env node
// 노드 파이프라인(T-194) 명령줄. 사용법은 같은 폴더 README.md.
//   node tools/node-pipeline/cli.mjs index  --interest maplestory [--pages 1] [--probe-seeds]
//   node tools/node-pipeline/cli.mjs draft  --interest maplestory [--limit 10] [--max-calls 40] [--kind guide,update] [--provider gemini] [--model ...]
//   node tools/node-pipeline/cli.mjs check  --interest maplestory [--batch N] [--no-probe] [--no-tag-fit] [--max-calls 14] [--provider gemini]
//   node tools/node-pipeline/cli.mjs gate   --interest maplestory --batch N|all [--approve ids.json] [--embedder fallback|browser] [--margin 0.005] [--strict-margin] [--cases-dir 경로] [--explain [--explain-max 30]]
//   node tools/node-pipeline/cli.mjs accept-alt <대안 표 .alt-*.json> [--dir tools] [--all]
//   node tools/node-pipeline/cli.mjs apply  --interest maplestory --batch N|all --approve ids.json [--gate browser|fallback|none] [--out 경로] [--write-real]
// 작업 파일은 모두 .tmp/node-pipeline/(커밋 안 함). 페이지 본문은 어디에도 쓰지 않는다(D-5).
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS, complete as providerComplete } from '../../extension/lib/providers.js';
import { loadInterestGraph, commonGraphPath } from '../load-graph.mjs';
import { interestConfig } from './sources.mjs';
import { politeFetcher } from './web.mjs';
import { buildIndex, pickPages, draftPages, indexKey, probeSeeds, markProbes } from './run.mjs';
import { checkBatch, sourceProber, renderSheet, summarize } from './check.mjs';
import { buildPatch, applyPatch, today } from './apply.mjs';
import { loadGateCases, memoEmbedder, scoreGraph, gateCandidates, altRows, buildAltExplainPrompt, parseAltExplain, altPendingRefusals, applyAltToText, altTargetFiles, renderAltTable } from './gate.mjs';
import { applyTagFit, BudgetError } from './tag-fit.mjs';
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
  let calls = 0, hits = 0;
  const fn = async (system, user) => {
    const key = createHash('sha256').update([p.id, p.model, system, user].join('\u0000')).digest('hex').slice(0, 32);
    const file = join(dir, `llm-${key}.json`);
    if (existsSync(file)) { hits++; return readJson(file).answer; }
    if (calls >= maxCalls) throw new BudgetError();
    calls++;
    const answer = await providerComplete(p, system, user, { json, timeoutMs: 90_000 });
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
  const probe = flag('no-probe') ? null : sourceProber(politeFetcher({ log }), cfg.allowHost);
  const results = await checkBatch(draft.candidates, { cfg, graph, tags: graph.tags, blockTerms: blockTerms(), probe });
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
  const sum = summarize(results);
  const pagesOk = draft.pages.filter(p => p.status === 'ok').length;
  writeJson(batchFile(n, '.json'), { interest, batch: n, checkedAt: new Date().toISOString(), graphVersion: graph.version, probed: !!probe, tagFit, summary: sum, pages: draft.pages, dropped: draft.dropped || [], results });
  writeFileSync(batchFile(n, '.md'), renderSheet({ interest, batch: n, results, pages: pagesOk, generatedAt: new Date().toISOString() }));
  const nd = (draft.dropped || []).length;
  console.log(`[check] 묶음 ${n}: 후보 ${sum.total} (통과 ${sum.pass} · 확인 ${sum.warn} · 실패 ${sum.fail}) · 초안에서 태그 없음으로 버림 ${nd} · 페이지당 ${(sum.total / Math.max(1, pagesOk)).toFixed(1)}개`);
  for (const [k, c] of sum.reasons.slice(0, 8)) console.log(`  ${k} ${c}`);
  console.log(`[check] → ${batchFile(n, '.md')}`);
}

// 묶음 번호 또는 all(그 관심사 묶음을 모두 합침) → 검사 결과
const batchSel = () => (arg('batch') === 'all' ? 'all' : batchArg());
const loadResults = n => (n === 'all'
  ? batches().filter(b => existsSync(batchFile(b, '.json'))).flatMap(b => readJson(batchFile(b, '.json')).results)
  : readJson(batchFile(n, '.json')).results);

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
  const n = batchSel();
  const results = loadResults(n);
  const embedderId = arg('embedder', 'fallback');
  const ids = arg('approve') ? readJson(arg('approve')) : results.filter(r => r.status !== 'fail').map(r => r.node.id);
  const day = arg('day', today());
  const patch = buildPatch(results, ids, { rules: cfg.rules, day });
  for (const r of patch.refused) console.log(`  거절 ${r.id}: ${r.reason}`);
  const rawGraph = readJson(arg('graph', commonGraphPath(interest)));
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

const CMDS = { index: cmdIndex, draft: cmdDraft, check: cmdCheck, gate: cmdGate, apply: cmdApply, 'accept-alt': cmdAcceptAlt };
if (!CMDS[cmd]) {
  console.error('사용법: node tools/node-pipeline/cli.mjs <index|draft|check|gate|apply|accept-alt> --interest <maplestory|restaurant> ... (README.md)');
  process.exit(2);
}
CMDS[cmd]().catch(e => { console.error(`[${cmd}] ${e.message}`); process.exit(1); });

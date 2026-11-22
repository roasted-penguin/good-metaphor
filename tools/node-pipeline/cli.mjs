#!/usr/bin/env node
// 노드 파이프라인(T-194) 명령줄. 사용법은 같은 폴더 README.md.
//   node tools/node-pipeline/cli.mjs index  --interest maplestory [--pages 1]
//   node tools/node-pipeline/cli.mjs draft  --interest maplestory [--limit 10] [--kind guide,update] [--provider gemini] [--model ...]
//   node tools/node-pipeline/cli.mjs check  --interest maplestory [--batch N] [--no-probe]
//   node tools/node-pipeline/cli.mjs gate   --interest maplestory --batch N [--approve ids.json] [--embedder fallback|browser] [--margin 0.005] [--strict-margin]
//   node tools/node-pipeline/cli.mjs apply  --interest maplestory --batch N --approve ids.json [--gate browser|fallback|none] [--out 경로] [--write-real]
// 작업 파일은 모두 .tmp/node-pipeline/(커밋 안 함). 페이지 본문은 어디에도 쓰지 않는다(D-5).
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS, complete as providerComplete } from '../../extension/lib/providers.js';
import { loadInterestGraph, commonGraphPath } from '../load-graph.mjs';
import { interestConfig } from './sources.mjs';
import { politeFetcher } from './web.mjs';
import { buildIndex, pickPages, draftPages, indexKey } from './run.mjs';
import { checkBatch, sourceProber, renderSheet, summarize } from './check.mjs';
import { buildPatch, applyPatch, today } from './apply.mjs';
import { loadGateCases, memoEmbedder, scoreGraph, gateCandidates } from './gate.mjs';
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
  const { entries, listings, failures } = await buildIndex({ cfg, fetcher, pages: Number(arg('pages', 1)), prev, log });
  writeJson(indexPath, { interest, updatedAt: new Date().toISOString(), note: 'URL·제목·시각·본문 해시만(D-5, 본문 저장 금지)', entries });
  const byKind = entries.reduce((m, e) => ({ ...m, [e.kind]: (m[e.kind] || 0) + 1 }), {});
  console.log(`[index] 페이지 ${entries.length}개 ${JSON.stringify(byKind)} · 목록 요청 ${listings} · 실패 ${failures.length} · robots 막힘 ${fetcher.stats.robotsBlocked}`);
  console.log(`[index] → ${indexPath}`);
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
  const pages = pickPages(idx.entries, { kindOrder: cfg.kindOrder, limit: Number(arg('limit', 10)), only });
  if (!pages.length) { console.log('[draft] 초안할 새 페이지가 없어요.'); return; }
  const p = provider();
  const graph = loadInterestGraph(interest);
  const fetcher = politeFetcher({ log });
  let calls = 0;
  const complete = (system, user) => { calls++; return providerComplete(p, system, user, { json: true, timeoutMs: 90_000 }); };
  console.log(`[draft] ${interest}: 페이지 ${pages.length}개 · ${p.id}/${p.model}`);
  const { candidates, pages: report } = await draftPages({ cfg, pages, fetcher, complete, graph, tags: graph.tags, log });
  const n = (batches().at(-1) || 0) + 1;
  writeJson(batchFile(n, '.draft.json'), { interest, batch: n, createdAt: new Date().toISOString(), provider: p.id, model: p.model, llmCalls: calls, pages: report, candidates });
  // 색인 갱신: 초안한 페이지에 시각·해시·drafted 표시(본문은 없음)
  const byKey = new Map(report.map(r => [indexKey(r.url), r]));
  idx.entries = idx.entries.map(e => {
    const r = byKey.get(indexKey(e.url));
    // 가져오기 실패·LLM 오류는 다음 실행에 다시 시도한다
    return r && ['ok', 'parse-error', 'short'].includes(r.status) ? { ...e, fetchedAt: r.fetchedAt, hash: r.hash, drafted: n } : e;
  });
  writeJson(indexPath, idx);
  const ok = report.filter(r => r.status === 'ok').length;
  console.log(`[draft] 후보 ${candidates.length}개 / 초안 페이지 ${ok}개 (LLM 호출 ${calls}번) · 페이지 상태 ${JSON.stringify(report.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {}))}`);
  console.log(`[draft] → ${batchFile(n, '.draft.json')}`);
}

async function cmdCheck() {
  const n = batchArg();
  const draft = readJson(batchFile(n, '.draft.json'));
  const graph = loadInterestGraph(interest);
  const probe = flag('no-probe') ? null : sourceProber(politeFetcher({ log }), cfg.allowHost);
  const results = await checkBatch(draft.candidates, { cfg, graph, tags: graph.tags, blockTerms: blockTerms(), probe });
  const sum = summarize(results);
  const pagesOk = draft.pages.filter(p => p.status === 'ok').length;
  writeJson(batchFile(n, '.json'), { interest, batch: n, checkedAt: new Date().toISOString(), graphVersion: graph.version, probed: !!probe, summary: sum, pages: draft.pages, results });
  writeFileSync(batchFile(n, '.md'), renderSheet({ interest, batch: n, results, pages: pagesOk, generatedAt: new Date().toISOString() }));
  console.log(`[check] 묶음 ${n}: 후보 ${sum.total} (통과 ${sum.pass} · 확인 ${sum.warn} · 실패 ${sum.fail}) · 페이지당 ${(sum.total / Math.max(1, pagesOk)).toFixed(1)}개`);
  for (const [k, c] of sum.reasons.slice(0, 8)) console.log(`  ${k} ${c}`);
  console.log(`[check] → ${batchFile(n, '.md')}`);
}

async function cmdApply() {
  const n = batchArg();
  const approvePath = arg('approve');
  if (!approvePath) throw new Error('--approve <승인 id 목록 JSON>이 필요해요.');
  const approved = readJson(approvePath);
  if (!Array.isArray(approved)) throw new Error('승인 파일은 id 문자열 배열이어야 해요.');
  const checked = readJson(batchFile(n, '.json'));
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

// 회귀 관문: 승인 후보(없으면 실패 아닌 후보 전부)를 그래프 사본에 넣어 1위 회귀 0·여유 악화 0인 것만 채택 목록으로
async function cmdGate() {
  const n = batchArg();
  const checked = readJson(batchFile(n, '.json'));
  const embedderId = arg('embedder', 'fallback');
  const ids = arg('approve') ? readJson(arg('approve')) : checked.results.filter(r => r.status !== 'fail').map(r => r.node.id);
  const day = arg('day', today());
  const patch = buildPatch(checked.results, ids, { rules: cfg.rules, day });
  for (const r of patch.refused) console.log(`  거절 ${r.id}: ${r.reason}`);
  const rawGraph = readJson(arg('graph', commonGraphPath(interest)));
  const tagsFile = readJson(join(COMMON, 'tags.json'));
  const admin = readJson(join(ROOT, 'extension', 'config', 'admin.json'));
  const cases = loadGateCases(interest);
  let embed, close = async () => {};
  if (embedderId === 'fallback') embed = async texts => texts.map(t => hashEmbed(t));
  else if (embedderId === 'browser') {
    const { openBrowserEmbedder } = await import('../browser-embedder.mjs');
    console.log('[gate] 실제 확장(크롬) 임베더 준비 중(첫 실행은 모델 다운로드)');
    const be = await openBrowserEmbedder();
    embed = be.embed; close = be.close;
  } else throw new Error(`--embedder는 fallback 또는 browser예요: ${embedderId}`);
  const embedder = memoEmbedder(embed);
  console.log(`[gate] ${interest} 묶음 ${n}: 후보 ${patch.nodes.length}개 · 문장 ${cases.length}개(가드 ${cases.filter(c => c.guarded).length}) · ${embedderId}`);
  let res;
  try {
    res = await gateCandidates({
      rawGraph, nodes: patch.nodes, cases, log,
      evaluate: raw => scoreGraph(raw, { tagsFile, cases, admin, embedder }),
      threshold: Number(arg('margin', 0.005)), strictGuard: flag('strict-margin')
    });
  } finally { await close(); }
  const out = batchFile(n, `.gate-${embedderId}.json`);
  writeJson(out, { interest, batch: n, embedder: embedderId, gatedAt: new Date().toISOString(), graphVersion: rawGraph.version, cases: cases.length, ...res, embedStats: embedder.stats() });
  const acceptedPath = batchFile(n, `.accepted-${embedderId}.json`);
  writeJson(acceptedPath, res.accepted);
  console.log(`[gate] 채택 ${res.accepted.length} · 뺌 ${res.rejected.length} (혼자 ${res.rejected.filter(r => r.stage === 'solo').length} · 함께 ${res.rejected.filter(r => r.stage === 'joint').length}) · 평가 ${res.evaluations}번`);
  for (const r of res.rejected) console.log(`  뺌 ${r.id}: ${r.issues.slice(0, 2).map(i => `${i.kind} "${i.sentence.slice(0, 24)}…" ${i.before ?? ''}→${i.after ?? ''}`).join(' / ')}`);
  console.log(`[gate] 채택 목록 → ${acceptedPath}${embedderId === 'fallback' ? ' (다음: --embedder browser --approve 이 파일)' : ' (다음: apply --approve 이 파일)'}`);
}

const CMDS = { index: cmdIndex, draft: cmdDraft, check: cmdCheck, gate: cmdGate, apply: cmdApply };
if (!CMDS[cmd]) {
  console.error('사용법: node tools/node-pipeline/cli.mjs <index|draft|check|gate|apply> --interest <maplestory|restaurant> ... (README.md)');
  process.exit(2);
}
CMDS[cmd]().catch(e => { console.error(`[${cmd}] ${e.message}`); process.exit(1); });

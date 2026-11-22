// T-194 반자동 노드 파이프라인 흐름: index·draft(가짜 fetch·LLM), 회귀 관문(gate), 패치(apply)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildIndex, pickPages, draftPages, indexKey } from '../../tools/node-pipeline/run.mjs';
import { compareScores, gateCandidates, mergeCases, loadGateCases, memoEmbedder, scoreGraph } from '../../tools/node-pipeline/gate.mjs';
import { bumpVersion, buildPatch, applyPatch, today } from '../../tools/node-pipeline/apply.mjs';
import { INTERESTS } from '../../tools/node-pipeline/sources.mjs';
import { hashEmbed } from '../../extension/lib/fallback-embed.js';
import { loadInterestGraph, commonGraphPath } from '../../tools/load-graph.mjs';

const maple = INTERESTS.maplestory;
const readJson = p => JSON.parse(readFileSync(p, 'utf8'));
const tagsFile = readJson(new URL('../../extension/data/common/tags.json', import.meta.url));
const admin = readJson(new URL('../../extension/config/admin.json', import.meta.url));

/* ───── index ───── */

test('buildIndex: 목록 링크 중 패턴·제목 거름에 맞는 것만, ?page 꼬리 떼기, 대소문자 같은 글은 한 번, 빈 쪽에서 멈춤', async () => {
  const pages = {
    'https://x.go.kr/list?p=1': '<a href="/view?id=1">식당 위생 점검</a><a href="/view?id=2">국방 소식</a><a href="/other">식당</a>',
    'https://x.go.kr/list?p=2': '<a href="/view?id=3">음식점 가격표시</a>',
    'https://x.go.kr/list?p=3': '<p>끝</p>',
    'https://maplestory.nexon.com/News/Update?page=1': '<a href="/news/update/9?page=1">패치</a><a href="/News/Update/9">같은 글</a>'
  };
  const asked = [];
  const fetcher = { get: async url => { asked.push(url); return pages[url] ? { ok: true, status: 200, url, html: pages[url] } : { ok: false, status: 404 }; } };
  const cfg = {
    allowHost: () => true,
    titleFilter: /식당|음식점|패치|같은/,
    seeds: [{ url: 'https://x.go.kr/seed', title: '씨앗', kind: 'law' }],
    listings: [
      { kind: 'press', url: 'https://x.go.kr/list?p={page}', linkPattern: /^https:\/\/x\.go\.kr\/view\?id=\d+$/ },
      { kind: 'update', url: 'https://maplestory.nexon.com/News/Update?page={page}', linkPattern: /^https:\/\/maplestory\.nexon\.com\/news\/update\/\d+$/i, stripQuery: true, paged: false }
    ]
  };
  const prev = [{ url: 'https://x.go.kr/view?id=1', title: '', kind: 'press', hash: 'sha256:old', drafted: 1 }];
  const { entries, failures } = await buildIndex({ cfg, fetcher, pages: 5, prev, now: () => 'T' });
  assert.deepEqual(entries.map(e => e.url), ['https://x.go.kr/seed', 'https://x.go.kr/view?id=1', 'https://x.go.kr/view?id=3', 'https://maplestory.nexon.com/news/update/9']);
  assert.equal(entries[1].drafted, 1, '이전 색인의 초안 표시·해시는 남긴다');
  assert.equal(entries[1].title, '식당 위생 점검');
  assert.ok(!asked.includes('https://x.go.kr/list?p=4'), '빈 쪽 뒤는 묻지 않는다');
  assert.deepEqual(failures, []);
  assert.equal(indexKey('https://maplestory.nexon.com/Guide/X'), indexKey('https://maplestory.nexon.com/guide/x'));
  assert.notEqual(indexKey('https://x.go.kr/A'), indexKey('https://x.go.kr/a'));
  for (const e of entries) assert.deepEqual(Object.keys(e).filter(k => /html|text|body/.test(k)), [], '본문 칸 없음(D-5)');
});

test('pickPages: 초안 안 한 페이지만, 종류 순서대로, 개수 제한·종류 거름', () => {
  const es = [{ url: 'a', kind: 'notice' }, { url: 'b', kind: 'guide', drafted: 1 }, { url: 'c', kind: 'update' }, { url: 'd', kind: 'guide' }];
  assert.deepEqual(pickPages(es, { kindOrder: ['guide', 'update', 'notice'], limit: 2 }).map(e => e.url), ['d', 'c']);
  assert.deepEqual(pickPages(es, { kindOrder: [], limit: 9, only: ['notice'] }).map(e => e.url), ['a']);
});

/* ───── draft ───── */

test('draftPages: 페이지마다 LLM 한 번, 짧은 본문·가져오기 실패는 부르지 않음, 429면 멈춤, 결과에 본문 없음', async () => {
  const body = '심볼은 매일 퀘스트를 하면 성장치가 쌓여 레벨이 오르는 장비다. '.repeat(10);
  const html = { 'https://m/1': `<div class="cv_main">${body}</div><div class="cv_footer">x</div>`, 'https://m/2': '<p>짧음</p>', 'https://m/4': `<p>${body}</p>`, 'https://m/5': `<p>${body}</p>` };
  const fetcher = { get: async url => (html[url] ? { ok: true, status: 200, url, html: html[url] } : { ok: false, status: 503 }) };
  const prompts = [];
  let n = 0;
  const complete = async (system, user) => {
    prompts.push(user);
    if (++n === 2) throw Object.assign(new Error('429 quota'), { status: 429 });
    return JSON.stringify({ nodes: [{ id: 'symbol_growth', label: '심볼', facts: ['매일 퀘스트를 하면 성장치가 쌓인다.', '성장치가 차면 레벨이 오른다.'], tags: ['daily_accumulation'] }] });
  };
  const graph = loadInterestGraph('maplestory');
  const cfg = { ...maple, content: [{ path: /^\/1$/, start: 'class="cv_main"', end: 'class="cv_footer"' }] };
  const pages = ['1', '2', '3', '4', '5'].map(i => ({ url: `https://m/${i}`, title: `제목${i}` }));
  const { candidates, pages: report } = await draftPages({ cfg, pages, fetcher, complete, graph, tags: graph.tags, now: () => 'T' });
  assert.deepEqual(report.map(r => r.status), ['ok', 'short', 'fetch-503', 'llm-error'], '429 뒤 페이지(5)는 부르지 않는다');
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /\[이미 있는 개념\]\n- starforce \| 스타포스 강화/);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].sources, ['https://m/1']);
  assert.match(report[0].hash, /^sha256:/);
  const saved = JSON.stringify({ candidates, report });
  assert.equal(saved.includes('장비다'), false, '저장할 결과에 본문 조각 없음(D-5)');
});

/* ───── gate: 판정 ───── */

const S = (kind, top1, extra = {}) => ({ kind, top1, top3: [top1, ...(extra.more || [])], hit1: extra.hit1, margin: extra.margin ?? null, rival: extra.rival ?? null });
const CASES = [
  { sentence: 's1', expectNodes: ['A'], guarded: false },
  { sentence: 's2', expectNodes: ['B'], guarded: true },
  { sentence: 's3', expectNodes: [], forbidNodes: ['A'], guarded: false },
  { sentence: 's4', expectNodes: [], guarded: false }
];
const BASE = new Map([
  ['s1', S('hit', 'A', { hit1: true, margin: 0.1, rival: 'B' })],
  ['s2', S('hit', 'B', { hit1: true, margin: 0.004, rival: 'A' })],
  ['s3', S('negative', 'B', { hit1: true })],
  ['s4', S('noMatch', 'A')]
]);

test('compareScores: 1위 회귀·음성 실패·얇아진 여유를 잡고 범인을 짚는다. 비유 없음 문장은 정보로만', () => {
  const cur = new Map([
    ['s1', S('hit', 'X', { hit1: false, margin: -0.01 })],
    ['s2', S('hit', 'B', { hit1: true, margin: 0.003, rival: 'Y' })],
    ['s3', S('negative', 'A', { hit1: false })],
    ['s4', S('noMatch', 'X')]
  ]);
  const issues = compareScores(BASE, cur, CASES, { candidateIds: ['X', 'Y'] });
  assert.deepEqual(issues.map(i => [i.sentence, i.kind, i.culprit]), [['s1', 'rank1', 'X'], ['s2', 'margin', 'Y'], ['s3', 'negative', null]]);
});

test('compareScores: 여유 — 얇은 선(0.005) 위에서 줄면 기본은 통과, 가드 문장은 --strict-margin이면 실패', () => {
  const base = new Map([['s1', S('hit', 'A', { hit1: true, margin: 0.1 })], ['s2', S('hit', 'B', { hit1: true, margin: 0.1 })]]);
  const cur = new Map([['s1', S('hit', 'A', { hit1: true, margin: 0.05, rival: 'X' })], ['s2', S('hit', 'B', { hit1: true, margin: 0.05, rival: 'X' })]]);
  assert.deepEqual(compareScores(base, cur, CASES, { candidateIds: ['X'] }), []);
  assert.deepEqual(compareScores(base, cur, CASES, { candidateIds: ['X'], strictGuard: true }).map(i => i.sentence), ['s2']);
  assert.deepEqual(compareScores(base, cur, CASES, { candidateIds: ['X'], threshold: 0.06 }).map(i => i.sentence), ['s1', 's2']);
  const up = new Map([['s1', S('hit', 'A', { hit1: true, margin: 0.2 })], ['s2', S('hit', 'B', { hit1: true, margin: 0.1 })]]);
  assert.deepEqual(compareScores(base, up, CASES, { strictGuard: true }), [], '여유가 늘거나 같으면 문제 없음');
});

// 가짜 평가: 노드 집합 → 문장 결과. X는 혼자 s1을 뺏고, Z는 Y와 함께 있을 때만 s2를 뺏는다
function fakeEvaluate(raw) {
  const ids = new Set(raw.nodes.map(n => n.id));
  const m = new Map(BASE);
  if (ids.has('X')) m.set('s1', S('hit', 'X', { hit1: false, margin: -0.02 }));
  if (ids.has('Y') && ids.has('Z')) m.set('s2', S('hit', 'Z', { hit1: false, margin: -0.01 }));
  if (ids.has('W')) m.set('s1', S('hit', 'A', { hit1: true, margin: 0.001, rival: 'B', more: ['W'] })); // 범인을 직접 못 짚는 경우(경쟁자는 기존 노드)
  return Promise.resolve(m);
}
const RAW = { version: '2026.11.22-1', nodes: [{ id: 'A' }, { id: 'B' }], edges: [] };

test('gateCandidates: 혼자 걸리는 후보는 빼고, 함께 걸리면 범인만 빼고 다시 재서 나머지를 채택', async () => {
  const res = await gateCandidates({ rawGraph: RAW, nodes: ['X', 'Y', 'Z', 'V'].map(id => ({ id })), evaluate: fakeEvaluate, cases: CASES });
  assert.deepEqual(res.accepted, ['Y', 'V']);
  assert.deepEqual(res.rejected.map(r => [r.id, r.stage]), [['X', 'solo'], ['Z', 'joint']]);
  assert.equal(res.rejected[1].issues[0].sentence, 's2');
  assert.equal(res.evaluations, 1 + 4 + 2, '기준 1 + 혼자 4 + 함께 2(걸림 → 다시)');
});

test('gateCandidates: 범인을 못 짚으면 문제 문장 상위 3에 든 후보를 뺀다. 후보가 없으면 평가만', async () => {
  const res = await gateCandidates({ rawGraph: RAW, nodes: [{ id: 'W' }, { id: 'V' }], evaluate: fakeEvaluate, cases: CASES });
  assert.deepEqual(res.rejected.map(r => r.id), ['W']);
  assert.deepEqual(res.accepted, ['V']);
  const none = await gateCandidates({ rawGraph: RAW, nodes: [], evaluate: fakeEvaluate, cases: CASES });
  assert.deepEqual([none.accepted, none.rejected, none.evaluations], [[], [], 1]);
});

test('mergeCases·loadGateCases: 셋을 합쳐 같은 문장은 한 번, 가드(가드 파일 + 아는 얇은 문장) 표시', () => {
  const merged = mergeCases([['eval', [{ sentence: 'a', expectNodes: ['x'] }, { sentence: 'b', expectNodes: [] }]], ['holdout', [{ sentence: 'a', expectNodes: ['x'] }, { sentence: 'n', expectNodes: [], forbidNodes: ['y'] }]]], new Set(['b']));
  assert.deepEqual(merged.map(c => [c.sentence, c.sets.join('+'), c.guarded]), [['a', 'eval+holdout', false], ['b', 'eval', true], ['n', 'holdout', false]]);
  assert.deepEqual(merged[2].forbidNodes, ['y']);
  const files = { 'eval-set.json': [{ sentence: 'p', expectNodes: ['x'] }], 'eval-holdout.json': [{ sentence: 'q', expectNodes: ['x'] }], 'eval-unseen.json': [{ sentence: 'r', expectNodes: ['x'] }], 'eval-guard.json': ['p'], 'eval-margin-known.json': { sentences: [{ sentence: 'r', floor: 0.001 }] } };
  const mc = loadGateCases('maplestory', { read: f => files[f], exists: f => f in files });
  assert.deepEqual(mc.map(c => [c.sentence, c.guarded]), [['p', true], ['q', false], ['r', true]]);
  const real = loadGateCases('restaurant');
  assert.ok(real.length > 20 && real.some(c => c.guarded), '식당: 평가셋·홀드아웃 + 식당 가드');
});

test('memoEmbedder: 같은 (종류, 글)은 한 번만 임베딩', async () => {
  const seen = [];
  const e = memoEmbedder(async (texts, kind) => { seen.push(...texts.map(t => kind + ':' + t)); return texts.map(t => [t.length]); });
  assert.deepEqual(await e.vectors(['ab', 'c', 'ab'], 'passage'), [[2], [1], [2]]);
  await e.vectors(['ab', 'd'], 'passage');
  await e.vectors(['ab'], 'query');
  assert.deepEqual(seen, ['passage:ab', 'passage:c', 'passage:d', 'query:ab']);
});

test('scoreGraph + gateCandidates(실제 메이플 그래프·대체 임베더): 평가 문장을 베낀 후보는 1위를 뺏어 빠지고, 새 노드 글만 더 임베딩', async () => {
  const raw = readJson(commonGraphPath('maplestory'));
  const cases = loadGateCases('maplestory');
  const target = cases.find(c => c.sentence.startsWith('레버리지는'));
  assert.ok(target, '평가셋 문장');
  const embedder = memoEmbedder(async texts => texts.map(t => hashEmbed(t)));
  const evaluate = r => scoreGraph(r, { tagsFile, cases, admin, embedder });
  const base = await evaluate(raw);
  assert.equal(base.get(target.sentence).hit1, true, '기준에서는 맞는 문장');
  const before = embedder.stats().texts;
  const thief = { id: 'leverage_thief', label: '레버리지', facts: [target.sentence], tags: ['loss_risk'], sources: ['https://maplestory.nexon.com/x'], verifiedAt: '2026-11-22' };
  const res = await gateCandidates({ rawGraph: raw, nodes: [thief], evaluate, cases });
  assert.deepEqual(res.accepted, []);
  const issue = res.rejected[0].issues.find(i => i.sentence === target.sentence);
  assert.deepEqual([issue.kind, issue.culprit], ['rank1', 'leverage_thief']);
  assert.equal(embedder.stats().texts - before, 1, '후보 노드 글 하나만 새로 임베딩(질의·기존 노드는 메모)');
});

/* ───── apply ───── */

test('bumpVersion·today: 같은 날이면 번호 +1, 아니면 오늘-1', () => {
  assert.equal(bumpVersion('2026.11.22-6', '2026-11-22'), '2026.11.22-7');
  assert.equal(bumpVersion('2026.11.21-3', '2026-11-22'), '2026.11.22-1');
  assert.equal(bumpVersion('엉망', '2026-11-22'), '2026.11.22-1');
  assert.equal(today(new Date(2026, 0, 5)), '2026-01-05');
});

const R = (id, status, extra = {}) => ({ status, fails: status === 'fail' ? ['idFormat'] : [], warns: [], node: { id, label: id + ' 이름', aliases: extra.aliases, facts: ['구조가 바뀐다.', '둘째다.'], tags: ['cooldown'], sources: ['https://maplestory.nexon.com/x'] }, edges: extra.edges || [] });

test('buildPatch: 실패·없는 id 거절, 같은 id면 실패 아닌 쪽, 키 순서·verifiedAt, 별칭은 관심사 규칙대로', () => {
  const results = [R('a_one', 'pass', { aliases: ['에이'], edges: [{ to: 'meso', rel: '씀' }] }), R('b_one', 'fail'), R('c_one', 'fail'), R('c_one', 'warn')];
  const p = buildPatch(results, ['a_one', 'b_one', 'c_one', 'zz', 'a_one'], { rules: maple.rules, day: '2026-11-22' });
  assert.deepEqual(p.nodes.map(n => n.id), ['a_one', 'c_one']);
  assert.deepEqual(Object.keys(p.nodes[0]), ['id', 'label', 'aliases', 'facts', 'tags', 'sources', 'verifiedAt']);
  assert.equal(p.nodes[0].verifiedAt, '2026-11-22');
  assert.deepEqual(p.refused.map(r => r.id), ['b_one', 'zz']);
  assert.deepEqual(p.edges, [{ from: 'a_one', to: 'meso', rel: '씀' }]);
  assert.equal(buildPatch(results, ['a_one'], { rules: INTERESTS.restaurant.rules, day: '2026-11-22' }).nodes[0].aliases, undefined);
});

test('applyPatch: 원본은 그대로, 판본 올림, 있는 노드끼리·중복 아닌 엣지만, 해석된 그래프로 검증', () => {
  const raw = readJson(commonGraphPath('maplestory'));
  const snapshot = JSON.stringify(raw);
  const node = { id: 'pipeline_demo', label: '파이프라인 시연', facts: ['조건을 채우면 보상을 얻는다.', '둘째다.'], tags: ['threshold_req'], sources: ['https://maplestory.nexon.com/x'], verifiedAt: '2026-11-22' };
  const patch = { nodes: [node, { ...raw.nodes[0] }], edges: [{ from: 'pipeline_demo', to: 'meso', rel: '씀' }, { from: 'pipeline_demo', to: 'ghost', rel: 'x' }, { ...raw.edges[0] }] };
  const { graph, added, skippedEdges, errors } = applyPatch(raw, patch, { tagsFile, day: '2026-11-22' });
  assert.deepEqual(errors, []);
  assert.equal(JSON.stringify(raw), snapshot, '원본 객체를 바꾸지 않는다');
  assert.deepEqual(added, { nodes: 1, edges: 1 });
  assert.equal(skippedEdges.length, 2);
  assert.equal(graph.nodes.length, raw.nodes.length + 1);
  assert.equal(graph.version, bumpVersion(raw.version, '2026-11-22'));
  assert.equal(graph.tags, undefined, '파일 꼴 유지(태그는 tags.json)');
  const bad = applyPatch(raw, { nodes: [{ ...node, tags: ['made_up'] }], edges: [] }, { tagsFile, day: '2026-11-22' });
  assert.match(bad.errors.join(), /없는 태그/);
});

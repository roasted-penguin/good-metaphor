// T-194 반자동 노드 파이프라인 흐름: index·draft(가짜 fetch·LLM), 회귀 관문(gate), 패치(apply)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildIndex, pickPages, draftPages, indexKey } from '../../tools/node-pipeline/run.mjs';
import { compareScores, gateCandidates, mergeCases, loadGateCases, memoEmbedder, scoreGraph, blocking, altReason, altRows, renderAltTable, buildAltExplainPrompt, parseAltExplain, altPendingRefusals, applyAltToText, inlineJson, altTargetFiles } from '../../tools/node-pipeline/gate.mjs';
import { bumpVersion, buildPatch, applyPatch, today } from '../../tools/node-pipeline/apply.mjs';
import { INTERESTS, mapleBoardLinks, MAPLE_GUIDE_BOARDS } from '../../tools/node-pipeline/sources.mjs';
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

test('buildIndex: 목록별 titleFilter·titleSkip(T-207, 메이플 공지)', async () => {
  const html = '<a href="/n/1">운영정책 변경 안내</a><a href="/n/2">정기점검 안내</a><a href="/n/3">운영정책 오류 안내</a>';
  const fetcher = { get: async url => (url.endsWith('p=1') ? { ok: true, status: 200, url, html } : { ok: true, status: 200, url, html: '' }) };
  const cfg = { allowHost: () => true, seeds: [], listings: [{ kind: 'notice', url: 'https://x.go.kr/l?p={page}', linkPattern: /\/n\/\d+$/, titleFilter: /운영정책|점검/, titleSkip: /오류/ }] };
  const { entries } = await buildIndex({ cfg, fetcher, pages: 2, now: () => 'T' });
  assert.deepEqual(entries.map(e => e.title), ['운영정책 변경 안내', '정기점검 안내']);
});

test('buildIndex: JSON 목록(T-208 메이플 가이드 분류) — 글 번호·제목만, 본문 칸은 버림, 실패는 failures', async () => {
  const json = { pageInfo: {}, list: [
    { articleId: 404, title: '5차 스킬 강화하기', content: '<p>본문</p>', textContent: '본문' },
    { articleId: 'x', title: '이상한 번호' },
    { articleId: 410, title: '장비 가이드', content: '<p>본문</p>' }
  ] };
  const fetcher = {
    get: async () => { throw new Error('GET 안 씀'); },
    postJson: async url => (url.endsWith('=1') ? { ok: true, status: 200, url, json } : { ok: false, status: 500 })
  };
  const listing = id => ({ ...maple.listings.find(l => l.json), url: `https://maplestory.nexon.com/guide/n23gameinformation/articles?boardId=${id}` });
  const cfg = { allowHost: maple.allowHost, seeds: [], listings: [listing(1), listing(2)] };
  const { entries, failures } = await buildIndex({ cfg, fetcher, now: () => 'T' });
  assert.deepEqual(entries.map(e => [e.url, e.title, e.kind]), [
    ['https://maplestory.nexon.com/Guide/N23GameInformation/Articles/404', '5차 스킬 강화하기', 'guide'],
    ['https://maplestory.nexon.com/Guide/N23GameInformation/Articles/410', '장비 가이드', 'guide']
  ]);
  for (const e of entries) assert.deepEqual(Object.keys(e).filter(k => /html|text|body|content/.test(k)), [], '본문 칸 없음(D-5)');
  assert.equal(failures.length, 1);
  assert.deepEqual(mapleBoardLinks(null), []);
  assert.equal(maple.listings.filter(l => l.json).length, MAPLE_GUIDE_BOARDS.length, '분류마다 목록 하나');
});

test('pickPages: 초안 안 한 페이지만, 종류 순서대로, 개수 제한·종류 거름', () => {
  const es = [{ url: 'a', kind: 'notice' }, { url: 'b', kind: 'guide', drafted: 1 }, { url: 'c', kind: 'update' }, { url: 'd', kind: 'guide' }];
  assert.deepEqual(pickPages(es, { kindOrder: ['guide', 'update', 'notice'], limit: 2 }).map(e => e.url), ['d', 'c']);
  assert.deepEqual(pickPages(es, { kindOrder: [], limit: 9, only: ['notice'] }).map(e => e.url), ['a']);
  const ups = [{ url: 'u1', kind: 'update', title: '클라이언트 업데이트 안내 (스킬 조정)' }, { url: 'u2', kind: 'update', title: '클라이언트 업데이트 안내' }];
  assert.deepEqual(pickPages(ups, { pageSkip: maple.pageSkip }).map(e => e.url), ['u2'], '건너뛸 제목(스킬 조정)은 고르지 않는다');
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

test('draftPages(T-195): 긴 글은 절마다 LLM 한 번, 건너뛸 절은 부르지 않음, 태그 없는 후보는 버리고 기록, 호출 상한이면 budget', async () => {
  const sec = t => `<h1>${t}</h1><p>${t} 설명: 재료를 들여 시도하면 확률로 성공한다. `.repeat(1) + 'ㄴ'.repeat(300) + '</p>';
  const html = `<div class="new_board_con">${sec('어빌리티 개편')}${sec('가을 이벤트')}${sec('주문서 강화 개편')}${sec('마일리지 개편')}</div><div id="footer"></div>`;
  const fetcher = { get: async url => ({ ok: true, status: 200, url, html }) };
  const users = [];
  let calls = 0;
  const complete = async (system, user) => {
    calls++; users.push(user);
    const n = calls;
    return JSON.stringify({ nodes: [{ id: `node_${n}`, label: `개념${n}`, facts: ['a다.', 'b다.'], tags: ['prob_upgrade'] }, { id: `bad_${n}`, label: `태그없음${n}`, facts: ['a다.', 'b다.'], tags: ['nope'] }] });
  };
  complete.calls = () => calls;
  const graph = loadInterestGraph('maplestory');
  const page = { url: 'https://maplestory.nexon.com/news/update/1', title: '패치' };
  const r = await draftPages({ cfg: maple, pages: [page], fetcher, complete, graph, tags: graph.tags, now: () => 'T', sectionOpts: { minChars: 100 } });
  assert.equal(calls, 3, '절 3개(이벤트 절은 건너뜀)');
  assert.deepEqual(r.candidates.map(c => c.section), ['어빌리티 개편', '주문서 강화 개편', '마일리지 개편']);
  assert.equal(r.dropped.length, 3);
  assert.deepEqual([r.pages[0].status, r.pages[0].sections, r.pages[0].skipped, r.pages[0].count, r.pages[0].dropped], ['ok', 3, 1, 3, 3]);
  assert.match(users[1], /- node_1 \| 개념1/, '같은 페이지 앞 절에서 나온 개념은 다음 절에 이미 있는 개념으로');
  assert.equal(JSON.stringify(r).includes('ㄴㄴㄴ'), false, '본문 조각 없음(D-5)');
  calls = 0;
  const b = await draftPages({ cfg: maple, pages: [page, { ...page, url: page.url + '2' }], fetcher, complete, graph, tags: graph.tags, now: () => 'T', sectionOpts: { minChars: 100 }, maxCalls: 2 });
  assert.equal(calls, 2);
  assert.deepEqual(b.pages.map(p => p.status), ['budget'], '상한에 닿으면 그 페이지는 budget(다음에 다시), 다음 페이지는 안 감');
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

test('compareScores: 1위 회귀·음성 실패·얇아진 여유를 잡고 범인을 짚는다. 비유 없음 문장 1위를 후보가 차지하면 회귀(T-195)', () => {
  const cur = new Map([
    ['s1', S('hit', 'X', { hit1: false, margin: -0.01 })],
    ['s2', S('hit', 'B', { hit1: true, margin: 0.003, rival: 'Y' })],
    ['s3', S('negative', 'A', { hit1: false })],
    ['s4', S('noMatch', 'X')]
  ]);
  const issues = compareScores(BASE, cur, CASES, { candidateIds: ['X', 'Y'] });
  assert.deepEqual(issues.map(i => [i.sentence, i.kind, i.culprit]), [['s1', 'rank1', 'X'], ['s2', 'margin', 'Y'], ['s3', 'negative', null], ['s4', 'noMatch', 'X']]);
  const old = new Map([...cur, ['s4', S('noMatch', 'B')]]);
  assert.equal(compareScores(BASE, old, CASES, { candidateIds: ['X', 'Y'] }).some(i => i.kind === 'noMatch'), false, '기존 노드끼리 1위가 바뀐 비유 없음 문장은 후보 탓이 아니다');
});

const TCASES = [
  { sentence: 't1', expectNodes: ['A'], expectTag: 'loss_risk', guarded: true },
  { sentence: 't2', expectNodes: ['B'], expectTag: 'periodic_cap', guarded: false },
  { sentence: 't3', expectNodes: [], forbidNodes: ['A'], guarded: false },
  { sentence: 't4', expectNodes: ['A'], guarded: false } // expectTag 없음
];
const TBASE = new Map([
  ['t1', S('hit', 'A', { hit1: true, margin: 0.1, rival: 'B' })],
  ['t2', S('hit', 'B', { hit1: true, margin: 0.1, rival: 'A' })],
  ['t3', S('negative', 'B', { hit1: true })],
  ['t4', S('hit', 'A', { hit1: true, margin: 0.1, rival: 'B' })]
]);
const TAGS = new Map([['N', ['loss_risk', 'expected_value']], ['M', ['market_price']]]);

test('compareScores 대안 정답(T-195): 1위를 가져간 후보가 expectTag를 가지면 alt(막지 않음), 없으면 rank1, 음성 문장은 그대로 회귀', () => {
  const cur = new Map([
    ['t1', S('hit', 'N', { hit1: false, margin: -0.02 })],   // N은 loss_risk → 대안 정답 후보
    ['t2', S('hit', 'N', { hit1: false, margin: -0.01 })],   // N에 periodic_cap 없음 → 회귀
    ['t3', S('negative', 'N', { hit1: true })],              // 음성 문장(맞는 비유 없음)에 후보가 붙음 → 회귀
    ['t4', S('hit', 'N', { hit1: false, margin: -0.01 })]    // 문장에 expectTag가 없으면 대안 판정 불가 → 회귀
  ]);
  const issues = compareScores(TBASE, cur, TCASES, { candidateIds: ['N'], candidateTags: TAGS });
  assert.deepEqual(issues.map(i => [i.sentence, i.kind, i.culprit]), [['t1', 'alt', 'N'], ['t2', 'rank1', 'N'], ['t3', 'noMatch', 'N'], ['t4', 'rank1', 'N']]);
  assert.equal(issues[0].expectTag, 'loss_risk');
  assert.equal(issues[0].guarded, true, '가드 문장도 대안 정답 후보로(메인 확인)');
  assert.deepEqual(blocking(issues).map(i => i.sentence), ['t2', 't3', 't4']);
  // 태그 정보가 없으면(후보 태그 모름) 보수적으로 rank1
  assert.equal(compareScores(TBASE, cur, TCASES, { candidateIds: ['N'] })[0].kind, 'rank1');
  // 기존 노드가 1위를 가져가면(후보 아님) 태그가 맞아도 rank1
  const byOld = new Map([...TBASE, ['t1', S('hit', 'B', { hit1: false, margin: -0.01 })]]);
  assert.equal(compareScores(TBASE, byOld, TCASES, { candidateIds: ['N'], candidateTags: new Map([['B', ['loss_risk']]]) })[0].kind, 'rank1');
});

test('compareScores 대안 정답: expectTag 없는 경쟁자가 얇은 선 아래로 밀면 margin, 있으면 2위 대안 정답(T-197)', () => {
  const cur = new Map([...TBASE, ['t1', S('hit', 'A', { hit1: true, margin: 0.004, rival: 'M' })], ['t2', S('hit', 'B', { hit1: true, margin: 0.02, rival: 'N' })]]);
  const issues = compareScores(TBASE, cur, TCASES, { candidateIds: ['N', 'M'], candidateTags: TAGS });
  assert.deepEqual(issues.map(i => [i.sentence, i.kind, i.culprit]), [['t1', 'margin', 'M']]);
  const viaN = new Map([...cur, ['t1', S('hit', 'A', { hit1: true, margin: 0.004, rival: 'N' })]]);
  assert.deepEqual(compareScores(TBASE, viaN, TCASES, { candidateIds: ['N'], candidateTags: TAGS }).map(i => [i.sentence, i.kind, i.via]), [['t1', 'alt', 'margin']]);
});

test('gateCandidates 대안 정답: alt만 있는 후보는 채택하고 altPending·alternatives로, 회귀 후보는 뺀다', async () => {
  const ev = raw => {
    const ids = new Set(raw.nodes.map(n => n.id));
    const m = new Map(TBASE);
    if (ids.has('N')) m.set('t1', S('hit', 'N', { hit1: false, margin: -0.02 }));
    if (ids.has('M')) m.set('t2', S('hit', 'M', { hit1: false, margin: -0.01 }));
    return Promise.resolve(m);
  };
  const res = await gateCandidates({ rawGraph: RAW, nodes: [{ id: 'N', tags: ['loss_risk'] }, { id: 'M', tags: ['market_price'] }, { id: 'V', tags: ['loss_risk'] }], evaluate: ev, cases: TCASES });
  assert.deepEqual(res.accepted, ['N', 'V']);
  assert.deepEqual(res.rejected.map(r => [r.id, r.issues[0].kind]), [['M', 'rank1']]);
  assert.deepEqual(res.altPending, ['N']);
  assert.deepEqual(res.alternatives.map(a => [a.sentence, a.culprit, a.kind]), [['t1', 'N', 'alt']]);
});

test('altReason·altRows: 공유 태그 뜻과 문장에 가장 가까운 사실, 확인 필요 표시, approve 기본 false', () => {
  const node = { id: 'n1', label: '잠재 강화', facts: ['재료를 들여 시도하면 실패할 때 장비가 망가질 수 있다.', '보호 아이템을 쓰면 망가짐을 막는다.'], tags: ['loss_risk'] };
  const tag = { id: 'loss_risk', label: '손실 위험', desc: '잘못되면 쌓아 둔 것을 잃는 구조' };
  const r = altReason({ sentence: '레버리지를 쓰다 실패하면 원금이 망가질 수 있다.', expectTag: 'loss_risk', node, tag });
  assert.equal(r.needsReview, true);
  assert.equal(r.source, 'heuristic');
  assert.equal(r.bestFact, node.facts[0], '문장과 글자가 더 겹치는 사실');
  assert.match(r.text, /loss_risk\(손실 위험: 잘못되면/);
  const rows = altRows([{ sentence: 's', culprit: 'n1', before: 'A', expectTag: 'loss_risk', guarded: true }], { interest: 'maplestory', nodes: [node], cases: [{ sentence: 's', expectNodes: ['A', 'B'], sets: ['eval', 'holdout'] }], tags: [tag] });
  assert.deepEqual([rows[0].oldExpected, rows[0].newNode, rows[0].newLabel, rows[0].sets, rows[0].approve, rows[0].guarded], [['A', 'B'], 'n1', '잠재 강화', ['eval', 'holdout'], false, true]);
  const md = renderAltTable(rows, { interest: 'maplestory', batch: 3, embedderId: 'fallback' });
  assert.match(md, /\| 1 \| s \(가드\) \| eval\+holdout \| A, B \| n1 잠재 강화 \| 1위 \| loss_risk \|/);
  assert.match(md, /accept-alt/);
});

test('buildAltExplainPrompt·parseAltExplain: 사실만 근거, yes/no와 한 문장 이유, 꼴이 틀리면 null', () => {
  const { system, user } = buildAltExplainPrompt({ sentence: '문장', expectTag: 'loss_risk', tag: { label: '손실 위험', desc: 'd' }, node: { label: '개념', facts: ['사실 하나.'] } });
  assert.match(system, /사실에 없는 내용을 보태지 않는다/);
  assert.match(user, /\[문장\] 문장\n\[기대 추상 구조\] loss_risk \| 손실 위험 — d\n\[개념\] 개념\n- 사실 하나\./);
  assert.deepEqual(parseAltExplain('```json\n{"verdict":"yes","reason":"같은 구조다."}\n```'), { verdict: 'yes', reason: '같은 구조다.' });
  assert.equal(parseAltExplain('{"verdict":"maybe"}'), null);
  assert.equal(parseAltExplain('없음'), null);
});

test('altPendingRefusals: expectNodes에 아직 없는 대안 정답이 남은 노드만 막는다', () => {
  const gr = { alternatives: [{ sentence: 'a', culprit: 'N' }, { sentence: 'b', culprit: 'N' }, { sentence: 'c', culprit: 'K' }] };
  const cases = [{ sentence: 'a', expectNodes: ['A', 'N'] }, { sentence: 'b', expectNodes: ['B'] }, { sentence: 'c', expectNodes: ['C', 'K'] }];
  assert.deepEqual([...altPendingRefusals(gr, cases)], [['N', ['b']]]);
  assert.equal(altPendingRefusals({}, cases).size, 0);
});

test('applyAltToText·inlineJson·altTargetFiles: 한 줄 꼴을 지키고 고친 줄만 바뀜, 비유 없음·이미 있는 노드는 그대로', () => {
  const text = [
    '[',
    '  { "sentence": "가", "expectNodes": ["a"], "expectTag": "t", "group": "g" },',
    '  { "sentence": "나", "expectNodes": [] },',
    '  { "sentence": "다", "expectNodes": ["a", "n"], "expectTag": "t" }',
    ']',
    ''
  ].join('\n');
  const { text: out, changed } = applyAltToText(text, [{ sentence: '가', newNode: 'n' }, { sentence: '가', newNode: 'n' }, { sentence: '나', newNode: 'n' }, { sentence: '다', newNode: 'n' }, { sentence: '없음', newNode: 'n' }]);
  assert.deepEqual(changed, [{ sentence: '가', node: 'n' }]);
  const a = text.split('\n'), b = out.split('\n');
  assert.deepEqual(b.map((l, i) => l !== a[i]), [false, true, false, false, false, false]);
  assert.equal(b[1], '  { "sentence": "가", "expectNodes": ["a", "n"], "expectTag": "t", "group": "g" },');
  assert.equal(inlineJson({ x: [1, 'y'], z: {} }), '{ "x": [1, "y"], "z": {} }');
  // 실제 평가 파일 한 줄도 그대로 다시 쓸 수 있다(꼴이 같음)
  const real = readFileSync(new URL('../../tools/eval-set.json', import.meta.url), 'utf8').split('\n')[1];
  assert.equal('  ' + inlineJson(JSON.parse(real.trim().replace(/,$/, ''))) + ',', real);
  const files = altTargetFiles();
  assert.deepEqual(files.filter(([, i]) => i === 'restaurant').map(([f]) => f), ['eval-set-restaurant.json', 'eval-unseen-restaurant.json']);
  assert.ok(files.some(([f, i]) => f === 'eval-holdout.json' && i === 'maplestory'));
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
  const merged = mergeCases([['eval', [{ sentence: 'a', expectNodes: ['x'], expectTag: 'loss_risk' }, { sentence: 'b', expectNodes: [] }]], ['holdout', [{ sentence: 'a', expectNodes: ['x'] }, { sentence: 'n', expectNodes: [], forbidNodes: ['y'] }]]], new Set(['b']));
  assert.deepEqual(merged.map(c => [c.sentence, c.sets.join('+'), c.guarded]), [['a', 'eval+holdout', false], ['b', 'eval', true], ['n', 'holdout', false]]);
  assert.equal(merged[0].expectTag, 'loss_risk', 'expectTag를 남긴다(대안 정답 판정)');
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

test('scoreGraph + gateCandidates(실제 메이플 그래프·대체 임베더): 평가 문장을 베낀 후보(다른 태그)는 1위를 뺏어 빠지고, 새 노드 글만 더 임베딩', async () => {
  const raw = readJson(commonGraphPath('maplestory'));
  const cases = loadGateCases('maplestory');
  const target = cases.find(c => c.sentence.startsWith('레버리지는'));
  assert.ok(target, '평가셋 문장');
  const embedder = memoEmbedder(async texts => texts.map(t => hashEmbed(t)));
  const evaluate = r => scoreGraph(r, { tagsFile, cases, admin, embedder });
  const base = await evaluate(raw);
  assert.equal(base.get(target.sentence).hit1, true, '기준에서는 맞는 문장');
  const before = embedder.stats().texts;
  const thief = { id: 'leverage_thief', label: '레버리지', facts: [target.sentence], tags: ['periodic_cap'], sources: ['https://maplestory.nexon.com/x'], verifiedAt: '2026-11-22' };
  const res = await gateCandidates({ rawGraph: raw, nodes: [thief], evaluate, cases });
  assert.deepEqual(res.accepted, []);
  const issue = res.rejected[0].issues.find(i => i.sentence === target.sentence);
  assert.deepEqual([issue.kind, issue.culprit], ['rank1', 'leverage_thief']);
  assert.equal(embedder.stats().texts - before, 1, '후보 노드 글 하나만 새로 임베딩(질의·기존 노드는 메모)');
  // 같은 후보가 문장의 expectTag(loss_risk)를 가지면 그 문장은 회귀가 아니라 대안 정답 후보
  const alt = { ...thief, id: 'leverage_alt', tags: ['loss_risk'] };
  const cur = await evaluate({ ...raw, nodes: [...raw.nodes, alt] });
  const issues = compareScores(base, cur, cases, { candidateIds: [alt.id], candidateTags: new Map([[alt.id, alt.tags]]) });
  const hit = issues.find(i => i.sentence === target.sentence);
  assert.deepEqual([hit.kind, hit.culprit, hit.expectTag], ['alt', 'leverage_alt', 'loss_risk']);
  assert.equal(blocking(issues).some(i => i.sentence === target.sentence), false);
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

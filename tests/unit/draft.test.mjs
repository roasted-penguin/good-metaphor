// AI 관심사 그래프 초안 + 검수(T-301): 프롬프트, 파싱·검증, 검수 순수 함수, 병합 제외, 오버레이 검증
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildDraftPrompt, withRo } from '../../extension/lib/prompt.js';
import {
  parseDraft, DRAFT_LIMITS, confirmFact, confirmAllFacts, removeFact, settleDraft, reviewAfterEdit,
  addDraftNodes, startNewInterest, draftNodes, hasNumber, demoDraftText, validDraftName
} from '../../extension/lib/draft.js';
import { mergeGraphs } from '../../extension/lib/graph.js';
import { validateOverlay } from '../../extension/lib/stores.js';
import { loadCommonGraphFromDisk } from '../../tools/load-graph.mjs';

const tagsFile = JSON.parse(readFileSync(new URL('../../extension/data/common/tags.json', import.meta.url), 'utf8'));
const TAGS = tagsFile.tags;
const blockTerms = JSON.parse(readFileSync(new URL('../../extension/data/common/blocklist.json', import.meta.url), 'utf8')).terms;
const common = loadCommonGraphFromDisk();
// 금칙어는 테스트 안에서만 쓴다(우회 표기로 정규화 검사도 함께 본다)
const BLOCKED = '리.선 족';

const okNode = (i, extra = {}) => ({ label: `Concept ${i}`, facts: [`개념 ${'가나다라마바사아자차'[i % 10]}는 꾸준히 쌓아야 커진다.`], tags: ['daily_accumulation'], ...extra });
const wrap = nodes => JSON.stringify({ nodes });
const parse = (text, opts = {}) => parseDraft(text, { tags: TAGS, existingIds: [], blockTerms, rand: () => 0.5, ...opts });

/* ───── 프롬프트 ───── */

test('buildDraftPrompt: tags.json 태그를 하나도 빠짐없이 id·label·desc로 싣는다(규칙 9)', () => {
  const { system, user } = buildDraftPrompt({ name: '축구', tags: TAGS });
  const all = system + '\n' + user;
  for (const t of TAGS) {
    assert.ok(all.includes(t.id), `태그 id ${t.id}`);
    assert.ok(all.includes(t.label), `태그 label ${t.label}`);
    assert.ok(all.includes(t.desc), `태그 desc ${t.id}`);
  }
  assert.ok(all.includes('축구'));
});

test('buildDraftPrompt: 규칙 문구(목록 밖 태그 금지, 자주 바뀌는 수치 금지, 실존 인물·멸칭 금지, 지어내지 않기, JSON 형식, 10~20개)', () => {
  const { system } = buildDraftPrompt({ name: '요리', tags: TAGS });
  assert.match(system, /목록 밖 태그는 쓰지 않는다/);
  assert.match(system, /자주 바뀌는 수치\(가격·확률·날짜/);
  assert.match(system, /실존 인물/);
  assert.match(system, /멸칭/);
  assert.match(system, /지어내지 않/);
  assert.match(system, /확실한 것만/);
  assert.match(system, /10~20개/);
  assert.ok(system.includes('{"nodes": [{"label": string, "facts": [string], "tags": [string]}]}'));
  // 태그 예문(examples)은 길고 다른 분야 문장이라 싣지 않는다
  assert.ok(!system.includes(TAGS[0].examples[0]));
});

test('withRo: 받침이면 "으로", ㄹ 받침·받침 없음이면 "로"', () => {
  assert.equal(withRo('축구'), '축구로');
  assert.equal(withRo('원신'), '원신으로');
  assert.equal(withRo('요리 교실'), '요리 교실로'); // ㄹ 받침
  assert.equal(withRo('Football'), 'Football로');
});

/* ───── 파싱·검증 ───── */

test('parseDraft: 코드블록·앞뒤 설명이 있어도 JSON을 뽑고, 노드는 draft·factsReviewed(모두 false)·u: id', () => {
  const text = '초안이에요.\n```json\n' + wrap([okNode(1, { facts: ['사실 하나.', '사실 둘.'] })]) + '\n```\n끝.';
  const r = parse(text);
  assert.equal(r.nodes.length, 1);
  const n = r.nodes[0];
  assert.equal(n.id, 'u:concept_1');
  assert.equal(n.draft, true);
  assert.deepEqual(n.facts, ['사실 하나.', '사실 둘.']);
  assert.deepEqual(n.factsReviewed, [false, false]);
  assert.deepEqual(n.tags, ['daily_accumulation']);
  assert.equal(r.error, undefined);
});

test('parseDraft: 잘못된 JSON·nodes 없음이면 노드 0개와 오류 문구(던지지 않는다)', () => {
  for (const bad of ['', '그냥 글이에요', '{"nodes": 3}', '{ "nodes": [', null]) {
    const r = parse(bad);
    assert.deepEqual(r.nodes, []);
    assert.ok(r.error, String(bad));
  }
  // 최상위가 배열이어도 받는다
  assert.equal(parse(JSON.stringify([okNode(1)])).nodes.length, 1);
});

test('parseDraft: 목록 밖 태그는 버리고, 남은 태그가 없으면 노드를 버린다(규칙 9)', () => {
  const r = parse(wrap([
    okNode(1, { tags: ['daily_accumulation', 'made_up_tag'] }),
    okNode(2, { tags: ['made_up_tag', 'another'] })
  ]));
  assert.deepEqual(r.nodes.map(n => n.tags), [['daily_accumulation']]);
  assert.deepEqual(r.dropped, [{ label: 'Concept 2', reason: '목록에 있는 태그가 없어요.' }]);
});

test('parseDraft: 태그는 중복을 빼고 세 개까지', () => {
  const ids = TAGS.slice(0, 5).map(t => t.id);
  const r = parse(wrap([okNode(1, { tags: [ids[0], ids[0], ...ids.slice(1)] })]));
  assert.deepEqual(r.nodes[0].tags, ids.slice(0, 3));
});

test('parseDraft: 금칙어가 이름에 있으면 노드를, 사실에 있으면 그 사실만 버린다(규칙 11)', () => {
  const r = parse(wrap([
    okNode(1, { label: `${BLOCKED} 이야기` }),
    okNode(2, { facts: [`${BLOCKED}는 나쁜 말이다.`, '이 사실은 남는다.'] }),
    okNode(3, { facts: [`${BLOCKED} 사실뿐이다.`] })
  ]));
  assert.deepEqual(r.nodes.map(n => n.label), ['Concept 2']);
  assert.deepEqual(r.nodes[0].facts, ['이 사실은 남는다.']);
  assert.deepEqual(r.nodes[0].factsReviewed, [false]);
  // 버린 목록에는 금칙어 자체를 담지 않는다
  assert.ok(!JSON.stringify(r.dropped).includes('선'), JSON.stringify(r.dropped));
  assert.deepEqual(r.dropped.map(d => d.reason), ['이름에 쓸 수 없는 표현이 있어요.', '쓸 수 없는 표현이 든 사실을 뺐어요.', '쓸 수 없는 표현이 든 사실을 뺐어요.', '남은 사실이 없어요.']);
  assert.equal(r.dropped[0].label, '(가림)');
});

test('parseDraft: 이름 1~40자, 사실 1~3개·각 1~200자 밖은 버린다', () => {
  const r = parse(wrap([
    okNode(1, { label: '' }),
    okNode(2, { label: 'x'.repeat(DRAFT_LIMITS.label + 1) }),
    okNode(3, { facts: [] }),
    okNode(4, { facts: ['가'.repeat(DRAFT_LIMITS.fact + 1), '짧은 사실.'] }),
    okNode(5, { facts: ['하나.', '둘.', '셋.', '넷.'] }),
    okNode(6, { facts: '문자열 사실' }),
    { label: 'Concept 7', facts: [42, '  ', '남는다.'], tags: ['daily_accumulation'] }
  ]));
  assert.deepEqual(r.nodes.map(n => [n.label, n.facts]), [
    ['Concept 4', ['짧은 사실.']],
    ['Concept 5', ['하나.', '둘.', '셋.']],
    ['Concept 7', ['남는다.']]
  ]);
  assert.deepEqual(r.dropped.filter(d => /이름/.test(d.reason)).length, 2);
  assert.ok(r.dropped.some(d => d.label === 'Concept 3' && d.reason === '남은 사실이 없어요.'));
  assert.ok(r.dropped.some(d => d.label === 'Concept 4' && d.reason === '200자를 넘는 사실을 뺐어요.'));
  assert.ok(r.dropped.some(d => d.label === 'Concept 6' && d.reason === '남은 사실이 없어요.'));
});

test('parseDraft: 20개를 넘으면 앞 20개만, 10개 미만이어도 받는다', () => {
  const many = parse(wrap(Array.from({ length: 23 }, (_, i) => okNode(i + 1))));
  assert.equal(many.nodes.length, DRAFT_LIMITS.max);
  assert.equal(many.nodes.at(-1).label, 'Concept 20');
  assert.equal(many.dropped.filter(d => d.reason === '20개를 넘어서 뺐어요.').length, 3);
  const few = parse(wrap([okNode(1), okNode(2)]));
  assert.equal(few.nodes.length, 2);
});

test('parseDraft: 같은 이름은 한 번만, id는 기존 id·서로를 피한다(T-202 슬러그)', () => {
  const r = parse(wrap([okNode(1, { label: 'Routine' }), okNode(2, { label: 'Routine' }), okNode(3, { label: 'Routine!' })]), { existingIds: ['u:routine'] });
  assert.deepEqual(r.nodes.map(n => n.id), ['u:routine_2', 'u:routine_3']);
  assert.ok(r.dropped.some(d => d.label === 'Routine' && d.reason === '같은 이름이 이미 있어요.'));
  // 영문이 없는 이름은 u:n + 무작위, 겹치지 않는다
  let k = 0;
  const ko = parseDraft(wrap([okNode(1, { label: '오프사이드' }), okNode(2, { label: '이적 시장' })]), { tags: TAGS, existingIds: [], blockTerms, rand: () => [0.1, 0.1, 0.2][k++] ?? 0.3 });
  assert.equal(ko.nodes.length, 2);
  assert.ok(ko.nodes.every(n => /^u:n[0-9a-z]{6}$/.test(n.id)));
  assert.notEqual(ko.nodes[0].id, ko.nodes[1].id);
});

test('parseDraft: 숫자가 든 사실은 남기되 warnings에 노드 id·사실 번호로 표시(규칙 2는 경고만)', () => {
  const r = parse(wrap([okNode(1, { facts: ['한 경기는 90분이다.', '숫자가 없는 사실.'] })]));
  assert.deepEqual(r.nodes[0].facts, ['한 경기는 90분이다.', '숫자가 없는 사실.']);
  assert.deepEqual(r.warnings, [{ nodeId: 'u:concept_1', factIndex: 0, reason: '숫자가 있어요. 자주 바뀌는 값이면 지워 주세요.' }]);
  assert.equal(hasNumber('3번'), true);
  assert.equal(hasNumber('세 번'), false);
});

test('parseDraft: 노드 모양이 아닌 항목(문자열·null)은 버린다', () => {
  const r = parse(JSON.stringify({ nodes: ['글', null, okNode(1)] }));
  assert.equal(r.nodes.length, 1);
  assert.equal(r.dropped.length, 2);
});

test('demoDraftText: 키 없는 사용자용 고정 초안도 parseDraft를 10개 이상 통과한다', () => {
  const r = parse(demoDraftText('축구'));
  assert.ok(r.nodes.length >= DRAFT_LIMITS.min, String(r.nodes.length));
  assert.equal(r.dropped.length, 0);
  assert.ok(r.nodes.every(n => n.draft && n.factsReviewed.every(v => v === false)));
});

test('validDraftName: 공백을 뺀 1~30자', () => {
  assert.equal(validDraftName('  축구 '), '축구');
  assert.equal(validDraftName('   '), null);
  assert.equal(validDraftName('가'.repeat(31)), null);
  assert.equal(validDraftName('가'.repeat(30)), '가'.repeat(30));
});

/* ───── 검수 ───── */

const draftNode = () => ({ id: 'u:a', label: 'A', facts: ['f1', 'f2', 'f3'], tags: ['daily_accumulation'], draft: true, factsReviewed: [false, false, false] });

test('confirmFact: 하나씩 확인, 모두 확인되면 draft·factsReviewed가 빠진 일반 노드', () => {
  let n = confirmFact(draftNode(), 0);
  assert.deepEqual(n.factsReviewed, [true, false, false]);
  assert.equal(n.draft, true);
  n = confirmFact(confirmFact(n, 2), 1);
  assert.deepEqual(n, { id: 'u:a', label: 'A', facts: ['f1', 'f2', 'f3'], tags: ['daily_accumulation'] });
});

test('removeFact: 지운 사실은 빠지고, 남은 사실이 모두 확인됐으면 draft 해제, 마지막 사실을 지우면 null', () => {
  const orig = draftNode();
  let n = confirmFact(confirmFact(orig, 0), 2);
  n = removeFact(n, 1);
  assert.deepEqual(n, { id: 'u:a', label: 'A', facts: ['f1', 'f3'], tags: ['daily_accumulation'] });
  assert.deepEqual(orig.facts, ['f1', 'f2', 'f3'], '원본은 바꾸지 않는다');
  let m = removeFact(draftNode(), 0);
  assert.deepEqual(m.facts, ['f2', 'f3']);
  assert.deepEqual(m.factsReviewed, [false, false]);
  m = removeFact(removeFact(m, 0), 0);
  assert.equal(m, null);
});

test('confirmAllFacts: 한 번에 일반 노드로', () => {
  assert.deepEqual(confirmAllFacts(draftNode()), { id: 'u:a', label: 'A', facts: ['f1', 'f2', 'f3'], tags: ['daily_accumulation'] });
});

test('settleDraft: draft가 아닌 노드는 그대로, factsReviewed 길이가 다르면 draft 유지', () => {
  const plain = { id: 'u:b', label: 'B', facts: ['x'], tags: ['t'] };
  assert.equal(settleDraft(plain), plain);
  const n = { ...draftNode(), factsReviewed: [true, true] };
  assert.equal(settleDraft(n).draft, true);
});

test('reviewAfterEdit: 수정 폼으로 고친 사실·새 사실은 확인된 것으로, 그대로 둔 사실은 이전 상태', () => {
  const prev = { ...draftNode(), factsReviewed: [false, true, false] };
  const edited = { ...prev, facts: ['f1', 'f2', 'f3 고침', '새 사실'] };
  const n = reviewAfterEdit(prev, edited);
  assert.deepEqual(n.factsReviewed, [false, true, true, true]);
  assert.equal(n.draft, true);
  // 남은 미확인 사실을 지우면 일반 노드
  const done = reviewAfterEdit(prev, { ...prev, facts: ['f2', 'f3 고침'] });
  assert.deepEqual(done, { id: 'u:a', label: 'A', facts: ['f2', 'f3 고침'], tags: ['daily_accumulation'] });
  // 초안이 아닌 노드는 건드리지 않는다
  const plain = { id: 'u:b', label: 'B', facts: ['x'], tags: ['t'] };
  assert.equal(reviewAfterEdit(plain, plain), plain);
});

test('addDraftNodes·draftNodes: 오버레이 뒤에 붙이고 다른 필드는 그대로', () => {
  const ov = { useCommon: true, nodes: [{ id: 'u:old', label: 'Old', facts: ['x'], tags: ['t'] }], feedbackBoosts: { meso: -0.05 } };
  const next = addDraftNodes(ov, [draftNode()]);
  assert.deepEqual(next.nodes.map(n => n.id), ['u:old', 'u:a']);
  assert.deepEqual(next.feedbackBoosts, { meso: -0.05 });
  assert.equal(ov.nodes.length, 1, '원본은 바꾸지 않는다');
  assert.deepEqual(draftNodes(next).map(n => n.id), ['u:a']);
});

test('startNewInterest: useCommon false, domain = 이름, "(으)로 치면", 중립 테마, 노드는 지우지 않는다', () => {
  const ov = { useCommon: true, nodes: [{ id: 'u:old', label: 'Old', facts: ['x'], tags: ['t'] }], theme: 'maple' };
  assert.deepEqual(startNewInterest(ov, '원신'), { ...ov, useCommon: false, domain: '원신', analogyPrefix: '원신으로 치면', theme: 'neutral' });
  assert.equal(startNewInterest(ov, '축구').analogyPrefix, '축구로 치면');
});

/* ───── 병합 제외(규칙 1) ───── */

test('mergeGraphs: draft 노드는 그래프 노드·태그·엣지 어디에도 없다(검색·근거 제외)', () => {
  const ov = {
    nodes: [
      { id: 'u:draft', label: '초안', facts: ['f'], tags: ['daily_accumulation'], draft: true, factsReviewed: [false] },
      { id: 'u:ok', label: '확인됨', facts: ['f'], tags: ['efficiency_metric'] }
    ],
    edges: [{ from: 'u:draft', to: 'u:ok', rel: 'x' }]
  };
  const g = mergeGraphs(common, ov);
  assert.ok(!g.nodes.some(n => n.id === 'u:draft'));
  assert.ok(g.nodes.some(n => n.id === 'u:ok'));
  assert.equal(g.edges.filter(e => e.source === 'user').length, 0);
  assert.equal(g.sources.userNodes, 1, '내 노드 수에 초안은 세지 않는다');
  assert.equal(g.sources.draftNodes, 1);
  // 새 관심사 모드에서 초안만 있으면 노드도, 쓰이는 태그도 없다
  const only = mergeGraphs(common, { useCommon: false, domain: '축구', nodes: [ov.nodes[0]] });
  assert.deepEqual(only.nodes, []);
  assert.deepEqual(only.tags, []);
});

/* ───── 오버레이 검증 ───── */

test('validateOverlay: draft는 boolean, factsReviewed는 facts와 같은 길이의 boolean 배열', () => {
  const base = { id: 'u:a', label: 'A', facts: ['f1', 'f2'], tags: ['daily_accumulation'] };
  assert.deepEqual(validateOverlay({ nodes: [{ ...base, draft: true, factsReviewed: [false, true] }] }), []);
  assert.deepEqual(validateOverlay({ nodes: [{ ...base, draft: false }] }), []);
  assert.equal(validateOverlay({ nodes: [{ ...base, draft: 'yes', factsReviewed: [false, false] }] }).length, 1);
  assert.equal(validateOverlay({ nodes: [{ ...base, draft: true, factsReviewed: [false] }] }).length, 1);
  assert.equal(validateOverlay({ nodes: [{ ...base, draft: true, factsReviewed: [false, 'no'] }] }).length, 1);
  assert.equal(validateOverlay({ nodes: [{ ...base, draft: true }] }).length, 1, '초안이면 factsReviewed가 있어야 한다');
});

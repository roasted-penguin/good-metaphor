// 그래프 편집 폼(T-202)의 순수 함수: 슬러그, 폼 검증, 오버레이 갱신
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeNodeId, formToNode, nodeToForm, upsertNode, removeNode, setHidden, setBoost,
  tagChoices, SAMPLE_FORM, FORM_LIMITS
} from '../../extension/lib/overlay-form.js';
import { validateOverlay } from '../../extension/lib/stores.js';

/* ───── id 슬러그 ───── */

test('makeNodeId: 라벨의 영문·숫자를 소문자 슬러그로, u: 접두어', () => {
  assert.equal(makeNodeId('My Morning Routine 2', []), 'u:my_morning_routine_2');
  assert.equal(makeNodeId('재획 Routine!', []), 'u:routine');
});

test('makeNodeId: 이미 있는 id면 _2, _3을 붙여 피한다', () => {
  assert.equal(makeNodeId('Routine', ['u:routine']), 'u:routine_2');
  assert.equal(makeNodeId('Routine', ['u:routine', 'u:routine_2']), 'u:routine_3');
});

test('makeNodeId: 라벨에 영문이 없으면 u:n + 짧은 무작위, 겹치면 다시 뽑는다', () => {
  const seq = [0.1, 0.1, 0.7];
  const rand = () => seq.shift();
  const first = makeNodeId('내 아침 루틴', [], () => 0.1);
  assert.match(first, /^u:n[a-z0-9]{4,}$/);
  const second = makeNodeId('내 아침 루틴', [first], rand);
  assert.match(second, /^u:n[a-z0-9]{4,}$/);
  assert.notEqual(second, first);
});

/* ───── 폼 값 → 노드 ───── */

const okForm = { label: '내 아침 루틴', facts: '매일 같은 시간에 한다.\n\n  빠지면 채우기 어렵다.  ', tags: ['daily_accumulation'], aliases: '아침 재획, 출근 전 사냥' };

test('formToNode: 빈 줄·앞뒤 공백을 버리고 노드 모양으로', () => {
  const { node, errors } = formToNode(okForm, { id: 'u:x' });
  assert.deepEqual(errors, {});
  assert.deepEqual(node, {
    id: 'u:x', label: '내 아침 루틴',
    facts: ['매일 같은 시간에 한다.', '빠지면 채우기 어렵다.'],
    tags: ['daily_accumulation'],
    aliases: ['아침 재획', '출근 전 사냥']
  });
});

test('formToNode: 별칭이 비면 aliases 키를 만들지 않는다', () => {
  const { node } = formToNode({ ...okForm, aliases: ' , ' }, { id: 'u:x' });
  assert.equal('aliases' in node, false);
});

test('formToNode: 새 노드는 id를 만들고, 기존 노드는 id와 폼이 모르는 필드를 지킨다', () => {
  const made = formToNode({ ...okForm, label: 'Routine' }, { existingIds: ['u:routine'] });
  assert.equal(made.node.id, 'u:routine_2');
  const prev = { id: 'u:keep', label: '옛 이름', facts: ['f'], tags: ['t'], note: '메모' };
  const kept = formToNode({ ...okForm, label: 'Other' }, { prev });
  assert.equal(kept.node.id, 'u:keep');
  assert.equal(kept.node.note, '메모');
  assert.equal(kept.node.label, 'Other');
});

test('formToNode: 비어 있으면 필드별 짧은 존댓말 오류, node 없음', () => {
  const { node, errors } = formToNode({ label: '  ', facts: '\n ', tags: [], aliases: '' }, { id: 'u:x' });
  assert.equal(node, null);
  assert.equal(errors.label, '이름을 적어 주세요.');
  assert.equal(errors.facts, '사실을 한 줄 이상 적어 주세요.');
  assert.equal(errors.tags, '태그를 하나 이상 골라 주세요.');
  assert.equal(errors.aliases, undefined);
});

test('formToNode: 길이·개수 제한', () => {
  const long = 'ㄱ'.repeat(FORM_LIMITS.label + 1);
  const r = formToNode({
    label: long,
    facts: ['a', 'b', 'c', 'd', 'e', 'f'].join('\n'),
    tags: ['a', 'b', 'c', 'd'],
    aliases: 'ㄴ'.repeat(21)
  }, { id: 'u:x' });
  assert.equal(r.node, null);
  assert.match(r.errors.label, /40자/);
  assert.match(r.errors.facts, /다섯 줄/);
  assert.match(r.errors.tags, /세 개/);
  assert.match(r.errors.aliases, /20자/);
  const r2 = formToNode({ ...okForm, facts: 'ㄷ'.repeat(201) }, { id: 'u:x' });
  assert.match(r2.errors.facts, /200자/);
});

test('formToNode로 만든 노드는 validateOverlay를 통과한다', () => {
  const { node } = formToNode(okForm, { existingIds: [] });
  assert.deepEqual(validateOverlay({ nodes: [node] }), []);
});

test('nodeToForm: 노드 → 폼 값(사실은 줄바꿈, 별칭은 쉼표)', () => {
  assert.deepEqual(nodeToForm({ id: 'u:x', label: 'L', facts: ['a', 'b'], tags: ['t'], aliases: ['x', 'y'] }),
    { label: 'L', facts: 'a\nb', tags: ['t'], aliases: 'x, y' });
  assert.deepEqual(nodeToForm({ id: 'u:x', label: 'L', facts: ['a'], tags: ['t'] }).aliases, '');
});

test('SAMPLE_FORM은 검증을 통과한다', () => {
  assert.deepEqual(formToNode(SAMPLE_FORM, { id: 'u:x' }).errors, {});
});

/* ───── 오버레이 갱신 (원본은 안 바뀌고, 모르는 필드는 남는다) ───── */

const base = () => ({
  schema: 1, useCommon: true, domain: '', hiddenNodeIds: ['meso'],
  nodeBoosts: { 'u:a': 0.1, meso: -0.05 }, feedbackBoosts: { meso: -0.05, 'u:a': -0.05 },
  tags: [{ id: 'u_tag', label: '내 태그' }], edges: [], extra: { keep: true },
  nodes: [{ id: 'u:a', label: 'A', facts: ['f'], tags: ['t'] }]
});

test('upsertNode: 같은 id는 그 자리에서 바꾸고 새 id는 뒤에 붙인다, 나머지 필드 보존', () => {
  const ov = base();
  const a2 = upsertNode(ov, { id: 'u:a', label: 'A2', facts: ['g'], tags: ['t'] });
  assert.equal(a2.nodes.length, 1);
  assert.equal(a2.nodes[0].label, 'A2');
  const b = upsertNode(a2, { id: 'u:b', label: 'B', facts: ['g'], tags: ['t'] });
  assert.deepEqual(b.nodes.map(n => n.id), ['u:a', 'u:b']);
  assert.deepEqual(b.feedbackBoosts, base().feedbackBoosts);
  assert.deepEqual(b.tags, base().tags);
  assert.deepEqual(b.extra, { keep: true });
  assert.equal(ov.nodes[0].label, 'A'); // 원본 그대로
});

test('removeNode: 노드와 그 nodeBoosts 키를 함께 빼고, feedbackBoosts는 그대로', () => {
  const ov = base();
  const r = removeNode(ov, 'u:a');
  assert.deepEqual(r.nodes, []);
  assert.deepEqual(r.nodeBoosts, { meso: -0.05 });
  assert.deepEqual(r.feedbackBoosts, base().feedbackBoosts);
  assert.deepEqual(ov.nodeBoosts, base().nodeBoosts); // 원본 그대로
});

test('setHidden: 숨김 켜고 끄기, 중복 없음', () => {
  const ov = base();
  assert.deepEqual(setHidden(ov, 'meso', true).hiddenNodeIds, ['meso']);
  assert.deepEqual(setHidden(ov, 'auction', true).hiddenNodeIds, ['meso', 'auction']);
  assert.deepEqual(setHidden(ov, 'meso', false).hiddenNodeIds, []);
  assert.deepEqual(ov.hiddenNodeIds, ['meso']);
});

test('setBoost: -0.2~0.2로 자르고 소수 둘째 자리, 0이면 키를 지운다, feedbackBoosts 불변', () => {
  const ov = base();
  assert.equal(setBoost(ov, 'auction', 0.123).nodeBoosts.auction, 0.12);
  assert.equal(setBoost(ov, 'auction', 0.9).nodeBoosts.auction, 0.2);
  assert.equal(setBoost(ov, 'auction', '-0.5').nodeBoosts.auction, -0.2);
  assert.equal('meso' in setBoost(ov, 'meso', 0).nodeBoosts, false);
  assert.deepEqual(setBoost(ov, 'meso', 0.1).feedbackBoosts, base().feedbackBoosts);
  assert.equal(ov.nodeBoosts.meso, -0.05);
});

test('tagChoices: 공통 태그 사전 + 내 태그, id 중복은 한 번만', () => {
  const list = tagChoices([{ id: 'a', label: '가' }, { id: 'b', label: '나' }], [{ id: 'b', label: '나2' }, { id: 'u_c', label: '다' }]);
  assert.deepEqual(list, [
    { id: 'a', label: '가', source: 'common' },
    { id: 'b', label: '나', source: 'common' },
    { id: 'u_c', label: '다', source: 'user' }
  ]);
  assert.deepEqual(tagChoices(undefined, undefined), []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addRecord, removeRecord, setReason, applyFeedback, feedbackKey, FEEDBACK_MAX } from '../../extension/lib/feedback.js';

// 검색 후보(retrieve 결과 모양만 흉내)
const cands = ['a', 'b', 'c', 'd'].map((id, i) => ({ id, label: id.toUpperCase(), score: 1 - i * 0.1 }));
const rec = (over) => ({ id: over.id || Math.random().toString(36).slice(2), ts: over.ts || 1, sentenceHash: 'h1', nodeId: 'a', vote: 'down', ...over });

test('👎: 그 문장에서 그 노드가 빠지고 다음 후보가 1위', () => {
  const r = applyFeedback(cands, [rec({ nodeId: 'a', vote: 'down' })], 'h1', 3);
  assert.deepEqual(r.candidates.map(c => c.id), ['b', 'c', 'd']);
  assert.equal(r.applied, true);
  assert.deepEqual(r.excluded, ['a']);
  assert.equal(r.pinned, null);
});

test('pick: 고른 노드만 후보로 고정된다 (근거 검증은 이 후보로 그대로)', () => {
  const r = applyFeedback(cands, [rec({ nodeId: 'a', vote: 'pick', pickedNodeId: 'c' })], 'h1', 3);
  assert.deepEqual(r.candidates.map(c => c.id), ['c']);
  assert.equal(r.pinned, 'c');
  assert.equal(r.applied, true);
});

test('pick한 노드가 검색 후보에 없으면 고정하지 않는다 (근거 밖 금지, 규칙 1)', () => {
  const r = applyFeedback(cands, [rec({ vote: 'pick', pickedNodeId: 'zzz' })], 'h1', 3);
  assert.equal(r.pinned, null);
  assert.deepEqual(r.candidates.map(c => c.id), ['a', 'b', 'c']);
});

test('다른 문장에는 영향이 없다', () => {
  const r = applyFeedback(cands, [rec({ sentenceHash: 'h2', nodeId: 'a', vote: 'down' })], 'h1', 3);
  assert.deepEqual(r.candidates.map(c => c.id), ['a', 'b', 'c']);
  assert.equal(r.applied, false);
});

test('👍은 후보를 바꾸지 않는다', () => {
  const r = applyFeedback(cands, [rec({ vote: 'up' })], 'h1', 3);
  assert.deepEqual(r.candidates.map(c => c.id), ['a', 'b', 'c']);
  assert.equal(r.applied, false);
});

test('나중 기록이 이긴다: pick한 노드를 나중에 👎하면 고정이 풀리고 빠진다', () => {
  const r = applyFeedback(cands, [
    rec({ ts: 1, vote: 'pick', pickedNodeId: 'c' }),
    rec({ ts: 2, nodeId: 'c', vote: 'down' })
  ], 'h1', 3);
  assert.equal(r.pinned, null);
  assert.deepEqual(r.candidates.map(c => c.id), ['a', 'b', 'd']);
});

test('addRecord: 최근 500건만 남긴다', () => {
  let list = [];
  for (let i = 0; i < FEEDBACK_MAX + 5; i++) list = addRecord(list, rec({ id: 'r' + i, ts: i }));
  assert.equal(FEEDBACK_MAX, 500);
  assert.equal(list.length, 500);
  assert.equal(list[0].id, 'r5');
  assert.equal(list.at(-1).id, 'r504');
});

test('removeRecord(되돌리기): 그 기록만 지우면 원래 후보로 돌아온다', () => {
  const list = addRecord([], rec({ id: 'x', nodeId: 'a', vote: 'down' }));
  const back = removeRecord(list, 'x');
  assert.deepEqual(back, []);
  assert.deepEqual(applyFeedback(cands, back, 'h1', 3).candidates.map(c => c.id), ['a', 'b', 'c']);
});

test('feedbackKey: 그 문장의 기록이 바뀔 때만 바뀐다 (결과 캐시 무효화용)', () => {
  const base = [rec({ id: 'p', sentenceHash: 'h2' })];
  const k0 = feedbackKey(base, 'h1');
  assert.equal(feedbackKey([...base, rec({ id: 'q', sentenceHash: 'h3' })], 'h1'), k0);
  assert.notEqual(feedbackKey([...base, rec({ id: 'r', sentenceHash: 'h1' })], 'h1'), k0);
});

test('feedbackKey: 👍은 후보를 바꾸지 않으니 지문도 바꾸지 않는다 (불필요한 LLM 재호출 방지)', () => {
  const base = [rec({ id: 'p', vote: 'down' })];
  assert.equal(feedbackKey([...base, rec({ id: 'u', vote: 'up' })], 'h1'), feedbackKey(base, 'h1'));
});

test('setReason: 그 기록에만 이유를 붙이고 정해진 값만 받는다', () => {
  const list = [rec({ id: 'x' }), rec({ id: 'y' })];
  const out = setReason(list, 'x', 'forced');
  assert.equal(out.find(r => r.id === 'x').reason, 'forced');
  assert.equal(out.find(r => r.id === 'y').reason, undefined);
  assert.throws(() => setReason(list, 'x', '<script>'), /이유/);
});

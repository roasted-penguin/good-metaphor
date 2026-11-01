import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addRecord, removeRecord, setReason, applyFeedback, feedbackKey, FEEDBACK_MAX, maskSentence, bumpHover, summarizeFeedback, similarMemory } from '../../extension/lib/feedback.js';

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

test('maskSentence: 메일·주소·긴 숫자·전화번호를 가린다', () => {
  assert.equal(
    maskSentence('연락은 hong@example.com 이나 010-1234-5678, 주문번호 20261101로 주세요. https://a.b/c 참고'),
    '연락은 [메일] 이나 [숫자], 주문번호 [숫자]로 주세요. [주소] 참고'
  );
});

test('maskSentence: 1~3자리 숫자는 그대로 둔다', () => {
  const s = '이 약은 최소 4시간을 기다려야 한다.';
  assert.equal(maskSentence(s), s);
});

test('bumpHover: 그날 값이 1 늘어난다', () => {
  assert.deepEqual(bumpHover({}, '2026-11-01'), { '2026-11-01': 1 });
  assert.deepEqual(bumpHover({ '2026-11-01': 2 }, '2026-11-01'), { '2026-11-01': 3 });
});

test('bumpHover: 가장 최근 14일만 남긴다', () => {
  const counts = {};
  for (let d = 1; d <= 15; d++) counts[`2026-10-${String(d).padStart(2, '0')}`] = 1;
  const next = bumpHover(counts, '2026-10-16');
  assert.equal(Object.keys(next).length, 14);
  assert.equal(next['2026-10-01'], undefined);
  assert.equal(next['2026-10-02'], undefined);
  assert.equal(next['2026-10-16'], 1);
});

test('summarizeFeedback: 오늘 포함 지난 7일만 센다', () => {
  // 로컬 정오로 만들어 시간대와 무관하게 날짜가 맞게 한다
  const at = (day) => new Date(2026, 10, day, 12).getTime();
  const records = [
    rec({ ts: at(2), vote: 'up' }),
    rec({ ts: at(3), vote: 'down' }),
    rec({ ts: at(8), vote: 'down' }),
    rec({ ts: at(5), vote: 'pick', pickedNodeId: 'b' }),
    rec({ ts: at(1), vote: 'down' }), // 범위 밖
  ];
  const counts = { '2026-11-01': 5, '2026-11-02': 3, '2026-11-08': 2 };
  assert.deepEqual(summarizeFeedback(records, counts, '2026-11-08'), { hovers: 5, up: 1, down: 2, pick: 1 });
});

test('summarizeFeedback: 빈 입력이면 모두 0', () => {
  assert.deepEqual(summarizeFeedback([], {}, '2026-11-08'), { hovers: 0, up: 0, down: 0, pick: 0 });
});

// ── 비슷한 문장 메모리 (T-130) ──

test('similarMemory: 다른 문장의 👎만 넣고 지금 문장·벡터 없는 기록·👍은 뺀다', () => {
  const v = [0.1, 0.2];
  const m = similarMemory([
    rec({ sentenceHash: 'h1', nodeId: 'a', vote: 'down', vec: v }),
    rec({ sentenceHash: 'h2', nodeId: 'b', vote: 'down', vec: v }),
    rec({ sentenceHash: 'h3', nodeId: 'c', vote: 'down' }),
    rec({ sentenceHash: 'h4', nodeId: 'd', vote: 'up', vec: v })
  ], 'h1');
  assert.deepEqual(m, [{ vec: v, nodeId: 'b', vote: 'down' }]);
});

test('similarMemory: pick은 pickedNodeId를 nodeId로 쓴다', () => {
  const v = [1, 0];
  const m = similarMemory([rec({ sentenceHash: 'h2', nodeId: 'a', vote: 'pick', pickedNodeId: 'c', vec: v })], 'h1');
  assert.deepEqual(m, [{ vec: v, nodeId: 'c', vote: 'pick' }]);
});

test('similarMemory: 같은 문장·노드는 나중 기록이 이긴다, 고정은 문장마다 하나', () => {
  const v = [1, 0];
  // pick c 다음에 c를 👎 → 그 문장의 c는 down만
  const m1 = similarMemory([
    rec({ ts: 2, sentenceHash: 'h2', nodeId: 'c', vote: 'down', vec: v }),
    rec({ ts: 1, sentenceHash: 'h2', nodeId: 'a', vote: 'pick', pickedNodeId: 'c', vec: v })
  ], 'h1');
  assert.deepEqual(m1, [{ vec: v, nodeId: 'c', vote: 'down' }]);
  // pick b 다음에 pick c → c만 고정
  const m2 = similarMemory([
    rec({ ts: 1, sentenceHash: 'h2', nodeId: 'a', vote: 'pick', pickedNodeId: 'b', vec: v }),
    rec({ ts: 2, sentenceHash: 'h2', nodeId: 'a', vote: 'pick', pickedNodeId: 'c', vec: v })
  ], 'h1');
  assert.deepEqual(m2, [{ vec: v, nodeId: 'c', vote: 'pick' }]);
  // 서로 다른 문장의 같은 노드 👎는 각각 남는다
  const m3 = similarMemory([
    rec({ sentenceHash: 'h2', nodeId: 'a', vote: 'down', vec: v }),
    rec({ sentenceHash: 'h3', nodeId: 'a', vote: 'down', vec: [0, 1] })
  ], 'h1');
  assert.equal(m3.length, 2);
});

test('similarMemory: 기록이 없으면 빈 배열', () => {
  assert.deepEqual(similarMemory([], 'h1'), []);
  assert.deepEqual(similarMemory(undefined, 'h1'), []);
});

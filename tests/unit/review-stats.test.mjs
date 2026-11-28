// 검수 기록(T-229): 초안 사실을 확인·지움·고침한 수
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewDelta, addReviewStats, normalizeReviewStats, reviewStatsLine } from '../../extension/lib/review-stats.js';
import { confirmFact, confirmAllFacts, removeFact, reviewAfterEdit } from '../../extension/lib/draft.js';

const draft = (facts, rv = facts.map(() => false)) => ({ id: 'u:a', label: '가', facts, tags: ['threshold_req'], draft: true, factsReviewed: rv });

test('reviewDelta: 사실 확인·모두 확인은 미확인 사실만 확인으로 센다', () => {
  const n = draft(['하나', '둘', '셋'], [true, false, false]);
  assert.deepEqual(reviewDelta(n, confirmFact(n, 1)), { confirmed: 1, deleted: 0, edited: 0 });
  assert.deepEqual(reviewDelta(n, confirmFact(n, 0)), { confirmed: 0, deleted: 0, edited: 0 }, '이미 확인한 사실은 다시 세지 않는다');
  // 모두 확인하면 draft가 풀린다 → 남은 미확인 2개 확인
  assert.deepEqual(reviewDelta(n, confirmAllFacts(n)), { confirmed: 2, deleted: 0, edited: 0 });
});

test('reviewDelta: 사실 지우기·노드 지우기는 미확인 사실을 지움으로', () => {
  const n = draft(['하나', '둘'], [false, false]);
  assert.deepEqual(reviewDelta(n, removeFact(n, 0)), { confirmed: 0, deleted: 1, edited: 0 });
  // 마지막 사실을 지우면 removeFact가 null(노드 지움)
  const one = draft(['하나']);
  assert.deepEqual(reviewDelta(one, removeFact(one, 0)), { confirmed: 0, deleted: 1, edited: 0 });
  assert.deepEqual(reviewDelta(draft(['하나', '둘'], [true, false]), null), { confirmed: 0, deleted: 1, edited: 0 });
  // 확인된 사실 하나만 남기고 미확인을 지우면 draft가 풀린다: 지움 1, 확인 0
  const m = draft(['하나', '둘'], [true, false]);
  assert.deepEqual(reviewDelta(m, removeFact(m, 1)), { confirmed: 0, deleted: 1, edited: 0 });
});

test('reviewDelta: 수정 폼으로 고친 미확인 사실은 고침, 그대로 둔 미확인은 세지 않음, 새로 쓴 사실은 세지 않음', () => {
  const prev = draft(['하나', '둘', '셋']);
  const formed = { id: 'u:a', label: '가', facts: ['하나', '고친 둘', '넷'], tags: ['threshold_req'] };
  const next = reviewAfterEdit(prev, formed);
  assert.deepEqual(reviewDelta(prev, next, 'edit'), { confirmed: 0, deleted: 0, edited: 2 });
});

test('reviewDelta: 초안이 아닌 노드는 세지 않는다', () => {
  assert.deepEqual(reviewDelta({ id: 'u:b', facts: ['x'] }, null), { confirmed: 0, deleted: 0, edited: 0 });
  assert.deepEqual(reviewDelta(undefined, null), { confirmed: 0, deleted: 0, edited: 0 });
});

test('addReviewStats·reviewStatsLine: 더하고, 시작 시각은 처음 한 번, 비율은 반올림, 없으면 빈 줄', () => {
  assert.equal(reviewStatsLine(null), '');
  let s = addReviewStats(null, { confirmed: 0, deleted: 0, edited: 0 }, 5);
  assert.equal(s.since, null, '센 것이 없으면 시작하지 않는다');
  s = addReviewStats(s, { confirmed: 5, deleted: 2, edited: 1 }, 10);
  s = addReviewStats(s, { confirmed: 1, deleted: 0, edited: 0 }, 20);
  assert.deepEqual(s, { confirmed: 6, deleted: 2, edited: 1, since: 10 });
  assert.equal(reviewStatsLine(s), '검수 기록: 사실 9개 중 지움 2개(22%) · 고침 1개(11%) · 확인 6개. 이 기기에만 남아요.');
  // 망가진 저장값은 0으로
  assert.deepEqual(normalizeReviewStats({ confirmed: -3, deleted: 'x', edited: 2.7 }), { confirmed: 0, deleted: 0, edited: 2, since: null });
});

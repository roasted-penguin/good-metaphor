import { test } from 'node:test';
import assert from 'node:assert/strict';
import { embedEach } from '../../extension/lib/embed-each.js';

// q8 모델은 함께 묶인 문장에 따라 벡터가 달라진다(T-128). 그래서 항상 한 문장씩 넣는다
test('embedEach: 한 문장씩 run을 부르고 순서대로 벡터를 모은다', async () => {
  const calls = [];
  const run = async batch => { calls.push(batch); return batch.map(t => [t.length]); };
  const out = await embedEach(['가', '나다', '라마바'], run);
  assert.deepEqual(calls, [['가'], ['나다'], ['라마바']]);
  assert.deepEqual(out, [[1], [2], [3]]);
});

test('embedEach: 빈 목록이면 부르지 않는다', async () => {
  let n = 0;
  assert.deepEqual(await embedEach([], async () => { n++; return []; }), []);
  assert.equal(n, 0);
});

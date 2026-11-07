import { test } from 'node:test';
import assert from 'node:assert/strict';
import { touch, pruneVecCache } from '../../extension/lib/vec-cache.js';

// 키 순서(삽입 순서 = LRU 순서, 앞이 가장 오래 안 쓴 것)
const keys = m => [...m.keys()];
const mk = list => new Map(list.map(k => [k, [k.length]]));

test('touch: 주어진 키를 끝으로 옮기고 없는 키는 무시', () => {
  const c = mk(['e|a', 'e|b', 'e|c']);
  touch(c, ['e|a', 'e|zz']);
  assert.deepEqual(keys(c), ['e|b', 'e|c', 'e|a']);
  assert.deepEqual(c.get('e|a'), [3]);
});

test('touch: 여러 키는 준 순서대로 끝에 붙는다', () => {
  const c = mk(['e|a', 'e|b', 'e|c', 'e|d']);
  touch(c, ['e|b', 'e|a']);
  assert.deepEqual(keys(c), ['e|c', 'e|d', 'e|b', 'e|a']);
});

test('prune: 현재 embedderId가 아닌 항목은 지운다', () => {
  const c = mk(['old|a', 'e|b', 'fallback|c', 'e|d']);
  const r = pruneVecCache(c, { embedderId: 'e' });
  assert.deepEqual(keys(r.cache), ['e|b', 'e|d']);
  assert.equal(r.removed, 2);
});

test('prune: 접두어가 같아도 "|" 경계가 아니면 다른 임베더', () => {
  const c = mk(['e|a', 'e2|b']);
  const r = pruneVecCache(c, { embedderId: 'e' });
  assert.deepEqual(keys(r.cache), ['e|a']);
});

test('prune: max를 넘으면 앞(오래된 것)부터 지운다', () => {
  const c = mk(['e|1', 'e|2', 'e|3', 'e|4', 'e|5']);
  const r = pruneVecCache(c, { embedderId: 'e', max: 3 });
  assert.deepEqual(keys(r.cache), ['e|3', 'e|4', 'e|5']);
  assert.equal(r.removed, 2);
});

test('prune: keep에 든 키는 오래돼도 남기고 그다음 오래된 것을 지운다', () => {
  const c = mk(['e|1', 'e|2', 'e|3', 'e|4', 'e|5']);
  const r = pruneVecCache(c, { embedderId: 'e', max: 3, keep: new Set(['e|1']) });
  assert.deepEqual(keys(r.cache), ['e|1', 'e|4', 'e|5']);
  assert.equal(r.removed, 2);
});

test('prune: keep만으로 max를 넘으면 keep은 모두 남기고 나머지만 지운다', () => {
  const c = mk(['e|1', 'e|2', 'e|3', 'e|4']);
  const r = pruneVecCache(c, { embedderId: 'e', max: 2, keep: new Set(['e|1', 'e|3', 'e|4']) });
  assert.deepEqual(keys(r.cache), ['e|1', 'e|3', 'e|4']);
  assert.equal(r.removed, 1);
});

test('prune: 다른 embedderId 삭제와 상한을 함께 적용', () => {
  const c = mk(['x|1', 'e|2', 'x|3', 'e|4', 'e|5']);
  const r = pruneVecCache(c, { embedderId: 'e', max: 2 });
  assert.deepEqual(keys(r.cache), ['e|4', 'e|5']);
  assert.equal(r.removed, 3);
});

test('prune: 원본 Map은 바뀌지 않고 새 Map을 돌려준다', () => {
  const c = mk(['x|1', 'e|2', 'e|3']);
  const r = pruneVecCache(c, { embedderId: 'e', max: 1 });
  assert.notEqual(r.cache, c);
  assert.deepEqual(keys(c), ['x|1', 'e|2', 'e|3']);
  assert.deepEqual(keys(r.cache), ['e|3']);
});

test('prune: 지울 것이 없으면 removed 0, 순서 그대로', () => {
  const c = mk(['e|1', 'e|2']);
  const r = pruneVecCache(c, { embedderId: 'e' });
  assert.equal(r.removed, 0);
  assert.deepEqual(keys(r.cache), ['e|1', 'e|2']);
});

test('prune: 기본 상한은 2000', () => {
  const c = mk(Array.from({ length: 2005 }, (_, i) => `e|${i}`));
  const r = pruneVecCache(c, { embedderId: 'e' });
  assert.equal(r.cache.size, 2000);
  assert.equal(r.removed, 5);
  assert.equal(keys(r.cache)[0], 'e|5');
});

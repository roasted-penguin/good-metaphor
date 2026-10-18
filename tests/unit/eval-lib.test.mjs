import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scoreCases, mixedSetting, regressions } from '../../tools/eval-lib.mjs';

const read = p => JSON.parse(readFileSync(p, 'utf8'));
const common = read('extension/data/common/maplestory.json');
const admin = read('extension/config/admin.json');
const evalSet = read('tools/eval-set.json');
const holdout = read('tools/eval-holdout.json');

test('scoreCases: hit@1·hit@3와 그룹별 hit@1을 센다', () => {
  const cases = [
    { sentence: '가', expectNodes: ['a'], group: 'finance' },
    { sentence: '나', expectNodes: ['b'], group: 'finance' },
    { sentence: '다', expectNodes: ['c'] }
  ];
  const ranks = { 가: ['a', 'x', 'y'], 나: ['x', 'b', 'y'], 다: ['c', 'x', 'y'] };
  const r = scoreCases(cases, (c) => ranks[c.sentence]);
  assert.equal(r.n, 3);
  assert.equal(r.hit1, 2);
  assert.equal(r.hit3, 3);
  assert.deepEqual(r.groups, { finance: { hit1: 1, n: 2 } });
  assert.equal(r.misses.length, 1);
  assert.equal(r.misses[0].sentence, '나');
  assert.deepEqual(r.misses[0].got, ['x', 'b', 'y']);
});

test('평가셋의 금융 그룹은 T-113에서 틀린 5문장이다', () => {
  const fin = evalSet.filter(c => c.group === 'finance').map(c => c.sentence.slice(0, 3));
  assert.deepEqual(fin.sort(), ['Lev', '누진세', '레버리', '백화점', '복권의'].sort());
});

test('검증셋: 10문장 이상, 금융 3개 이상, 그래프에 있는 id만, 본 평가셋과 겹치지 않음', () => {
  const nodeIds = new Set(common.nodes.map(n => n.id));
  const tagIds = new Set(common.tags.map(t => t.id));
  const evalSentences = new Set(evalSet.map(c => c.sentence));
  assert.ok(holdout.length >= 10, `검증셋 ${holdout.length}문장`);
  assert.ok(holdout.filter(c => c.group === 'finance').length >= 3);
  for (const c of holdout) {
    assert.ok(c.expectNodes.length && c.expectNodes.every(id => nodeIds.has(id)), c.sentence);
    assert.ok(tagIds.has(c.expectTag), c.sentence);
    assert.ok(!evalSentences.has(c.sentence), c.sentence);
  }
});

test('mixedSetting: 평가 도구의 혼합 설정은 admin.json retrieval을 그대로 쓴다', () => {
  const s = mixedSetting(admin);
  for (const [k, v] of Object.entries(admin.retrieval)) assert.deepEqual(s[k], v, k);
});

test('regressions: 지켜야 할 문장 중 hit@1을 놓친 것만 돌려준다', () => {
  const cases = [{ sentence: '가', expectNodes: ['a'] }, { sentence: '나', expectNodes: ['b'] }, { sentence: '다', expectNodes: ['c'] }];
  const r = scoreCases(cases, c => ({ 가: ['a'], 나: ['x'], 다: ['x'] })[c.sentence]);
  assert.deepEqual(regressions(['가', '나'], r), ['나']);
  assert.deepEqual(regressions([], r), []);
});

test('회귀 가드 목록의 문장은 모두 평가셋·검증셋에 있다', () => {
  const guard = read('tools/eval-guard.json');
  const all = new Set([...evalSet, ...holdout].map(c => c.sentence));
  assert.ok(guard.length > 0);
  assert.equal(new Set(guard).size, guard.length, '중복');
  for (const s of guard) assert.ok(all.has(s), s);
});

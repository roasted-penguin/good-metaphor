// 대체 임베더 기준선 비교(T-179) 순수 함수
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baselineRow, baselineRows, compareBaseline, baselineMetaWarnings, baselineFailCount, baselineReportLines } from '../../tools/eval-lib.mjs';

const hitCase = (sentence, expectNodes) => ({ sentence, expectNodes });

test('baselineRow: 일반 문장은 1위·상위 3개·hit@1·hit@3을 남긴다', () => {
  assert.deepEqual(baselineRow(hitCase('가', ['a']), ['x', 'a', 'y', 'z']),
    { sentence: '가', kind: 'hit', top3: ['x', 'a', 'y'], hit1: false, hit3: true });
  assert.deepEqual(baselineRow(hitCase('나', ['a', 'b']), ['b', 'x']),
    { sentence: '나', kind: 'hit', top3: ['b', 'x'], hit1: true, hit3: true });
});

test('baselineRow: 점수 객체 순위도 id만 남긴다', () => {
  const r = baselineRow(hitCase('가', ['a']), [{ id: 'a', score: 0.3 }, { id: 'b', score: 0.2 }]);
  assert.deepEqual(r.top3, ['a', 'b']);
  assert.equal(r.hit1, true);
});

test('baselineRow: 비유 없음 문장은 맞고 틀림 없이 순위만', () => {
  assert.deepEqual(baselineRow(hitCase('다', []), ['x', 'y', 'z']), { sentence: '다', kind: 'noMatch', top3: ['x', 'y', 'z'] });
});

test('baselineRow: 음성 문장은 1위가 금지 노드가 아니면 hit1 = 통과', () => {
  const c = { sentence: '라', expectNodes: [], forbidNodes: ['tax'] };
  assert.deepEqual(baselineRow(c, ['meso', 'tax']), { sentence: '라', kind: 'negative', top3: ['meso', 'tax'], hit1: true });
  assert.equal(baselineRow(c, ['tax', 'meso']).hit1, false);
});

test('baselineRows: 같은 문장이 두 번 있으면 던진다(문장이 비교 열쇠)', () => {
  const cases = [hitCase('가', ['a']), hitCase('가', ['a'])];
  assert.throws(() => baselineRows(cases, () => ['a']), /가/);
});

const row = (sentence, top3, hit1, hit3 = hit1) => ({ sentence, kind: 'hit', top3, hit1, hit3 });

test('compareBaseline: 새로 틀림·새로 맞음·1위 바뀜·상위 3 잃음/얻음을 가른다', () => {
  const base = { s: [
    row('잃음', ['a', 'b', 'c'], true),        // 1위 맞음 → 틀림 (실패 대상)
    row('얻음', ['x', 'y', 'z'], false, false), // 틀림 → 1위 맞음
    row('같음', ['a', 'b', 'c'], true),
    row('3위밖', ['x', 'a', 'c'], false, true), // 상위 3 안 → 밖
    row('3위안', ['x', 'y', 'z'], false, false) // 상위 3 밖 → 안
  ] };
  const cur = { s: [
    row('잃음', ['b', 'a', 'c'], false, true),
    row('얻음', ['a', 'y', 'z'], true),
    row('같음', ['a', 'c', 'b'], true),
    row('3위밖', ['x', 'y', 'z'], false, false),
    row('3위안', ['y', 'a', 'z'], false, true)
  ] };
  const d = compareBaseline(base, cur).s;
  assert.deepEqual(d.newlyWrong.map(x => x.sentence), ['잃음']);
  assert.deepEqual(d.newlyRight.map(x => x.sentence), ['얻음']);
  // 1위 바뀜은 맞고 틀림과 상관없이 모두(같음은 2·3위만 바뀌어 빠진다)
  assert.deepEqual(d.top1Changed.map(x => x.sentence), ['잃음', '얻음', '3위안']);
  assert.deepEqual(d.top3Lost.map(x => x.sentence), ['3위밖']);
  assert.deepEqual(d.top3Gained.map(x => x.sentence), ['얻음', '3위안']);
  assert.deepEqual(d.newlyWrong[0], { sentence: '잃음', before: 'a', after: 'b' });
  assert.equal(baselineFailCount(compareBaseline(base, cur)), 1);
});

test('compareBaseline: 음성 문장 통과 → 실패도 새로 틀림, 비유 없음 문장은 1위 바뀜만', () => {
  const base = { s: [
    { sentence: '음성', kind: 'negative', top3: ['meso'], hit1: true },
    { sentence: '없음', kind: 'noMatch', top3: ['a', 'b', 'c'] }
  ] };
  const cur = { s: [
    { sentence: '음성', kind: 'negative', top3: ['tax'], hit1: false },
    { sentence: '없음', kind: 'noMatch', top3: ['b', 'a', 'c'] }
  ] };
  const d = compareBaseline(base, cur).s;
  assert.deepEqual(d.newlyWrong.map(x => x.sentence), ['음성']);
  assert.deepEqual(d.top1Changed.map(x => x.sentence), ['음성', '없음']);
  assert.deepEqual(d.top3Lost, []);
});

test('compareBaseline: 더해지거나 빠진 문장·셋은 따로 알리고 실패로 치지 않는다', () => {
  const base = { s: [row('옛', ['a'], true)], 옛셋: [row('x', ['a'], true)] };
  const cur = { s: [row('새', ['a'], false)], 새셋: [row('y', ['a'], true)] };
  const cmp = compareBaseline(base, cur);
  assert.deepEqual(cmp.s.added, ['새']);
  assert.deepEqual(cmp.s.removed, ['옛']);
  assert.deepEqual(cmp.s.newlyWrong, []);
  assert.equal(cmp.옛셋.missingSet, true);
  assert.deepEqual(cmp.새셋.added, ['y']);
  assert.equal(baselineFailCount(cmp), 0);
});

test('compareBaseline: 같으면 바뀐 것 없음', () => {
  const base = { s: [row('가', ['a', 'b'], true)] };
  const d = compareBaseline(base, structuredClone(base)).s;
  for (const k of ['newlyWrong', 'newlyRight', 'top1Changed', 'top3Lost', 'top3Gained', 'added', 'removed']) assert.deepEqual(d[k], [], k);
});

test('baselineMetaWarnings: 임베더 id·그래프·태그 판본이 다르면 경고', () => {
  const meta = { embedderId: 'fb-v2', tagsVersion: 't1', graphs: { maplestory: 'g1', restaurant: 'r1' } };
  assert.deepEqual(baselineMetaWarnings(meta, structuredClone(meta)), []);
  const w = baselineMetaWarnings(meta, { embedderId: 'fb-v3', tagsVersion: 't2', graphs: { maplestory: 'g2', restaurant: 'r1' } });
  assert.equal(w.length, 3);
  assert.match(w[0], /fb-v2.*fb-v3/);
  assert.match(w.join(' '), /t1.*t2/);
  assert.match(w.join(' '), /maplestory.*g1.*g2/);
});

test('baselineReportLines: 셋별로 바뀐 문장을 줄로, 없으면 한 줄', () => {
  const base = { s: [row('가', ['a', 'b', 'c'], true)], t: [row('나', ['a'], true)] };
  const cur = { s: [row('가', ['b', 'a', 'c'], false, true)], t: [row('나', ['a'], true)] };
  const lines = baselineReportLines(compareBaseline(base, cur));
  const text = lines.join('\n');
  assert.match(text, /\[s\]/);
  assert.match(text, /새로 틀림.*가.*a → b/);
  assert.match(text, /\[t\] 바뀐 것 없음/);
});

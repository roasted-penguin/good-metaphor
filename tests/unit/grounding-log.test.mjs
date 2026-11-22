// 근거 검사 실사용 오탐률 기록 (T-146). 기기 안 기록·주간 집계·오탐 표시·운영자 샘플
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeGroundingEntry, addGroundingEntry, bumpGroundingCount, flagGroundingEntry, summarizeGrounding,
  formatGroundingStats, groundingSamples, filterGroundingSamples, summarizeGroundingSamples,
  GROUNDING_LOG_MAX, GROUNDING_TEXT_MAX, GROUNDING_SAMPLE_MAX, FALSE_POSITIVE
} from '../../extension/lib/grounding-log.js';
import { localDay } from '../../extension/lib/feedback.js';

const terms = [{ term: '나쁜말', variants: ['나 쁜 말'], status: '승인' }];
const TODAY = '2026-11-09';
const at = (day, h = 12) => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d, h).getTime(); };
const raw = over => ({
  id: 'g1', ts: at(TODAY), reason: 'number-outside', nodeId: 'weekly-boss', interest: 'maplestory',
  sentence: '이 적금은 한 달에 한 번만 넣을 수 있다.', analogy: '메이플로 치면 일주일에 7번만 입장하는 것과 같아요.', ...over
});
const entry = over => makeGroundingEntry(raw(over), terms);

/* ───── 기록 한 건 ───── */

test('makeGroundingEntry: 모양은 { id, ts, reason, nodeId, interest, sentenceMasked, analogyMasked }, 원문 필드는 없다', () => {
  const e = entry({ sentence: '연락처 010-1234-5678 로 물으면 a@b.com 에서 답한다.', analogy: '메이플로 치면 2026년 메소 1234567개 같아요.' });
  assert.deepEqual(Object.keys(e).sort(), ['analogyMasked', 'id', 'interest', 'nodeId', 'reason', 'sentenceMasked', 'ts']);
  assert.equal(e.sentenceMasked, '연락처 [숫자] 로 물으면 [메일] 에서 답한다.');
  assert.equal(e.analogyMasked, '메이플로 치면 [숫자]년 메소 [숫자]개 같아요.');
  assert.ok(!JSON.stringify(e).includes('010-1234'));
});

test('makeGroundingEntry: 문장·비유는 가린 뒤 각 200자로 자른다', () => {
  const long = '가'.repeat(500);
  const e = entry({ sentence: long, analogy: long });
  assert.equal([...e.sentenceMasked].length, GROUNDING_TEXT_MAX);
  assert.equal([...e.analogyMasked].length, GROUNDING_TEXT_MAX);
});

test('makeGroundingEntry: 금칙어가 든 비유·문장은 기록하지 않는다(규칙 11, 우회 표기 포함)', () => {
  assert.equal(entry({ analogy: '메이플로 치면 나 쁜 말 같아요.' }), null);
  assert.equal(entry({ sentence: '나쁜말이 섞인 문장이에요.' }), null);
  assert.ok(entry({}));
});

test('makeGroundingEntry: 이유가 없으면 기록하지 않는다', () => {
  assert.equal(entry({ reason: '' }), null);
  assert.equal(entry({ reason: undefined }), null);
});

test('addGroundingEntry: 뒤에 붙이고 300건 상한(오래된 것부터 버림), null이면 그대로', () => {
  let log = [];
  for (let i = 0; i < GROUNDING_LOG_MAX + 5; i++) log = addGroundingEntry(log, entry({ id: 'g' + i, ts: i }));
  assert.equal(log.length, GROUNDING_LOG_MAX);
  assert.equal(log[0].id, 'g5');
  assert.equal(log.at(-1).id, 'g' + (GROUNDING_LOG_MAX + 4));
  assert.equal(addGroundingEntry(log, null), log);
});

/* ───── 날짜별 개수(분모) ───── */

test('bumpGroundingCount: 날짜별 { checked, hidden }, 숨김이면 둘 다 오르고 14일만 남긴다', () => {
  let c = {};
  c = bumpGroundingCount(c, TODAY, false);
  c = bumpGroundingCount(c, TODAY, true);
  c = bumpGroundingCount(c, TODAY, false);
  assert.deepEqual(c[TODAY], { checked: 3, hidden: 1 });
  for (let d = 1; d <= 20; d++) c = bumpGroundingCount(c, `2026-10-${String(d).padStart(2, '0')}`, false);
  assert.equal(Object.keys(c).length, 14);
  assert.ok(c[TODAY]);
});

/* ───── 오탐 표시 ───── */

test('flagGroundingEntry: 그 기록에만 userFlag false-positive, null이면 표시를 뗀다', () => {
  const log = [entry({ id: 'a' }), entry({ id: 'b' })];
  const flagged = flagGroundingEntry(log, 'b', FALSE_POSITIVE);
  assert.equal(flagged[0].userFlag, undefined);
  assert.equal(flagged[1].userFlag, 'false-positive');
  assert.equal(log[1].userFlag, undefined, '원본은 바꾸지 않는다');
  const cleared = flagGroundingEntry(flagged, 'b', null);
  assert.equal('userFlag' in cleared[1], false);
  assert.throws(() => flagGroundingEntry(log, 'a', 'whatever'));
});

/* ───── 주간 집계 ───── */

test('summarizeGrounding: 최근 7일만, 비율·이유별·오탐 표시 수·최근 숨김(최신순)', () => {
  const log = [
    entry({ id: 'old', ts: at('2026-11-01'), reason: 'fact-mismatch' }), // 8일 전: 빠짐
    entry({ id: 'a', ts: at('2026-11-03'), reason: 'fact-mismatch' }),
    entry({ id: 'b', ts: at(TODAY, 9), reason: 'number-outside' }),
    { ...entry({ id: 'c', ts: at(TODAY, 10), reason: 'number-outside' }), userFlag: FALSE_POSITIVE }
  ];
  const counts = { '2026-11-01': { checked: 5, hidden: 1 }, '2026-11-03': { checked: 4, hidden: 1 }, [TODAY]: { checked: 6, hidden: 2 } };
  const st = summarizeGrounding(log, counts, TODAY);
  assert.equal(st.checked, 10);
  assert.equal(st.hidden, 3);
  assert.equal(st.percent, 30);
  assert.deepEqual(st.reasons, { 'fact-mismatch': 1, 'number-outside': 2 });
  assert.equal(st.flagged, 1);
  assert.deepEqual(st.recent.map(e => e.id), ['c', 'b', 'a']);
  assert.equal(st.total, 4, '지우기 버튼용: 기록 전체 건수');
});

test('summarizeGrounding: 비유가 없으면 비율은 null(0 나누기 없음), 기록이 상한으로 밀려도 개수는 카운터 기준', () => {
  const empty = summarizeGrounding([], {}, TODAY);
  assert.deepEqual({ checked: empty.checked, hidden: empty.hidden, percent: empty.percent, flagged: empty.flagged }, { checked: 0, hidden: 0, percent: null, flagged: 0 });
  assert.deepEqual(empty.recent, []);
  const st = summarizeGrounding([], { [TODAY]: { checked: 3, hidden: 3 } }, TODAY);
  assert.equal(st.percent, 100);
  // 예전 모양(숫자)이나 깨진 값은 0으로 본다
  assert.equal(summarizeGrounding([], { [TODAY]: 5 }, TODAY).checked, 0);
});

test('summarizeGrounding: recent 개수 상한', () => {
  const log = Array.from({ length: 12 }, (_, i) => entry({ id: 'e' + i, ts: at(TODAY) + i }));
  assert.equal(summarizeGrounding(log, {}, TODAY).recent.length, 5);
  assert.equal(summarizeGrounding(log, {}, TODAY, { recent: 2 }).recent.length, 2);
});

test('formatGroundingStats: 한 줄 요약, 비유가 없으면 안내 문구', () => {
  assert.equal(formatGroundingStats(summarizeGrounding([], {}, TODAY)), '지난 7일 근거 검사를 거친 비유가 아직 없어요.');
  const log = [entry({ id: 'a', reason: 'fact-mismatch' }), { ...entry({ id: 'b' }), userFlag: FALSE_POSITIVE }];
  const line = formatGroundingStats(summarizeGrounding(log, { [TODAY]: { checked: 8, hidden: 2 } }, TODAY));
  assert.equal(line, '지난 7일 · 비유 8개 중 근거 검사로 숨김 2개 (25%) · 사실 불일치 1 · 근거 밖 숫자 1 · 괜찮았다고 표시 1');
});

/* ───── 운영자 샘플 ───── */

test('groundingSamples: 그 관심사·공통 노드·7일만, 오탐 표시 우선 뒤 최신순, 가린 텍스트만, 50건 상한', () => {
  const log = [
    entry({ id: 'old', ts: at('2026-11-01') }),
    entry({ id: 'other', interest: 'restaurant', nodeId: 'menu' }),
    entry({ id: 'user', nodeId: 'u:mine' }),
    entry({ id: 'a', ts: at(TODAY, 8), sentence: '연락처 010-1234-5678 문장이에요.' }),
    { ...entry({ id: 'f', ts: at(TODAY, 7), reason: 'fact-mismatch' }), userFlag: FALSE_POSITIVE },
    entry({ id: 'b', ts: at(TODAY, 9) })
  ];
  const s = groundingSamples(log, { interest: 'maplestory', nodeIds: new Set(['weekly-boss']), blockTerms: terms, today: TODAY });
  assert.equal(s.length, 3);
  assert.equal(s[0].userFlag, 'false-positive');
  assert.equal(s[0].reason, 'fact-mismatch');
  assert.deepEqual(Object.keys(s[1]).sort(), ['analogy', 'day', 'nodeId', 'reason', 'sentence']);
  assert.equal(s[1].day, TODAY);
  assert.equal(s[2].sentence, '연락처 [숫자] 문장이에요.');
  const str = JSON.stringify(s);
  for (const bad of ['u:mine', 'menu', '010-1234', '"id"', '"ts"']) assert.ok(!str.includes(bad), bad);

  const many = Array.from({ length: 80 }, (_, i) => entry({ id: 'm' + i, ts: at(TODAY) + i }));
  assert.equal(groundingSamples(many, { interest: 'maplestory', today: TODAY }).length, GROUNDING_SAMPLE_MAX);
});

test('filterGroundingSamples: 내보낸 뒤 늘어난 금칙어·모르는 노드를 다시 거른다', () => {
  const samples = [
    { reason: 'number-outside', nodeId: 'weekly-boss', sentence: '문장', analogy: '나 쁜 말 비유', day: TODAY },
    { reason: 'number-outside', nodeId: 'gone', sentence: '문장', analogy: '비유', day: TODAY },
    { reason: 'fact-mismatch', nodeId: 'weekly-boss', sentence: '문장', analogy: '비유', day: TODAY }
  ];
  const out = filterGroundingSamples(samples, { nodeIds: new Set(['weekly-boss']), blockTerms: terms });
  assert.deepEqual(out.map(s => s.reason), ['fact-mismatch']);
});

test('summarizeGroundingSamples: 이유별 개수·오탐 표시 수', () => {
  const st = summarizeGroundingSamples([
    { reason: 'number-outside', userFlag: FALSE_POSITIVE }, { reason: 'number-outside' }, { reason: 'fact-mismatch' }
  ]);
  assert.deepEqual(st, { total: 3, reasons: { 'number-outside': 2, 'fact-mismatch': 1 }, flagged: 1 });
  assert.deepEqual(summarizeGroundingSamples(undefined), { total: 0, reasons: {}, flagged: 0 });
});

test('localDay 기준: 기록 ts의 로컬 날짜로 7일을 가른다', () => {
  assert.equal(localDay(at(TODAY)), TODAY);
});

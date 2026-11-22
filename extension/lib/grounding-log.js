// 근거 검사 실사용 오탐률 기록 (T-146). 순수 함수만 둔다. 저장은 background.js가 chrome.storage.local에.
// 서버가 생기기 전까지는 이 기기에만 모은다(D-7). 서버로 보내지 않는다.
//
// groundingLog: 근거 검사(T-123·T-143·T-145)로 숨긴 비유 한 건씩
//   { id, ts, reason: 'fact-mismatch'|'number-outside', nodeId, interest, sentenceMasked, analogyMasked, userFlag? }
//   문장·비유는 maskSentence로 가린 뒤 각 200자까지만, 300건 상한(오래된 것부터 버림).
//   금칙어가 든 문장·비유는 기록하지 않는다(원문 금칙어를 남기지 않게, 규칙 11).
// groundingCounts: 날짜별 { checked, hidden } 개수만(오탐률 분모). 통과한 비유의 글은 남기지 않는다.
// 운영자 내보내기(groundingSamples)는 보내기 동의(feedbackShare)가 켜진 경우에만 corrections.js가 싣는다.
import { maskSentence, localDay, last7Days } from './feedback.js';
import { findBlocked } from './blocklist.js';

export const GROUNDING_LOG_MAX = 300;
export const GROUNDING_TEXT_MAX = 200;
export const GROUNDING_SAMPLE_MAX = 50;
export const GROUNDING_DAYS = 14;
export const GROUNDING_RECENT = 5;
export const FALSE_POSITIVE = 'false-positive';
export const GROUNDING_REASON_LABEL = { 'fact-mismatch': '사실 불일치', 'number-outside': '근거 밖 숫자' };

const clip = (s, n = GROUNDING_TEXT_MAX) => [...String(s ?? '')].slice(0, n).join('');
const maskClip = s => clip(maskSentence(String(s ?? '')));

/**
 * 숨긴 비유 한 건을 기록 모양으로. 원문(sentence·analogy)은 가린 뒤 잘라서만 담는다.
 * 금칙어가 든 문장·비유(가리기 전 원문 기준)이거나 이유가 없으면 null(기록하지 않음).
 */
export function makeGroundingEntry({ id, ts, reason, nodeId, interest, sentence, analogy }, blockTerms = []) {
  if (!reason || typeof reason !== 'string') return null;
  if (findBlocked(sentence, blockTerms) || findBlocked(analogy, blockTerms)) return null;
  return {
    id, ts, reason: clip(reason, 40), nodeId: nodeId ?? null, interest: interest ?? null,
    sentenceMasked: maskClip(sentence), analogyMasked: maskClip(analogy)
  };
}

export function addGroundingEntry(log, entry, max = GROUNDING_LOG_MAX) {
  if (!entry) return log;
  const next = [...(log || []), entry];
  return next.length > max ? next.slice(next.length - max) : next;
}

// 날짜별 { checked, hidden }. 숨김이면 둘 다 오른다. 가장 최근 14일만(키 정렬 기준)
export function bumpGroundingCount(counts, day, hidden) {
  const cur = counts?.[day] && typeof counts[day] === 'object' ? counts[day] : { checked: 0, hidden: 0 };
  const next = { ...(counts || {}), [day]: { checked: (cur.checked || 0) + 1, hidden: (cur.hidden || 0) + (hidden ? 1 : 0) } };
  const keep = Object.keys(next).sort().slice(-GROUNDING_DAYS);
  return Object.fromEntries(keep.map(k => [k, next[k]]));
}

// "괜찮은 비유였어요"(오탐 표시). flag가 null이면 표시를 뗀다. 원본은 바꾸지 않는다
export function flagGroundingEntry(log, id, flag) {
  if (flag !== FALSE_POSITIVE && flag !== null) throw new Error(`알 수 없는 표시: ${flag}`);
  return (log || []).map(e => {
    if (e.id !== id) return e;
    const { userFlag, ...rest } = e;
    return flag ? { ...rest, userFlag: flag } : rest;
  });
}

const num = v => (Number.isFinite(v) ? v : 0);

/**
 * 최근 7일(today 포함) 요약. 개수(checked·hidden)는 카운터 기준(기록이 상한으로 밀려도 맞게),
 * 이유별·오탐 표시·최근 숨김은 기록 기준. percent는 checked가 0이면 null.
 * total은 기록 전체 건수(지우기 버튼을 켤지 정하는 데 쓴다).
 */
export function summarizeGrounding(log, counts, today, { recent = GROUNDING_RECENT } = {}) {
  const days = new Set(last7Days(today));
  let checked = 0, hidden = 0;
  for (const [day, c] of Object.entries(counts || {})) {
    if (!days.has(day) || !c || typeof c !== 'object') continue;
    checked += num(c.checked);
    hidden += num(c.hidden);
  }
  const inWeek = (log || []).filter(e => days.has(localDay(e.ts)));
  const reasons = {};
  for (const e of inWeek) reasons[e.reason] = (reasons[e.reason] || 0) + 1;
  return {
    checked, hidden,
    percent: checked > 0 ? Math.min(100, Math.round((hidden / checked) * 100)) : null,
    reasons,
    flagged: inWeek.filter(e => e.userFlag === FALSE_POSITIVE).length,
    recent: [...inWeek].sort((a, b) => b.ts - a.ts).slice(0, recent),
    total: (log || []).length
  };
}

// 설정 "내 피드백" 아래 한 줄
export function formatGroundingStats(st) {
  if (!st.checked && !st.hidden) return '지난 7일 근거 검사를 거친 비유가 아직 없어요.';
  const parts = [`지난 7일 · 비유 ${st.checked}개 중 근거 검사로 숨김 ${st.hidden}개${st.percent === null ? '' : ` (${st.percent}%)`}`];
  for (const [reason, label] of Object.entries(GROUNDING_REASON_LABEL)) if (st.reasons[reason]) parts.push(`${label} ${st.reasons[reason]}`);
  for (const [reason, n] of Object.entries(st.reasons)) if (!GROUNDING_REASON_LABEL[reason]) parts.push(`${reason} ${n}`);
  if (st.flagged) parts.push(`괜찮았다고 표시 ${st.flagged}`);
  return parts.join(' · ');
}

/**
 * 샘플을 다시 거른다: nodeIds(주면) 밖의 노드, 금칙어가 든 문장·비유는 뺀다.
 * 운영자 도구(tools/check-corrections.mjs)가 내보낸 뒤 늘어난 금칙어·바뀐 그래프로 한 번 더 쓴다
 */
export function filterGroundingSamples(samples, { nodeIds = null, blockTerms = [] } = {}) {
  return (samples || []).filter(s => (!nodeIds || nodeIds.has(s.nodeId))
    && !findBlocked(s.sentence, blockTerms) && !findBlocked(s.analogy, blockTerms));
}

/**
 * 운영자 내보내기용 샘플(T-146). 그 관심사·최근 7일 기록만, nodeIds(공통 노드)를 주면 그 노드만.
 * 오탐 표시가 있는 것 먼저, 그다음 최신순으로 max건. id·ts는 담지 않고 날짜(day)만, 텍스트는 가린 것만.
 * @returns {Array<{ reason, nodeId, sentence, analogy, day, userFlag? }>}
 */
export function groundingSamples(log, { interest, nodeIds = null, blockTerms = [], today, max = GROUNDING_SAMPLE_MAX } = {}) {
  const days = new Set(last7Days(today));
  const picked = (log || [])
    .filter(e => e && days.has(localDay(e.ts)) && e.interest === interest)
    .sort((a, b) => ((b.userFlag === FALSE_POSITIVE) - (a.userFlag === FALSE_POSITIVE)) || (b.ts - a.ts))
    .map(e => {
      const s = { reason: e.reason, nodeId: e.nodeId, sentence: e.sentenceMasked, analogy: e.analogyMasked, day: localDay(e.ts) };
      if (e.userFlag === FALSE_POSITIVE) s.userFlag = FALSE_POSITIVE;
      return s;
    });
  return filterGroundingSamples(picked, { nodeIds, blockTerms }).slice(0, max);
}

// 샘플 요약(운영자 도구 출력용): 전체·이유별·오탐 표시 수
export function summarizeGroundingSamples(samples) {
  const reasons = {};
  let flagged = 0;
  for (const s of samples || []) {
    reasons[s.reason] = (reasons[s.reason] || 0) + 1;
    if (s.userFlag === FALSE_POSITIVE) flagged += 1;
  }
  return { total: (samples || []).length, reasons, flagged };
}

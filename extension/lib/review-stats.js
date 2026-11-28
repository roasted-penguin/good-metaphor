// 검수 기록(T-229, ADR 0017 에이전트 2 "재는 방법"): 검수 대기(draft) 노드의 아직 확인하지 않은 사실을
// 사용자가 확인했는지·지웠는지·고쳤는지 센다. "검수에서 지운 사실 비율"을 이 기기에서 보려는 것이다.
// 글자는 싣지 않고 숫자만 센다. 저장은 설정 화면이 chrome.storage.local reviewStats 하나에(새 권한 없음, 서버로 보내지 않음).
// 도우미와 한 번에 만들기 초안을 함께 센다(오버레이에 출처 표시를 더하지 않으려고 나누지 않았다).

export const REVIEW_STATS_KEY = 'reviewStats';

const reviewedAt = (node, i) => Array.isArray(node?.factsReviewed) && node.factsReviewed[i] === true;

/**
 * 검수 대기 노드 하나가 prev → next로 바뀔 때 센 값. next가 null이면 노드를 지운 것.
 * prev의 미확인 사실마다: 같은 글이 next에 확인됨으로 있으면 확인, 미확인으로 있으면 그대로(세지 않음),
 * 없으면 how가 'edit'(수정 폼)이면 고침, 아니면 지움. 이미 확인한 사실과 새로 쓴 사실은 세지 않는다.
 * prev가 초안이 아니면 0.
 */
export function reviewDelta(prev, next, how = 'review') {
  const d = { confirmed: 0, deleted: 0, edited: 0 };
  if (!prev || prev.draft !== true || !Array.isArray(prev.facts)) return d;
  const after = new Map();
  if (next && Array.isArray(next.facts)) {
    next.facts.forEach((f, i) => {
      // 같은 글이 둘이면 하나라도 확인됐으면 확인으로
      const ok = next.draft !== true || reviewedAt(next, i);
      after.set(f, (after.get(f) || false) || ok);
    });
  }
  prev.facts.forEach((f, i) => {
    if (reviewedAt(prev, i)) return;
    if (!after.has(f)) { d[how === 'edit' ? 'edited' : 'deleted']++; return; }
    if (after.get(f)) d.confirmed++;
  });
  return d;
}

const num = v => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

export function normalizeReviewStats(x) {
  return { confirmed: num(x?.confirmed), deleted: num(x?.deleted), edited: num(x?.edited), since: num(x?.since) || null };
}

export function addReviewStats(stats, delta, now = Date.now()) {
  const s = normalizeReviewStats(stats);
  const d = normalizeReviewStats(delta);
  if (!d.confirmed && !d.deleted && !d.edited) return s;
  return { confirmed: s.confirmed + d.confirmed, deleted: s.deleted + d.deleted, edited: s.edited + d.edited, since: s.since || now };
}

// 화면 한 줄. 센 것이 없으면 빈 글자
export function reviewStatsLine(stats) {
  const s = normalizeReviewStats(stats);
  const total = s.confirmed + s.deleted + s.edited;
  if (!total) return '';
  const pct = n => Math.round((n / total) * 100);
  return `검수 기록: 사실 ${total}개 중 지움 ${s.deleted}개(${pct(s.deleted)}%) · 고침 ${s.edited}개(${pct(s.edited)}%) · 확인 ${s.confirmed}개. 이 기기에만 남아요.`;
}

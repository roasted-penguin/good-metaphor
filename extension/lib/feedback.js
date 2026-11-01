// 말풍선 피드백 층 (ADR 0010 1단계, T-129). 순수 함수만 둔다. 저장은 background.js가 chrome.storage.local에.
// 피드백은 사용자 크롬 프로필 안에만 저장한다(D-7, 규칙 3의 예외). 공통 그래프 파일은 바꾸지 않는다.
//
// 기록: { id, ts, sentenceHash, sentence, nodeId, tagId, vote: 'up'|'down'|'pick', pickedNodeId?, reason?, provider }
//   down = 그 문장에 이 노드를 쓰지 않음, pick = 그 문장은 pickedNodeId로 고정, up = 기록만

export const FEEDBACK_MAX = 500;

export function addRecord(list, record) {
  const next = [...list, record];
  return next.length > FEEDBACK_MAX ? next.slice(next.length - FEEDBACK_MAX) : next;
}

export function removeRecord(list, id) {
  return list.filter(r => r.id !== id);
}

// 👎 뒤 고르는 이유(선택). forced = 비유가 억지, meaning = 뜻이 틀림(LLM 문제, T-122), fact = 사실이 틀림(공통 노드 제보, T-118), none = 맞는 개념 없음
export const REASONS = ['forced', 'meaning', 'fact', 'none'];
export function setReason(list, id, reason) {
  if (!REASONS.includes(reason)) throw new Error(`알 수 없는 이유: ${reason}`);
  return list.map(r => (r.id === id ? { ...r, reason } : r));
}

// 그 문장의 기록만 시간순으로
function recordsFor(records, sentenceHash) {
  return records.filter(r => r.sentenceHash === sentenceHash).sort((a, b) => a.ts - b.ts);
}

/**
 * 검색 후보에 그 문장의 피드백을 적용한다. 같은 노드에 대해서는 나중 기록이 이긴다.
 * 고정(pick)은 검색 후보 안의 노드만 인정한다(근거 밖 금지, 규칙 1).
 * @returns {{ candidates: object[], applied: boolean, excluded: string[], pinned: string|null }}
 */
export function applyFeedback(candidates, records, sentenceHash, topK = 3) {
  const last = new Map(); // nodeId -> 'down' | 'pick'
  for (const r of recordsFor(records, sentenceHash)) {
    if (r.vote === 'down') last.set(r.nodeId, 'down');
    if (r.vote === 'pick' && r.pickedNodeId) {
      for (const [id, v] of last) if (v === 'pick') last.delete(id); // 고정은 하나만
      last.set(r.pickedNodeId, 'pick');
    }
  }
  const excluded = [...last].filter(([, v]) => v === 'down').map(([id]) => id);
  const pickId = [...last].find(([, v]) => v === 'pick')?.[0];
  const pinnedCand = pickId ? candidates.find(c => c.id === pickId) : null;
  if (pinnedCand) return { candidates: [pinnedCand], applied: true, excluded, pinned: pinnedCand.id };
  const kept = candidates.filter(c => !excluded.includes(c.id));
  const applied = kept.slice(0, topK).map(c => c.id).join() !== candidates.slice(0, topK).map(c => c.id).join();
  return { candidates: kept.slice(0, topK), applied, excluded, pinned: null };
}

// 그 문장 기록의 지문. 결과 캐시 키에 넣어 피드백이 바뀌면 캐시가 저절로 무효가 되게 한다
export function feedbackKey(records, sentenceHash) {
  return recordsFor(records, sentenceHash).filter(r => r.vote !== 'up').map(r => `${r.id}:${r.vote}:${r.nodeId}:${r.pickedNodeId || ''}`).join(',');
}

// ── "내 피드백" 설정 화면용 (T-132) ──

/**
 * 저장·표시 전에 문장의 개인정보 모양을 가린다.
 * 메일 → [메일], URL(http://·https://·www.) → [주소], 4자리 이상 숫자·전화번호 모양 → [숫자].
 * 1~3자리 숫자("4시간", "80점")는 뜻에 필요해서 그대로 둔다.
 * 사람 이름은 규칙 기반으로 가려낼 수 없어서 가리지 않는다.
 */
export function maskSentence(text) {
  return String(text)
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[메일]')
    .replace(/(?:https?:\/\/|www\.)[^\s<>"']*[^\s<>"'.,!?)\]]/g, '[주소]')
    .replace(/\d{2,4}[-\s]\d{3,4}[-\s]\d{4}|\d{4,}/g, '[숫자]');
}

// 날짜별 호버 수 집계. day는 YYYY-MM-DD, 가장 최근 14일만 남긴다(키 정렬 기준)
export const HOVER_DAYS = 14;
export function bumpHover(counts, day) {
  const next = { ...counts, [day]: (counts[day] || 0) + 1 };
  const keep = Object.keys(next).sort().slice(-HOVER_DAYS);
  return Object.fromEntries(keep.map(k => [k, next[k]]));
}

// 밀리초 → 로컬 시각 기준 YYYY-MM-DD (background.js의 호버 집계도 씀)
export function localDay(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// today 포함 지난 7일(today와 그 앞 6일)의 날짜 목록
function last7Days(today) {
  const [y, m, d] = today.split('-').map(Number);
  return Array.from({ length: 7 }, (_, i) => localDay(new Date(y, m - 1, d - i, 12).getTime()));
}

/**
 * 지난 7일 요약: 호버 수와 피드백 종류별 개수
 * @returns {{ hovers: number, up: number, down: number, pick: number }}
 */
export function summarizeFeedback(records, counts, today) {
  const days = new Set(last7Days(today));
  const out = { hovers: 0, up: 0, down: 0, pick: 0 };
  for (const [day, n] of Object.entries(counts)) if (days.has(day)) out.hovers += n;
  for (const r of records) if (['up', 'down', 'pick'].includes(r.vote) && days.has(localDay(r.ts))) out[r.vote] += 1;
  return out;
}

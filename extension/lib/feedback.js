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

export const BOOST_STEP = 0.05;
export const BOOST_MIN = -0.2;
export const BOOST_MIN_SENTENCES = 3;
/**
 * 로그인 사용자 노드 가중치 (T-130). 지금 기록만으로 정하는 순수 함수라, 되돌리기·반복 👎에도 값이 흔들리지 않는다.
 * nodeId에 대한 👎의 서로 다른 문장(sentenceHash) 수가 3 미만이면 0(가중치 없음),
 * 그 이상이면 -0.05 × (문장 수 − 2), 하한 -0.2.
 * @returns {number}
 */
export function boostForNode(records, nodeId) {
  const distinct = new Set(records.filter(r => r.vote === 'down' && r.nodeId === nodeId).map(r => r.sentenceHash)).size;
  if (distinct < BOOST_MIN_SENTENCES) return 0;
  // 0.05 단위에서 생기는 부동소수 오차(-0.15000000000000002)를 없앤다
  return Math.max(BOOST_MIN, Math.round(-BOOST_STEP * (distinct - BOOST_MIN_SENTENCES + 1) * 100) / 100);
}

/**
 * 비슷한 문장 피드백 메모리 (T-130). 지금 문장(sentenceHash)이 아닌 다른 문장의 👎·고정 기록을
 * retrieve의 feedbackMemory 모양으로 바꾼다. 원문 없이 벡터 + 노드만 쓴다.
 * 문장마다 applyFeedback과 같은 규칙: 같은 노드는 나중 기록이 이기고, 고정은 하나만.
 * 벡터(vec)가 없는 기록(임베딩 실패, T-130 이전 기록)은 뺀다.
 * @returns {Array<{ vec: number[], nodeId: string, vote: 'down'|'pick' }>}
 */
export function similarMemory(records, sentenceHash) {
  const bySentence = new Map(); // sentenceHash -> Map(nodeId -> 기록)
  for (const r of [...(records || [])].sort((a, b) => a.ts - b.ts)) {
    if (r.sentenceHash === sentenceHash) continue;
    if (!bySentence.has(r.sentenceHash)) bySentence.set(r.sentenceHash, new Map());
    const last = bySentence.get(r.sentenceHash);
    if (r.vote === 'down' && r.nodeId) last.set(r.nodeId, { vote: 'down', vec: r.vec });
    if (r.vote === 'pick' && r.pickedNodeId) {
      for (const [id, v] of last) if (v.vote === 'pick') last.delete(id); // 고정은 하나만
      last.set(r.pickedNodeId, { vote: 'pick', vec: r.vec });
    }
  }
  const out = [];
  for (const last of bySentence.values()) {
    for (const [nodeId, { vote, vec }] of last) {
      if (Array.isArray(vec) && vec.length) out.push({ vec, nodeId, vote });
    }
  }
  return out;
}

export const REPORT_THRESHOLD = 3;
// 공통 노드만 제보 대상이다. 사용자 노드(source 'user' 또는 u: 접두어)는 자기 데이터라 빼지 않는다
const isCommonNode = n => n && n.source !== 'user' && !String(n.id).startsWith('u:');
// 검수 날짜(YYYY-MM-DD)의 로컬 자정(ms). 없거나 형식이 틀리면 0(모든 제보를 센다)
function verifiedCutoff(verifiedAt) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(verifiedAt || '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : 0;
}
/**
 * "사실이 틀렸어요" 제보로 후보에서 뺄 공통 노드 (T-118, D-3).
 * 👎 + reason 'fact' 기록 중 그 노드 verifiedAt(로컬 자정) 이후의 것만, 같은 문장(sentenceHash)은 한 번만 센다.
 * 서로 다른 문장이 threshold(기본 3) 이상이면 뺀다. 다시 검수해 verifiedAt이 오르면 예전 제보는 안 세져 저절로 풀린다.
 * forced·meaning·none은 비유·뜻 문제라 세지 않는다. 로그인 전에는 기기 안 기록만(서버 집계는 L0 이후).
 * @returns {Set<string>} 뺄 노드 id
 */
export function reportedNodes(records, graph, { threshold = REPORT_THRESHOLD } = {}) {
  const nodes = new Map((graph?.nodes || []).filter(isCommonNode).map(n => [n.id, n]));
  const bySentence = new Map(); // nodeId -> Set(sentenceHash)
  for (const r of records || []) {
    if (r?.vote !== 'down' || r.reason !== 'fact') continue;
    const n = nodes.get(r.nodeId);
    if (!n || !(r.ts >= verifiedCutoff(n.verifiedAt))) continue;
    if (!bySentence.has(n.id)) bySentence.set(n.id, new Set());
    bySentence.get(n.id).add(r.sentenceHash);
  }
  return new Set([...bySentence].filter(([, s]) => s.size >= threshold).map(([id]) => id));
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
    .replace(/(?:https?:\/\/|www\.)[^\s<>"']*[^\s<>"'.,!?)\]]/g, m => '[주소]' + urlTail(m))
    .replace(/\d{2,4}[-\s]\d{3,4}[-\s]\d{4}|\d{4,}/g, '[숫자]');
}

// 주소에 붙어 함께 잡힌 조사("https://a.com/x에서"의 "에서")를 돌려준다 (T-137).
// 끝의 한글 덩어리 전체가 알려진 조사이고 그 앞이 영문·숫자·닫는 괄호일 때만 돌려준다.
// 그 밖의 한글("/wiki/Maple스토리", "/u/hong길동")은 주소 경로일 수 있어 함께 가린다(가릴 것이 새지 않게).
// 떼어 낸 앞쪽 끝의 문장부호(닫는 괄호·마침표 등)도 원문으로 돌려준다.
const URL_PARTICLE = /^(?:에서는|에서도|으로는|으로도|까지는|부터는|에는|에도|에서|에게|으로|부터|까지|처럼|같은|에|을|를|은|는|이|가|로|의|와|과|도|만)$/;
function urlTail(m) {
  const t = m.match(/^(.*?[A-Za-z0-9)\]])([\u1100-\u11FF\u3130-\u318F\uAC00-\uD7A3]+)$/);
  if (!t || !URL_PARTICLE.test(t[2])) return '';
  const punct = t[1].match(/[.,!?)\]]+$/)?.[0] || '';
  return punct + t[2];
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

/**
 * 호버 대비 백분율 (T-137). 같은 7일 창의 호버 수(summarizeFeedback의 hovers)로 나눈다.
 * 반올림 정수, 100% 상한. 호버 수가 0이거나 모르면 null(개수만 보인다).
 * @returns {number|null}
 */
export function feedbackPercent(count, hovers) {
  if (!Number.isFinite(hovers) || hovers <= 0 || !Number.isFinite(count)) return null;
  return Math.min(100, Math.round((count / hovers) * 100));
}

// "내 피드백" 요약 한 줄. 개수 옆에 호버 대비 %를 붙인다(호버 수를 모르면 개수만)
export function formatFeedbackStats(st) {
  const n = (mark, count) => {
    const pct = feedbackPercent(count, st.hovers);
    return `${mark} ${count}${pct === null ? '' : ` (${pct}%)`}`;
  };
  return `지난 7일 · 호버 ${st.hovers}번 · ${n('👍', st.up)} · ${n('👎', st.down)} · ${n('교정', st.pick)}`;
}

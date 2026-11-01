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
  return recordsFor(records, sentenceHash).map(r => `${r.id}:${r.vote}:${r.nodeId}:${r.pickedNodeId || ''}`).join(',');
}

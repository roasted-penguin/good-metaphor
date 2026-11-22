// 스모크 "비유 생성" 한 줄 판정(T-188). smoke-providers.mjs 의 generate() 결과(row)를 받아
// { problem, note } 를 돌려준다. problem 이 있으면 실패로 세고, note 는 보고만 한다.
// - 실패: 호출 오류(잘린 JSON 포함), meaning 없음, 끝맺음(다시 불러도 해요체 아님), 후보 밖 nodeId(지어낸 id)
// - 참고: nodeId null 인데 analogy 글을 남긴 답. 모델은 "맞는 후보 없음"으로 판단했고 규칙 1이 글을 숨겨
//   사용자에게는 "비유 없음"과 똑같이 보인다. 근거 밖 비유가 새지 않으므로 실패로 세지 않는다
//   (run 45012155475 Groq, 대체 임베더 후보 auction·meso·meso_inflation 에 rate limit 구조가 없음)
export function generationVerdict(row) {
  if (!row.ok) return { problem: row.error, note: null };
  if (!row.answer?.meaning) return { problem: 'meaning 없음', note: null };
  if (row.ending && !row.ending.ok) {
    return { problem: `존댓말 아님: ${row.ending.issues.map(i => `${i.field}(${i.style})`).join(', ')}`, note: null };
  }
  if (!row.rule1) {
    if (row.nodeId == null) return { problem: null, note: 'nodeId null인데 analogy를 남김(규칙 1이 숨겨 결과는 비유 없음과 같아요)' };
    return { problem: `후보에 없는 nodeId: ${row.nodeId}`, note: null };
  }
  return { problem: null, note: null };
}

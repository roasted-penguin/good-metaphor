// 임베딩은 항상 한 문장씩. q8 모델은 활성값 양자화 스케일을 배치 단위로 잡아서,
// 같은 문장도 함께 묶인 문장에 따라 벡터가 달라진다(T-128: 36개 묶음 ↔ 1개 최소 cos 0.94).
// 확장(오프스크린)과 평가 도구가 같은 방식을 써야 평가 수치가 실제와 맞는다.
export async function embedEach(inputs, run) {
  const out = [];
  for (const t of inputs) out.push((await run([t]))[0]);
  return out;
}

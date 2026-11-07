// 근거 검사 (T-123): 비유가 고른 노드 facts 밖의 사실(지어낸 수치·규칙)을 쓰는지 본다.
// 순수 함수만 둔다. 서버(server/app/pipeline.py)에도 같은 규칙·문구·reason으로 이식한다.

export const GROUNDING_REJECTED_TEXT = '근거에 없는 내용이 섞여 있어서 비유를 숨겼어요.';

// usedFact와 fact를 "같은 문장"으로 볼 글자 3-gram 자카드 하한
const FACT_JACCARD_MIN = 0.6;

// 공백·문장부호·기호를 지운다 (비교용)
export function normalizeText(text) {
  return String(text ?? '').normalize('NFC').replace(/[\s\p{P}\p{S}]/gu, '');
}

// 아라비아 숫자 연속을 뽑는다. "1,000"처럼 천 단위 쉼표는 붙여 하나로 본다.
export function numbersIn(text) {
  const s = String(text ?? '').replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
  return s.match(/\d+/g) ?? [];
}

function trigrams(text) {
  const t = normalizeText(text), grams = new Set();
  for (let i = 0; i + 3 <= t.length; i++) grams.add(t.slice(i, i + 3));
  return grams;
}

// 글자 3-gram 자카드 유사도 (정규화 후). 둘 다 비면 0
export function charJaccard(a, b) {
  const A = trigrams(a), B = trigrams(b);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

// usedFact가 facts 중 하나와 일치하는지: 정규화 후 부분 문자열이거나 자카드 ≥ 0.6
function matchesFact(usedFact, facts) {
  const used = normalizeText(usedFact);
  return facts.some(f => {
    const fact = normalizeText(f);
    return (fact && fact.includes(used)) || charJaccard(usedFact, f) >= FACT_JACCARD_MIN;
  });
}

// { analogy, usedFact, facts, sentence, context } → { ok: true } | { ok: false, reason }
// - 비유가 비었으면 검사하지 않는다.
// - usedFact가 있으면 고른 노드 facts 중 하나와 일치해야 한다(아니면 fact-mismatch).
// - usedFact가 없거나 비었으면 숫자 검사만 한다(옛 모델·데모 호환, 오탐 방지).
// - 비유의 숫자가 facts·원문 문장·앞 문장 어디에도 없으면 number-outside.
export function checkGrounding({ analogy, usedFact, facts, sentence, context } = {}) {
  if (!normalizeText(analogy)) return { ok: true };
  const factList = Array.isArray(facts) ? facts.filter(f => typeof f === 'string') : [];

  if (normalizeText(usedFact) && !matchesFact(usedFact, factList)) {
    return { ok: false, reason: 'fact-mismatch' };
  }

  const known = new Set([...factList, sentence, context].flatMap(numbersIn));
  if (numbersIn(analogy).some(n => !known.has(n))) {
    return { ok: false, reason: 'number-outside' };
  }
  return { ok: true };
}

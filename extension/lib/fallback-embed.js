// 임베딩 모델을 못 받을 때 쓰는 대체 임베더: 글자 2·3그램을 해시해 4096차원 벡터로 만든다.
// 의미가 아닌 글자 겹침만 보므로 "구조가 비슷한" 검색은 약하다. 오프라인·테스트용.
// v2 (T-175):
// - 512 → 4096차원. 태그 텍스트(예문을 이어 붙여 그램이 수백~천 개)와 해시 충돌이 잦아,
//   순위가 글자 겹침보다 충돌 운에 흔들렸다(시드만 바꿔도 평가셋 hit@1이 16~25).
// - 단어 첫머리 그램(" 수"·" 한"·" 있다"처럼 공백으로 시작)은 0.6배. "수 있다"·"한" 같은 흔한
//   기능어가 여기에 몰려 관문·강화 문장을 엉뚱한 노드로 끌었다.
// 벡터 모양이 바뀌었으므로 FALLBACK_ID도 바꿔 예전 캐시 벡터를 지운다(vec-cache.js).
export const FALLBACK_DIM = 4096;
const LEAD_WEIGHT = 0.6;

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// 텍스트 → 그램별 가중치 합(Map). 소문자·공백 정리·query:/passage: 접두어 제거 뒤 앞뒤에 공백을 붙인다
export function ngramWeights(text) {
  const s = ' ' + String(text).toLowerCase().replace(/\s+/g, ' ').replace(/^\s*(query|passage):\s*/, '').trim() + ' ';
  const w = new Map();
  for (const n of [2, 3]) {
    for (let i = 0; i + n <= s.length; i++) {
      const g = s.slice(i, i + n);
      if (!g.trim()) continue;
      w.set(g, (w.get(g) || 0) + (g[0] === ' ' ? LEAD_WEIGHT : 1));
    }
  }
  return w;
}

export function hashEmbed(text) {
  const v = new Float32Array(FALLBACK_DIM);
  for (const [g, c] of ngramWeights(text)) {
    const h = fnv1a(g);
    v[h % FALLBACK_DIM] += (h & 0x10000) ? c : -c;
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return Array.from(v, x => x / norm);
}

export const FALLBACK_ID = 'fallback:hash-ngram-4096-v2';

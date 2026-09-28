// 임베딩 모델을 못 받을 때 쓰는 대체 임베더: 글자 2·3그램을 해시해 512차원 벡터로 만든다.
// 의미가 아닌 글자 겹침만 보므로 "구조가 비슷한" 검색은 약하다. 오프라인·테스트용.
const DIM = 512;

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function hashEmbed(text) {
  const v = new Float32Array(DIM);
  const s = ' ' + String(text).toLowerCase().replace(/\s+/g, ' ').replace(/^(query|passage):\s*/, '') + ' ';
  for (const n of [2, 3]) {
    for (let i = 0; i + n <= s.length; i++) {
      const g = s.slice(i, i + n);
      if (!g.trim()) continue;
      const h = fnv1a(g);
      v[h % DIM] += (h & 0x10000) ? 1 : -1;
    }
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return Array.from(v, x => x / norm);
}

export const FALLBACK_ID = 'fallback:hash-ngram-512';

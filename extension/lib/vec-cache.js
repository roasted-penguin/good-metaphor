// 그래프 벡터 캐시 정리(T-110). 키는 `${embedderId}|${sha1(text)}`.
// Map의 삽입 순서를 LRU 순서로 쓴다: 앞이 가장 오래 안 쓴 것, 끝이 최근에 쓴 것.

export const VEC_CACHE_MAX = 2000;

// 주어진 키들을 준 순서대로 Map 끝으로 옮긴다(최근 사용). 없는 키는 무시. 원본을 바꾼다
export function touch(cache, keys) {
  for (const k of keys) {
    if (!cache.has(k)) continue;
    const v = cache.get(k);
    cache.delete(k);
    cache.set(k, v);
  }
}

// 새 Map을 돌려준다(원본 불변).
// (1) 현재 embedderId가 아닌 항목 삭제 (2) max를 넘으면 앞(오래된 것)부터 삭제.
// keep(이번 그래프가 쓰는 키)은 절대 지우지 않는다. keep만으로 max를 넘어도 keep은 다 남긴다
export function pruneVecCache(cache, { embedderId, max = VEC_CACHE_MAX, keep = new Set() } = {}) {
  const prefix = `${embedderId}|`;
  const out = new Map();
  for (const [k, v] of cache) if (k.startsWith(prefix)) out.set(k, v);
  let over = out.size - max;
  if (over > 0) {
    for (const k of out.keys()) {
      if (over <= 0) break;
      if (keep.has(k)) continue;
      out.delete(k); // 순회 중 지금 키를 지우는 것은 Map에서 안전하다
      over--;
    }
  }
  return { cache: out, removed: cache.size - out.size };
}

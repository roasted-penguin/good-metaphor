// 미리 계산한 그래프 벡터(T-193, ADR 0015). 데이터 파일일 뿐 코드가 아니다(규칙 4).
// `npm run build:vectors`가 실제 확장(크롬, 같은 q8 모델, 한 문장씩)으로 공통 그래프의 노드·태그 텍스트를 임베딩해
// extension/data/vectors/<관심사>.json에 쓴다. 런타임은 embedderId·passagePrefix가 같고 sha1(텍스트)가 있는 항목만 쓰고,
// 나머지(텍스트가 바뀐 노드, 오버레이, 교정 예문, 대체 임베더)는 지금처럼 오프스크린에서 임베딩한다.
// 인코딩: float32 리틀엔디언 → base64. 런타임 벡터(Float32Array.tolist())와 비트가 같아 점수·순위가 그대로다.
// float16·int8은 크기가 1/2·1/4이지만 여유가 0.001~0.002인 문장이 있어(T-150) 1위가 바뀔 수 있다(ADR 0015)

export const VECTOR_FILE_FORMAT = 1;
export const VECTOR_ENCODING = 'f32le-base64';

export const precomputedPath = interestId => `data/vectors/${interestId}.json`;

// 리틀엔디언으로 고정(모든 대상 CPU가 LE지만 DataView로 명시)
export function encodeVector(vec) {
  const buf = new ArrayBuffer(vec.length * 4);
  const dv = new DataView(buf);
  for (let i = 0; i < vec.length; i++) dv.setFloat32(i * 4, vec[i], true);
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// base64 → number[]. 길이가 dim과 다르거나 해독이 안 되면 null
export function decodeVector(b64, dim) {
  if (typeof b64 !== 'string') return null;
  let s;
  try { s = atob(b64); } catch { return null; }
  if (s.length !== dim * 4) return null;
  const dv = new DataView(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) dv.setUint8(i, s.charCodeAt(i));
  const out = new Array(dim);
  for (let i = 0; i < dim; i++) out[i] = dv.getFloat32(i * 4, true);
  return out;
}

// entries: [{ hash, vector }] → 파일 객체. 해시 순 정렬(diff가 작게), 같은 해시는 하나만
export function buildVectorFile({ interest, embedderId, passagePrefix = '', graphVersion = null, entries }) {
  const byHash = new Map();
  for (const e of entries) if (!byHash.has(e.hash)) byHash.set(e.hash, e.vector);
  const dims = new Set([...byHash.values()].map(v => v.length));
  if (dims.size > 1) throw new Error(`벡터 차원이 섞여 있어요: ${[...dims].join(', ')}`);
  const dim = dims.size ? [...dims][0] : 0;
  const vectors = {};
  for (const h of [...byHash.keys()].sort()) vectors[h] = encodeVector(byHash.get(h));
  return { format: VECTOR_FILE_FORMAT, interest, embedderId, passagePrefix, graphVersion, encoding: VECTOR_ENCODING, dim, count: byHash.size, vectors };
}

// 형식 검사(CI·로더). 빈 배열이면 통과
export function vectorFileProblems(file) {
  const p = [];
  if (!file || typeof file !== 'object') return ['파일이 객체가 아니에요'];
  if (file.format !== VECTOR_FILE_FORMAT) p.push(`format이 ${VECTOR_FILE_FORMAT}이 아니에요: ${file.format}`);
  if (file.encoding !== VECTOR_ENCODING) p.push(`encoding이 ${VECTOR_ENCODING}이 아니에요: ${file.encoding}`);
  if (typeof file.embedderId !== 'string' || !file.embedderId) p.push('embedderId가 없어요');
  if (typeof file.passagePrefix !== 'string') p.push('passagePrefix가 없어요');
  if (!Number.isInteger(file.dim) || file.dim <= 0) p.push('dim이 양의 정수가 아니에요');
  if (!file.vectors || typeof file.vectors !== 'object') p.push('vectors가 없어요');
  else {
    const n = Object.keys(file.vectors).length;
    if (file.count !== n) p.push(`count(${file.count})가 항목 수(${n})와 달라요`);
    const bad = Object.entries(file.vectors).filter(([, b]) => decodeVector(b, file.dim) === null).map(([h]) => h);
    if (bad.length) p.push(`해독 안 되는 항목 ${bad.length}개: ${bad.slice(0, 3).join(', ')}`);
  }
  return p;
}

// 런타임 조회표: 해시 → 벡터. 임베더·접두어가 다르거나 형식이 다르면 빈 Map(지금처럼 런타임 임베딩)
export function precomputedIndex(file, { embedderId, passagePrefix = '' }) {
  const idx = new Map();
  if (!file || file.format !== VECTOR_FILE_FORMAT || file.encoding !== VECTOR_ENCODING) return idx;
  if (file.embedderId !== embedderId || (file.passagePrefix ?? '') !== (passagePrefix ?? '')) return idx;
  for (const [h, b] of Object.entries(file.vectors || {})) {
    const v = decodeVector(b, file.dim);
    if (v) idx.set(h, v);
  }
  return idx;
}

// 그래프가 쓰는 해시와 비교. missing = 그래프에 있는데 파일에 없음(런타임 임베딩으로 떨어짐), extra = 파일에만 있음(죽은 데이터)
export function vectorFileStaleness(file, hashes) {
  const want = new Set(hashes);
  const have = new Set(Object.keys(file?.vectors || {}));
  const missing = [...want].filter(h => !have.has(h)).sort();
  const extra = [...have].filter(h => !want.has(h)).sort();
  return { missing, extra, fresh: missing.length === 0 && extra.length === 0 };
}

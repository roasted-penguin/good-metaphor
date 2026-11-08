// 관심사 그래프: 공통 저장소(읽기 전용) + 사용자 오버레이(로그인 시) 병합

export const EMPTY_OVERLAY = {
  schema: 1,
  useCommon: true,          // false면 공통 그래프를 끄고 내 관심사만 사용 (관심사 변경)
  domain: '',               // useCommon=false일 때 내 관심사 이름 (예: "원신")
  analogyPrefix: '',        // 예: "원신으로 치면"
  theme: 'neutral',         // 말풍선 테마: 'maple' | 'neutral'
  hiddenNodeIds: [],        // 공통 그래프에서 숨길 노드
  nodeBoosts: {},           // 노드 id -> 점수 가산 (-0.2 ~ 0.2)
  feedbackBoosts: {},       // 노드 id -> 👎 누적으로 정해진 가산 (T-130, 확장이 기록으로 계산해 씀. 손으로 고치지 않음)
  tags: [],                 // 내가 추가한 추상 개념 태그
  nodes: [],                // 내가 추가한 노드 (공통 태그 id도 참조 가능). draft: true면 검수 대기(T-301, 병합에서 빠짐)
  edges: []
};

// 별칭(게임 은어, T-114): 문자열 배열, 각 항목은 공백만이 아닌 1~20자
const ALIAS_MAX = 20;
function validAliases(a) {
  return Array.isArray(a) && a.every(x => typeof x === 'string' && x.trim().length > 0 && x.length <= ALIAS_MAX);
}

// 출처(T-118): http(s) URL 문자열 1개 이상
function validSources(a) {
  return Array.isArray(a) && a.length > 0 && a.every(u => {
    if (typeof u !== 'string') return false;
    try {
      const url = new URL(u);
      return (url.protocol === 'https:' || url.protocol === 'http:') && !!url.hostname;
    } catch { return false; }
  });
}
// 검수 날짜(T-118): YYYY-MM-DD 형식의 실제 날짜(2026-02-30 같은 없는 날은 오류)
function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// partial = 사용자 오버레이. 공통 그래프(partial 아님)는 노드마다 sources·verifiedAt이 꼭 있어야 하고(T-118, D-3),
// 오버레이 노드는 둘 다 선택이지만 넣었으면 같은 형식을 따른다
export function validateGraph(g, { partial = false } = {}) {
  const errors = [];
  if (!g || typeof g !== 'object') return ['그래프가 객체가 아니에요.'];
  if (!partial && !g.domain) errors.push('domain(관심사 이름)이 없어요.');
  const tagIds = new Set();
  for (const [i, t] of (g.tags || []).entries()) {
    if (!t.id || !t.label) errors.push(`tags[${i}]에 id 또는 label이 없어요.`);
    if (tagIds.has(t.id)) errors.push(`태그 id 중복: ${t.id}`);
    if (t.examples !== undefined && !(Array.isArray(t.examples) && t.examples.every(e => typeof e === 'string'))) {
      errors.push(`태그 ${t.id || i}의 examples는 문자열 배열이어야 해요.`);
    }
    tagIds.add(t.id);
  }
  const nodeIds = new Set();
  for (const [i, n] of (g.nodes || []).entries()) {
    if (!n.id || !n.label) errors.push(`nodes[${i}]에 id 또는 label이 없어요.`);
    if (!Array.isArray(n.facts) || !n.facts.length) errors.push(`노드 ${n.id || i}에 facts(사실 목록)가 없어요.`);
    if (!Array.isArray(n.tags) || !n.tags.length) errors.push(`노드 ${n.id || i}에 tags가 없어요.`);
    if (n.aliases !== undefined && !validAliases(n.aliases)) {
      errors.push(`노드 ${n.id || i}의 aliases는 1~20자 문자열 배열이어야 해요.`);
    }
    // 약한 별칭(일상어와 겹치는 은어, T-149): aliases와 같은 규칙
    if (n.weakAliases !== undefined && !validAliases(n.weakAliases)) {
      errors.push(`노드 ${n.id || i}의 weakAliases는 1~20자 문자열 배열이어야 해요.`);
    }
    if (n.sources !== undefined || !partial) {
      if (!validSources(n.sources)) errors.push(`노드 ${n.id || i}의 sources(출처)는 http(s) 주소 1개 이상인 배열이어야 해요.`);
    }
    if (n.verifiedAt !== undefined || !partial) {
      if (!validDate(n.verifiedAt)) errors.push(`노드 ${n.id || i}의 verifiedAt(검수 날짜)은 YYYY-MM-DD 형식의 날짜여야 해요.`);
    }
    // 공통 그래프는 태그 파일(tags.json)에 없는 태그 id를 참조하면 오류(T-304). 오버레이는 mergeGraphs가 조용히 거른다
    if (!partial && Array.isArray(n.tags)) {
      for (const id of n.tags) if (!tagIds.has(id)) errors.push(`노드 ${n.id || i}가 없는 태그를 참조해요: ${id}`);
    }
    if (nodeIds.has(n.id)) errors.push(`노드 id 중복: ${n.id}`);
    nodeIds.add(n.id);
  }
  return errors;
}

/* ───────────── 공통 태그 파일 (T-304, 규칙 9) ───────────── */
// 추상 태그(통제 어휘)의 원본은 data/common/tags.json({ version, tags }). 관심사 그래프는 태그 id만 참조한다.
// 합치는 곳은 런타임마다 로더 한 곳(확장 stores.js, Node tools/load-graph.mjs, 서버 load_common_graph)뿐이다

// 태그 파일 자체 검증: version + 태그 목록(id·label·중복·examples는 validateGraph와 같은 규칙)
export function validateTagsFile(tf) {
  if (!tf || typeof tf !== 'object') return ['태그 파일이 객체가 아니에요.'];
  const errors = [];
  if (typeof tf.version !== 'string' || !tf.version) errors.push('태그 파일에 version이 없어요.');
  if (!Array.isArray(tf.tags)) return [...errors, '태그 파일에 tags(배열)가 없어요.'];
  return [...errors, ...validateGraph({ tags: tf.tags, nodes: [] }, { partial: true })];
}

// 관심사 그래프 + 태그 파일 → 해석된 그래프({ ...graph, tags }). 태그 순서는 파일 순서 그대로(nodeText·검색 불변).
// 하위 호환: 그래프에 tags가 이미 있으면(예전 원격 그래프) 그대로 쓴다. 원본 객체는 바꾸지 않는다.
// tagsVersion = 태그 파일 판본(인라인이면 null). mergeGraphs가 sources.common에 실어 결과 캐시 키(graphKey)를 가른다
export function resolveCommonGraph(graph, tagsFile) {
  if (Array.isArray(graph?.tags)) return { ...graph, tagsVersion: null };
  return { ...graph, tags: Array.isArray(tagsFile?.tags) ? tagsFile.tags : [], tagsVersion: tagsFile?.version ?? null };
}

export const BOOST_LIMIT = 0.2;
// 손으로 넣은 가중치(nodeBoosts) + 피드백 가중치(feedbackBoosts), 노드마다 -0.2~0.2로 자르고 소수 둘째 자리로 (T-130)
function combineBoosts(manual = {}, feedback = {}) {
  const out = {};
  for (const id of new Set([...Object.keys(manual || {}), ...Object.keys(feedback || {})])) {
    const sum = (Number(manual?.[id]) || 0) + (Number(feedback?.[id]) || 0);
    out[id] = Math.round(Math.min(BOOST_LIMIT, Math.max(-BOOST_LIMIT, sum)) * 100) / 100;
  }
  return out;
}

export function mergeGraphs(common, overlay) {
  const ov = { ...EMPTY_OVERLAY, ...(overlay || {}) };
  const useCommon = ov.useCommon !== false && common;
  const hidden = new Set(ov.hiddenNodeIds || []);

  const tags = new Map();
  const nodes = new Map();
  const edges = [];

  if (useCommon) {
    for (const t of common.tags) tags.set(t.id, { ...t, source: 'common' });
    for (const n of common.nodes) if (!hidden.has(n.id)) nodes.set(n.id, { ...n, source: 'common' });
    for (const e of common.edges || []) edges.push({ ...e, source: 'common' });
  } else if (common) {
    // 내 관심사만 쓰더라도 공통 태그 사전은 재사용할 수 있게 남겨 둔다
    for (const t of common.tags) tags.set(t.id, { ...t, source: 'common' });
  }

  for (const t of ov.tags || []) tags.set(t.id, { ...t, source: 'user' });
  // 검수 대기(draft) 노드는 그래프에 넣지 않는다: 임베딩·검색 후보·비유 근거 어디에도 쓰지 않는다(T-301, 규칙 1)
  const reviewedNodes = (ov.nodes || []).filter(n => n.draft !== true);
  for (const n of reviewedNodes) nodes.set(n.id, { ...n, source: 'user' });
  for (const e of ov.edges || []) edges.push({ ...e, source: 'user' });

  // 존재하지 않는 태그·엣지는 조용히 버린다
  for (const n of nodes.values()) n.tags = (n.tags || []).filter(id => tags.has(id));
  const liveEdges = edges.filter(e => nodes.has(e.from) && nodes.has(e.to));

  // 실제로 쓰이는 태그만 검색 대상
  const usedTagIds = new Set([...nodes.values()].flatMap(n => n.tags));

  return {
    domain: useCommon ? common.domain : (ov.domain || '내 관심사'),
    theme: useCommon ? (common.theme || 'neutral') : (ov.theme || 'neutral'),
    analogyPrefix: useCommon ? common.analogyPrefix : (ov.analogyPrefix || `${ov.domain || '내 관심사'}로 치면`),
    sources: {
      common: useCommon ? { id: common.id, version: common.version, tagsVersion: common.tagsVersion ?? null } : null,
      userNodes: reviewedNodes.length,
      draftNodes: (ov.nodes || []).length - reviewedNodes.length
    },
    tags: [...tags.values()].filter(t => usedTagIds.has(t.id)),
    nodes: [...nodes.values()],
    edges: liveEdges,
    boosts: combineBoosts(ov.nodeBoosts, ov.feedbackBoosts)
  };
}

// 임베딩할 문자열. 태그는 추상 설명 + 다른 분야 예문(examples), 노드는 태그 설명(구조)을 앞에 두고 이름+사실
// 태그 설명을 앞에 두는 이유: 게임 용어(메소 등)가 주제 유사도를 끌어가는 쏠림을 줄인다 (T-113)
export function tagText(t) {
  return [tagDescText(t), ...(t.examples || [])].join(' ');
}
// 태그의 "라벨: 설명"만(예문 없음). nodeTextMode 'desc'와 tagVectorMode 'max'의 설명 벡터가 쓴다 (T-154)
export function tagDescText(t) {
  return `${t.label}: ${t.desc || ''}`.trim();
}
// 별칭(aliases)은 넣지 않는다: 넣으면 노드 벡터가 바뀌어 잘 맞던 문장이 틀려졌다(T-114). 별칭은 retrieval.js 어휘 가산으로 쓴다
// mode 'full'(기본) = 태그 설명 + 예문, 'desc' = 태그 설명만(예문 한 줄이 그 태그의 모든 노드를 흔드는 것을 끊는다, T-154)
export function nodeText(n, tagMap, { mode = 'full' } = {}) {
  const tt = mode === 'desc' ? tagDescText : tagText;
  const structure = n.tags.map(id => tagMap.get(id)).filter(Boolean).map(tt).join(' ');
  return `${structure} ${n.label}. ${n.facts.join(' ')}`.trim();
}

/**
 * 임베딩할 항목 목록 (T-154, ADR 0013). 확장(ensureGraphVectors)·평가 도구가 모두 이것으로 만든다.
 * @param {object} graph      mergeGraphs 결과
 * @param {object} retrieval  admin.retrieval. nodeTextMode 'full'(기본) | 'desc', tagVectorMode 'joined'(기본) | 'max'
 *   joined: 'tag:<id>' = 태그 설명 + 예문을 한 텍스트로
 *   max:    'tag:<id>' = 태그 설명만, 예문마다 'tag:<id>#<n>'(n은 1부터). retrieve가 그중 최대 유사도를 쓴다
 *   기본값이면 예전 구성과 키·텍스트가 바이트 단위로 같다(벡터 캐시·검색 불변). 알 수 없는 값은 기본값으로 친다
 * @returns {Array<{key: string, text: string}>}
 */
export function embedItems(graph, { nodeTextMode = 'full', tagVectorMode = 'joined' } = {}) {
  const tagMap = new Map(graph.tags.map(t => [t.id, t]));
  const tags = tagVectorMode === 'max'
    ? graph.tags.flatMap(t => [
        { key: 'tag:' + t.id, text: tagDescText(t) },
        ...(t.examples || []).map((e, i) => ({ key: `tag:${t.id}#${i + 1}`, text: e }))
      ])
    : graph.tags.map(t => ({ key: 'tag:' + t.id, text: tagText(t) }));
  const mode = nodeTextMode === 'desc' ? 'desc' : 'full';
  return [...tags, ...graph.nodes.map(n => ({ key: 'node:' + n.id, text: nodeText(n, tagMap, { mode }) }))];
}

export async function sha1(str) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

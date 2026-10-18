// 관심사 그래프: 공통 저장소(읽기 전용) + 사용자 오버레이(로그인 시) 병합

export const EMPTY_OVERLAY = {
  schema: 1,
  useCommon: true,          // false면 공통 그래프를 끄고 내 관심사만 사용 (관심사 변경)
  domain: '',               // useCommon=false일 때 내 관심사 이름 (예: "원신")
  analogyPrefix: '',        // 예: "원신으로 치면"
  theme: 'neutral',         // 말풍선 테마: 'maple' | 'neutral'
  hiddenNodeIds: [],        // 공통 그래프에서 숨길 노드
  nodeBoosts: {},           // 노드 id -> 점수 가산 (-0.2 ~ 0.2)
  tags: [],                 // 내가 추가한 추상 개념 태그
  nodes: [],                // 내가 추가한 노드 (공통 태그 id도 참조 가능)
  edges: []
};

export function validateGraph(g, { partial = false } = {}) {
  const errors = [];
  if (!g || typeof g !== 'object') return ['그래프가 객체가 아니에요.'];
  if (!partial && !g.domain) errors.push('domain(관심사 이름)이 없어요.');
  const tagIds = new Set();
  for (const [i, t] of (g.tags || []).entries()) {
    if (!t.id || !t.label) errors.push(`tags[${i}]에 id 또는 label이 없어요.`);
    if (tagIds.has(t.id)) errors.push(`태그 id 중복: ${t.id}`);
    tagIds.add(t.id);
  }
  const nodeIds = new Set();
  for (const [i, n] of (g.nodes || []).entries()) {
    if (!n.id || !n.label) errors.push(`nodes[${i}]에 id 또는 label이 없어요.`);
    if (!Array.isArray(n.facts) || !n.facts.length) errors.push(`노드 ${n.id || i}에 facts(사실 목록)가 없어요.`);
    if (!Array.isArray(n.tags) || !n.tags.length) errors.push(`노드 ${n.id || i}에 tags가 없어요.`);
    if (nodeIds.has(n.id)) errors.push(`노드 id 중복: ${n.id}`);
    nodeIds.add(n.id);
  }
  return errors;
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
  for (const n of ov.nodes || []) nodes.set(n.id, { ...n, source: 'user' });
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
      common: useCommon ? { id: common.id, version: common.version } : null,
      userNodes: (ov.nodes || []).length
    },
    tags: [...tags.values()].filter(t => usedTagIds.has(t.id)),
    nodes: [...nodes.values()],
    edges: liveEdges,
    boosts: ov.nodeBoosts || {}
  };
}

// 임베딩할 문자열. 태그는 추상 설명, 노드는 태그 설명(구조)을 앞에 두고 이름+사실
// 태그 설명을 앞에 두는 이유: 게임 용어(메소 등)가 주제 유사도를 끌어가는 쏠림을 줄인다 (T-113)
export function tagText(t) {
  return `${t.label}: ${t.desc || ''}`.trim();
}
export function nodeText(n, tagMap) {
  const structure = n.tags.map(id => tagMap.get(id)).filter(Boolean).map(tagText).join(' ');
  return `${structure} ${n.label}. ${n.facts.join(' ')}`.trim();
}

export async function sha1(str) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

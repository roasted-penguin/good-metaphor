// 그래프 검색: 문장 벡터 → (1) 노드와 직접 비교 + (2) 추상 태그와 비교 후 태그를 가진 노드로 한 홉 이동

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * 비슷한 문장 피드백 (T-130): 질의와 코사인 c가 sim 이상인 기록만 그 노드 점수를 가감한다.
 * 가중치 w = (c - sim) / (1 - sim)은 sim에서 0으로 연속 시작해 c=1에서 1이 된다.
 * down은 -max·w, pick은 +max·w. 노드별 합은 [-max, +max]로 자른다.
 * @param {number[]} q        질의 벡터
 * @param {Array<{vec:number[], nodeId:string, vote:'down'|'pick'}>} memory
 * @returns {Map<string, number>} nodeId -> 가감 값
 */
export function feedbackAdjust(q, memory, { sim = 0.92, max = 0.1 } = {}) {
  const out = new Map();
  for (const m of memory || []) {
    // 벡터가 없거나 차원이 다른 기록(다른 임베더로 만든 것)은 건너뛴다
    if (!Array.isArray(m?.vec) || m.vec.length !== q.length) continue;
    const c = cosine(q, m.vec);
    if (c < sim) continue;
    const w = sim < 1 ? Math.min(1, (c - sim) / (1 - sim)) : 1;
    const sign = m.vote === 'down' ? -1 : m.vote === 'pick' ? 1 : 0;
    if (!sign) continue;
    out.set(m.nodeId, (out.get(m.nodeId) || 0) + sign * max * w);
  }
  // 합을 다 구한 뒤 한 번만 자른다(기록 순서와 무관하게)
  for (const [id, sum] of out) out.set(id, Math.max(-max, Math.min(max, sum)));
  return out;
}

// 별칭 앞 경계: 문장 처음, 공백, 문장부호·기호. 뒤는 무엇이든 된다(한국어 조사가 바로 붙는다: 재획을, 펑났다)
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * 문장에 별칭이 낱말로 들어 있는지 (T-114). 둘 다 NFKC로 맞춘 뒤, 별칭 앞이 경계일 때만 맞다.
 * 다른 낱말 안에 든 별칭(셔틀버스의 버스)은 맞지 않는다.
 */
export function aliasMatch(text, aliases) {
  if (!text || !aliases?.length) return false;
  const t = text.normalize('NFKC');
  return aliases.some(a => {
    const al = String(a || '').normalize('NFKC').trim();
    return al && new RegExp(`(?:^|[\\s\\p{P}\\p{S}])${escapeRe(al)}`, 'u').test(t);
  });
}

/**
 * @param {number[]} q        질의 벡터
 * @param {object} graph      mergeGraphs 결과
 * @param {Map} vecs          'tag:<id>' | 'node:<id>' -> 벡터
 * @param {object} opts       { topK, directWeight, tagWeight, tagAgg, tagPenalty, feedbackMemory, feedbackQuery, feedbackSim, feedbackMax }
 *   tagAgg      'max'(가장 높은 태그) | 'top2mean'(상위 2개 평균, 태그 1개면 그 값)
 *   tagPenalty  태그 id -> 태그 유사도에서 뺄 값. 주제가 넓은 태그(예: 경제)로 쏠리는 것을 줄인다 (T-113)
 *   feedbackMemory  비슷한 문장 피드백 기록. 비어 있으면 결과가 이전과 같다 (T-130, feedbackAdjust)
 *   feedbackQuery   비슷한 문장 판정에만 쓰는 벡터. 없으면 q. 정밀 모드는 q가 추상 구조 + 원문이라
 *                   원문으로 만든 기록 벡터와 맞추려 원문 벡터를 넘긴다 (T-138)
 *   aliasText   별칭(게임 은어) 판정에 쓰는 원문. 없으면 별칭 가산 없음 (T-114)
 *   aliasBoost  aliasText에 노드 별칭이 낱말로 있으면 그 노드 점수에 더할 값. 기본 0(영향 없음)
 */
export function retrieve(q, graph, vecs, {
  topK = 3, directWeight = 0.45, tagWeight = 0.55, tagAgg = 'max', tagPenalty = {},
  feedbackMemory = [], feedbackQuery = null, feedbackSim = 0.92, feedbackMax = 0.1,
  aliasText = '', aliasBoost = 0
} = {}) {
  const fb = feedbackMemory?.length ? feedbackAdjust(feedbackQuery || q, feedbackMemory, { sim: feedbackSim, max: feedbackMax }) : null;
  const tagSim = new Map();
  for (const t of graph.tags) {
    const v = vecs.get('tag:' + t.id);
    if (v) tagSim.set(t.id, cosine(q, v));
  }

  const scored = graph.nodes.map(n => {
    const v = vecs.get('node:' + n.id);
    const direct = v ? cosine(q, v) : 0;
    // 감점 뒤 점수로 태그 순위를 매기고, 결과에는 감점 전 유사도를 남긴다
    const ranked = n.tags
      .map(id => ({ id, sim: tagSim.get(id) ?? 0, adj: (tagSim.get(id) ?? 0) - (tagPenalty[id] || 0) }))
      .sort((a, b) => b.adj - a.adj);
    const top = ranked.slice(0, tagAgg === 'top2mean' ? 2 : 1);
    const tagScore = top.length ? Math.max(0, top.reduce((sum, t) => sum + t.adj, 0) / top.length) : 0;
    const bestTag = ranked[0]?.sim > 0 ? ranked[0].id : null, bestTagSim = bestTag ? ranked[0].sim : 0;
    const boost = graph.boosts?.[n.id] || 0;
    const feedback = fb?.get(n.id) || 0;
    const alias = aliasBoost && aliasMatch(aliasText, n.aliases) ? aliasBoost : 0;
    return {
      node: n,
      score: directWeight * direct + tagWeight * tagScore + boost + feedback + alias,
      feedback,
      direct,
      tagId: bestTag,
      tagSim: bestTagSim
    };
  }).sort((a, b) => b.score - a.score);

  const tagById = new Map(graph.tags.map(t => [t.id, t]));
  const nodeById = new Map(graph.nodes.map(n => [n.id, n]));

  return scored.slice(0, topK).map(c => ({
    id: c.node.id,
    label: c.node.label,
    source: c.node.source,
    facts: c.node.facts,
    score: +c.score.toFixed(4),
    ...feedbackField(c.feedback),
    direct: +c.direct.toFixed(4),
    tag: c.tagId ? { id: c.tagId, label: tagById.get(c.tagId)?.label, desc: tagById.get(c.tagId)?.desc, sim: +c.tagSim.toFixed(4) } : null,
    otherTags: c.node.tags.filter(id => id !== c.tagId).map(id => tagById.get(id)?.label).filter(Boolean),
    neighbors: graph.edges
      .filter(e => e.from === c.node.id || e.to === c.node.id)
      .map(e => {
        const otherId = e.from === c.node.id ? e.to : e.from;
        return { label: nodeById.get(otherId)?.label, rel: e.rel, dir: e.from === c.node.id ? 'out' : 'in' };
      })
  }));
}

// 피드백 가감이 있을 때만 결과에 feedback 필드를 둔다(없으면 결과 모양이 이전과 같다)
function feedbackField(delta) {
  const r = +delta.toFixed(4);
  return r ? { feedback: r } : {};
}

export function topTags(q, graph, vecs, k = 5) {
  return graph.tags
    .map(t => ({ id: t.id, label: t.label, sim: vecs.get('tag:' + t.id) ? cosine(q, vecs.get('tag:' + t.id)) : 0 }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, k)
    .map(t => ({ ...t, sim: +t.sim.toFixed(4) }));
}

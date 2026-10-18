// 그래프 검색: 문장 벡터 → (1) 노드와 직접 비교 + (2) 추상 태그와 비교 후 태그를 가진 노드로 한 홉 이동

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * @param {number[]} q        질의 벡터
 * @param {object} graph      mergeGraphs 결과
 * @param {Map} vecs          'tag:<id>' | 'node:<id>' -> 벡터
 * @param {object} opts       { topK, directWeight, tagWeight, tagAgg, tagPenalty }
 *   tagAgg      'max'(가장 높은 태그) | 'top2mean'(상위 2개 평균, 태그 1개면 그 값)
 *   tagPenalty  태그 id -> 태그 유사도에서 뺄 값. 주제가 넓은 태그(예: 경제)로 쏠리는 것을 줄인다 (T-113)
 */
export function retrieve(q, graph, vecs, { topK = 3, directWeight = 0.45, tagWeight = 0.55, tagAgg = 'max', tagPenalty = {} } = {}) {
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
    return {
      node: n,
      score: directWeight * direct + tagWeight * tagScore + boost,
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

export function topTags(q, graph, vecs, k = 5) {
  return graph.tags
    .map(t => ({ id: t.id, label: t.label, sim: vecs.get('tag:' + t.id) ? cosine(q, vecs.get('tag:' + t.id)) : 0 }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, k)
    .map(t => ({ ...t, sim: +t.sim.toFixed(4) }));
}

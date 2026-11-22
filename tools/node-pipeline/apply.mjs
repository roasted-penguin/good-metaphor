// 노드 파이프라인(T-194) 반영 층: 승인된 후보 id 목록 → 공통 그래프 패치(노드 + 엣지) → 판본 올린 그래프.
// 원본 그래프 객체는 바꾸지 않는다. 결과는 validateGraph(태그 파일과 합친 해석된 그래프)로 다시 검사한다.
// 실제 extension/data/common/*.json에 쓰는 것은 CLI의 --write-real일 때만(이 작업에서는 .tmp 사본으로만 시연)
import { validateGraph, resolveCommonGraph } from '../../extension/lib/graph.js';
import { SOURCE_POLICY, checkNodeSources } from '../source-policy.mjs';

// 오늘(로컬) YYYY-MM-DD
export function today(now = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

// 판본 "YYYY.MM.DD-N": 같은 날이면 N+1, 아니면 오늘-1. 모르는 꼴이면 오늘-1
export function bumpVersion(version, day) {
  const d = day.replaceAll('-', '.');
  const m = String(version || '').match(/^(\d{4}\.\d{2}\.\d{2})-(\d+)$/);
  return m && m[1] === d ? `${d}-${Number(m[2]) + 1}` : `${d}-1`;
}

/**
 * 검사 결과(check의 results) + 승인 id → 패치
 * @param {Array} results   check 결과(각 { status, node, edges })
 * @param {string[]} approved  승인한 후보 id
 * @param {{ rules?: object, day: string }} opts  rules = 관심사 규칙(allowAliases가 아니면 별칭을 뺀다)
 * @returns {{ nodes, edges, refused: Array<{id, reason}> }}
 *   실패(fail) 후보·없는 id는 거절. 엣지는 그래프에 있거나 이번에 승인된 노드끼리만(apply에서 다시 거른다)
 */
export function buildPatch(results, approved, { rules = {}, day }) {
  // 같은 id가 여럿이면(묶음 안 중복은 뒤쪽이 실패) 실패가 아닌 쪽
  const byId = new Map();
  for (const r of results) if (!byId.has(r.node.id) || byId.get(r.node.id).status === 'fail') byId.set(r.node.id, r);
  const refused = [], nodes = [], pending = [];
  for (const id of [...new Set(approved)]) {
    const r = byId.get(id);
    if (!r) { refused.push({ id, reason: '묶음에 없는 id' }); continue; }
    if (r.status === 'fail') { refused.push({ id, reason: '검사 실패 후보: ' + r.fails.join(', ') }); continue; }
    const { aliases, ...rest } = r.node;
    const node = { ...rest, ...(rules.allowAliases && aliases?.length ? { aliases } : {}), verifiedAt: day };
    // 키 순서를 기존 그래프와 맞춘다: id, label, aliases, facts, tags, sources, sourceKind(커뮤니티만, ADR 0016), verifiedAt
    nodes.push(Object.fromEntries(['id', 'label', 'aliases', 'facts', 'tags', 'sources', 'sourceKind', 'verifiedAt'].filter(k => node[k] !== undefined).map(k => [k, node[k]])));
    for (const e of r.edges || []) pending.push({ from: id, to: e.to, rel: e.rel });
  }
  return { nodes, edges: pending, refused };
}

/**
 * 그래프 원본(파일 그대로, tags 없음) + 패치 → 새 그래프 원본. 판본·노드·엣지만 바뀐다
 * @returns {{ graph, added: { nodes, edges }, skippedEdges, errors }}  errors = 태그 파일과 합쳐 validateGraph
 */
export function applyPatch(rawGraph, patch, { tagsFile, day }) {
  const ids = new Set(rawGraph.nodes.map(n => n.id));
  const nodes = patch.nodes.filter(n => !ids.has(n.id));
  const all = new Set([...ids, ...nodes.map(n => n.id)]);
  const have = new Set((rawGraph.edges || []).map(e => `${e.from}>${e.to}`));
  const edges = [], skippedEdges = [];
  for (const e of patch.edges) {
    if (!all.has(e.from) || !all.has(e.to) || have.has(`${e.from}>${e.to}`)) { skippedEdges.push(e); continue; }
    have.add(`${e.from}>${e.to}`);
    edges.push(e);
  }
  const graph = {
    ...rawGraph,
    version: bumpVersion(rawGraph.version, day),
    nodes: [...rawGraph.nodes, ...nodes],
    edges: [...(rawGraph.edges || []), ...edges]
  };
  const errors = validateGraph(resolveCommonGraph(graph, tagsFile));
  // 출처 정책(D-5·D-8, ADR 0016): 새 노드만 다시 본다(그래프 테스트와 같은 판정)
  if (SOURCE_POLICY.interests[rawGraph.id]) {
    for (const n of nodes) for (const e of checkNodeSources(n, rawGraph.id)) errors.push(`노드 ${n.id} 출처 정책: ${e}`);
  }
  return { graph, added: { nodes: nodes.length, edges: edges.length }, skippedEdges, errors };
}

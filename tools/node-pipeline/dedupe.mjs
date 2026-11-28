// 노드 파이프라인(T-205) 묶음 사이 중복: 같은 id 또는 같은 이름(정규화)이 서로 다른 묶음에 또 나오는 후보.
// 묶음 안 중복은 check(idDupBatch·labelDupBatch)가 이미 막는다. 묶음마다 따로 check를 돌려서, 같은 개념이
// 묶음 5·8에 모두 통과로 남으면 `--batch all`로 합칠 때 노드 두 개가 들어갔다(T-198 franchise_dispute_mediation).
//
// 판정(직접 정함, T-205):
//   - 같은 id 또는 같은 이름이면 한 무리로 묶는다(다리 놓기: A·B가 같은 id, B·C가 같은 이름이면 A·B·C 한 무리).
//     같은 이름 다른 id도 같은 개념으로 본다(그래프에 같은 이름 노드 둘은 검사 labelTaken과 같은 기준으로 안 된다)
//   - 무리에서 하나만 남긴다. 순서: ① 검사 판정이 좋은 쪽(통과 > 확인 > 실패, 이 중복 표시 전 판정) ② 사실이 많은 쪽
//     ③ 앞 묶음 ④ 같은 묶음이면 앞에 나온 쪽. ①②는 품질, ③은 먼저 검사·리뷰된 쪽을 흔들지 않으려는 것
//   - 나머지는 실패(dupCross)로 바꾸고 이유(남긴 후보의 묶음·id, 같은 id인지 같은 이름인지)를 notes·dupCross에 남긴다
//   - 이미 실패한 후보도 무리에 들어가지만(이름 다리 역할) 남길 후보로는 실패 아닌 쪽이 먼저다

const RANK = { pass: 0, warn: 1, fail: 2 };
export const normLabel = s => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[\s·・\-_()（）[\]]/g, '');

// 중복 표시 전 판정(다시 돌려도 같은 답이 나오게)
const baseStatus = r => r.dupCross?.statusBefore || r.status;

/**
 * @param {Array<{ batch:number, results:Array }>} batches  묶음 번호 순서 아니어도 됨
 * @returns {{ groups: Array<{ keep:{batch,id,label}, drop:Array<{batch,id,label,why}> }> }}
 *   서로 다른 묶음이 섞인 무리만 돌려준다(한 묶음 안 중복은 check 몫)
 */
export function crossBatchGroups(batches) {
  const items = [];
  for (const b of batches) (b.results || []).forEach((r, i) => items.push({ batch: b.batch, i, r, id: r.node?.id || '', key: normLabel(r.node?.label) }));
  // 합집합-찾기
  const parent = items.map((_, k) => k);
  const find = k => (parent[k] === k ? k : (parent[k] = find(parent[k])));
  const join = (a, b) => { const x = find(a), y = find(b); if (x !== y) parent[y] = x; };
  const byId = new Map(), byLabel = new Map();
  items.forEach((it, k) => {
    if (it.id) { if (byId.has(it.id)) join(byId.get(it.id), k); else byId.set(it.id, k); }
    if (it.key) { if (byLabel.has(it.key)) join(byLabel.get(it.key), k); else byLabel.set(it.key, k); }
  });
  const groups = new Map();
  items.forEach((it, k) => { const g = find(k); (groups.get(g) || groups.set(g, []).get(g)).push(it); });
  const out = [];
  for (const g of groups.values()) {
    if (new Set(g.map(x => x.batch)).size < 2) continue;
    const sorted = [...g].sort((a, b) =>
      RANK[baseStatus(a.r)] - RANK[baseStatus(b.r)] ||
      (b.r.node?.facts?.length || 0) - (a.r.node?.facts?.length || 0) ||
      a.batch - b.batch || a.i - b.i);
    const keep = sorted[0];
    out.push({
      keep: { batch: keep.batch, id: keep.id, label: keep.r.node?.label || '', status: baseStatus(keep.r) },
      drop: sorted.slice(1).map(x => ({ batch: x.batch, i: x.i, id: x.id, label: x.r.node?.label || '', status: baseStatus(x.r), why: x.id === keep.id ? 'sameId' : x.key === normLabel(keep.r.node?.label) ? 'sameLabel' : 'linked' }))
    });
  }
  return { groups: out };
}

const WHY = { sameId: '같은 id', sameLabel: '같은 이름', linked: '같은 id·이름으로 이어짐' };

// 결과 하나에 중복 표시(새 객체). 남길 후보가 같은 묶음이면 check의 묶음 안 중복 몫이라 여기서는 안 붙인다
export function markDup(r, keep, why) {
  const statusBefore = baseStatus(r);
  const fails = [...new Set([...(r.fails || []).filter(k => k !== 'dupCross'), 'dupCross'])];
  const note = `묶음 사이 중복(${WHY[why] || why}): 묶음 ${keep.batch} ${keep.id}를 남겨요`;
  return { ...r, status: 'fail', fails, notes: [...(r.notes || []).filter(n => !n.startsWith('묶음 사이 중복')), note], dupCross: { statusBefore, keep: { batch: keep.batch, id: keep.id }, why } };
}

/**
 * 여러 묶음 결과에 묶음 사이 중복을 반영한다(`--batch all`·check 공용). 입력은 바꾸지 않는다
 * @returns {{ batches: Array<{batch, results}>, groups }}
 */
export function resolveCrossBatch(batches) {
  const { groups } = crossBatchGroups(batches);
  const drops = new Map(); // `${batch}:${i}` → { keep, why }
  for (const g of groups) for (const d of g.drop) if (d.batch !== g.keep.batch) drops.set(`${d.batch}:${d.i}`, { keep: g.keep, why: d.why });
  const out = batches.map(b => ({ ...b, results: (b.results || []).map((r, i) => {
    const d = drops.get(`${b.batch}:${i}`);
    if (d) return markDup(r, d.keep, d.why);
    // 다시 돌렸더니 더는 중복이 아니면 표시를 걷는다
    if (r.dupCross) {
      const fails = r.fails.filter(k => k !== 'dupCross');
      const { dupCross, ...rest } = r;
      return { ...rest, status: dupCross.statusBefore, fails, notes: (r.notes || []).filter(n => !n.startsWith('묶음 사이 중복')) };
    }
    return r;
  }) }));
  return { batches: out, groups };
}

// 시트·로그용 한 줄
export function describeGroups(groups) {
  return groups.map(g => `${g.keep.id}(묶음 ${g.keep.batch}, ${g.keep.status}) 남김 ← ${g.drop.map(d => `묶음 ${d.batch} ${d.id}${d.id !== g.keep.id ? `「${d.label}」` : ''}(${WHY[d.why]}, ${d.status})`).join(', ')}`);
}

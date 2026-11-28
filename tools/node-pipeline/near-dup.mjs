// 노드 파이프라인(T-197, ADR 0015 제안 2·3) 근접 중복 관문과 태그 밀도 상한.
// T-193 측정: 근접 중복 노드는 어떤 검색 관문도 통과해 정확도를 무너뜨린다(합성 1,000노드에서 메이플 hit@1 54 → 5).
// 정확도는 검색 방식보다 무엇을 그래프에 넣느냐(중복·태그 정합)에 달려 있다. 그래서 check에서 먼저 거른다.
//
// 판정(직접 정함, T-197):
//   - 근접 중복은 "개념 글"(이름. 사실들)끼리 잰다. 노드 임베딩 글(nodeText)은 태그 설명·예문이 앞에 붙어서 태그가 같으면
//     사실이 달라도 가깝다(같은 구조 몰림은 태그 밀도 상한이 맡는다)
//   - 임베더는 Node e5(admin.embedding 모델, 한 문장씩). 미리 계산 벡터 파일(extension/data/vectors/, 실제 확장 크롬)은 쓰지 않는다:
//     같은 글을 Node와 크롬에서 임베딩하면 코사인 0.95~0.97밖에 안 돼(2026-11-22 측정, q8 계산 차이, ADR 0011) 기준선 0.9 근처를
//     재기에 잡음이 너무 크다. 비교 쌍은 늘 같은 임베더로 만든다. 모델을 못 쓰면 대체 임베더(글자 n-그램)로 같은 규칙
//   - 기준값은 숫자를 박지 않고 데이터에서 잰다: 기존 노드끼리 가장 가까운 쌍의 코사인(바닥). 후보가 기존 노드·앞선 후보와 바닥보다
//     가까우면 실패(nearDup), 바닥 − 0.03 이상이면 확인(nearDupClose). 근거(가장 가까운 노드·점수·바닥 쌍)를 결과에 남긴다
//   - 같은 사실 문장 재사용(정규화 글자 같음)은 코사인과 상관없이 실패(factReused). ADR 0015: 코사인만으로는 구분이 약하다
//   - 태그 밀도 상한: 한 태그를 단 노드 수(그래프 + 앞선 후보 + 이 후보)가 max(ceil(10% × 노드 수), 5)를 넘으면 확인(tagDense).
//     ADR 0015 제안 3("예: 관심사 노드의 10%, 넘치면 경고")을 따랐다. 최소 5는 작은 그래프에서 10%가 2~3이라 지금 그래프
//     (메이플 threshold_req 6/30, 식당 7/27)도 넘기 때문. 거르지 않고 경고만(같은 구조 노드는 대안 정답으로 쓸 수 있다)

export const NEAR_DUP_WARN_GAP = 0.03;
export const TAG_DENSITY_RATIO = 0.1;
export const TAG_DENSITY_MIN = 5;

export const conceptText = n => `${n.label}. ${(n.facts || []).join(' ')}`;
export const factKey = f => String(f ?? '').normalize('NFKC').replace(/[\s.,·・'"“”‘’()（）[\]!?~\-]/g, '');
const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const r3 = x => Math.round(x * 1000) / 1000;

// 기존 노드끼리 가장 가까운 쌍 { score, a, b }
export function nearDupFloor(nodes, vecs) {
  let best = { score: -1, a: null, b: null };
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const s = cos(vecs[i], vecs[j]);
    if (s > best.score) best = { score: s, a: nodes[i].id, b: nodes[j].id };
  }
  return { ...best, score: r3(best.score) };
}

const statusOf = r => (r.fails.length ? 'fail' : r.warns.length ? 'warn' : 'pass');

/**
 * 근접 중복 관문. 결과를 고쳐 그대로 돌려준다. 이미 실패한 후보는 건너뛰고, 통과한 후보는 다음 후보의 비교 대상이 된다
 * @param {Array} results  checkBatch 결과
 * @param {{ existing: Array<{id,label,facts}>, prior?: Array<{id,label,facts}>, embed: (texts: string[]) => Promise<number[][]>, embedderId: string, warnGap?: number }} opts
 *   existing = 공통 그래프 노드(바닥을 잼), prior = 앞 묶음에서 실패 안 한 후보(비교만)
 * @returns {Promise<{ embedderId, floor, failed: number, close: number, reused: number }>}
 */
export async function applyNearDup(results, { existing, prior = [], embed, embedderId, warnGap = NEAR_DUP_WARN_GAP }) {
  const pool = [...existing, ...prior];
  const poolVecs = await embed(pool.map(conceptText));
  const floor = nearDupFloor(existing, poolVecs.slice(0, existing.length));
  const facts = new Map();
  for (const n of pool) for (const f of n.facts || []) facts.set(factKey(f), n.id);
  const stat = { embedderId, floor, failed: 0, close: 0, reused: 0 };
  const live = results.filter(r => r.status !== 'fail');
  const vecs = await embed(live.map(r => conceptText(r.node)));
  const ids = pool.map(n => n.id), all = [...poolVecs];
  live.forEach((r, i) => {
    let best = { id: null, score: -1 };
    all.forEach((v, j) => { const s = cos(vecs[i], v); if (s > best.score) best = { id: ids[j], score: s }; });
    best.score = r3(best.score);
    const reused = (r.node.facts || []).map(f => facts.get(factKey(f))).filter(Boolean);
    r.nearDup = { embedderId, floor, best, ...(reused.length ? { reusedFrom: [...new Set(reused)] } : {}) };
    if (reused.length) { r.fails.push('factReused'); r.notes.push(`같은 사실: ${[...new Set(reused)].join(', ')}`); stat.reused++; }
    if (best.score > floor.score) { r.fails.push('nearDup'); r.notes.push(`근접 중복 ${best.id} ${best.score} > 바닥 ${floor.score}(${floor.a}~${floor.b})`); stat.failed++; }
    else if (best.score >= floor.score - warnGap) { r.warns.push('nearDupClose'); r.notes.push(`가까움 ${best.id} ${best.score} (바닥 ${floor.score})`); stat.close++; }
    r.status = statusOf(r);
    if (r.status !== 'fail') {
      ids.push(r.node.id); all.push(vecs[i]);
      for (const f of r.node.facts || []) facts.set(factKey(f), r.node.id);
    }
  });
  return stat;
}

/**
 * 태그 밀도 상한(경고만). 순서대로 실패 안 한 후보를 더해 가며 센다
 * @param {Array} results  검사 결과(태그 적합성 뒤)
 * @param {{ graphNodes: Array<{tags}>, prior?: Array<{tags}>, ratio?: number, min?: number }} opts
 * @returns {{ total: number, cap: number, counts: Array<[tag, before, after]> }}  after = 이 묶음까지 더한 수
 */
export function applyTagDensity(results, { graphNodes, prior = [], ratio = TAG_DENSITY_RATIO, min = TAG_DENSITY_MIN }) {
  const count = new Map();
  const add = n => { for (const t of n.tags || []) count.set(t, (count.get(t) || 0) + 1); };
  [...graphNodes, ...prior].forEach(add);
  const before = new Map(count);
  const live = results.filter(r => r.status !== 'fail');
  const total = graphNodes.length + prior.length + live.length;
  const cap = Math.max(Math.ceil(ratio * total), min);
  for (const r of live) {
    add(r.node);
    const over = (r.node.tags || []).filter(t => count.get(t) > cap);
    if (over.length) {
      r.warns.push('tagDense');
      r.notes.push(`태그 밀도: ${over.map(t => `${t} ${count.get(t)}/${cap}`).join(', ')}`);
      r.status = statusOf(r);
    }
  }
  const counts = [...count.keys()].map(t => [t, before.get(t) || 0, count.get(t)]).sort((a, b) => b[2] - a[2]);
  return { total, cap, counts };
}

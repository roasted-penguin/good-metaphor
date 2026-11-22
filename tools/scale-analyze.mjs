// 1,000노드 측정 결과로 검색 변경 후보를 크롬 없이 비교한다 (T-193, ADR 0015 제안).
//   node tools/scale-analyze.mjs      # 먼저 node tools/scale-bench.mjs 로 .tmp/scale(합성 그래프·벡터·질의 벡터)을 만든다
// 벡터는 실제 확장(크롬)에서 받은 것이라 점수는 확장과 같다. 단 합성 노드는 진짜 노드의 사실을 빌려 와 비관적이다.
import fs from 'node:fs';
import path from 'node:path';
import { mergeGraphs, embedItems, COMMON_INTERESTS } from '../extension/lib/graph.js';
import { loadCommonGraphFromDisk, commonGraphPath } from './load-graph.mjs';
import { retrieve } from '../extension/lib/retrieval.js';
import { precomputedIndex, precomputedPath } from '../extension/lib/precomputed-vectors.js';
import { scoreCases, mixedSetting, marginsOf } from './eval-lib.mjs';
import { createHash } from 'node:crypto';

const ROOT = path.resolve('.tmp/scale');
const admin = JSON.parse(fs.readFileSync('extension/config/admin.json', 'utf8'));
const Q = JSON.parse(fs.readFileSync(path.join(ROOT, 'query-vectors.json'), 'utf8'));
const sha1 = s => createHash('sha1').update(s, 'utf8').digest('hex');
const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const cases = {
  maplestory: [...JSON.parse(fs.readFileSync('tools/eval-set.json')), ...JSON.parse(fs.readFileSync('tools/eval-holdout.json'))],
  restaurant: JSON.parse(fs.readFileSync('tools/eval-set-restaurant.json'))
};

for (const { id } of COMMON_INTERESTS) {
  const synth = mergeGraphs(loadCommonGraphFromDisk(path.join(ROOT, 'src/data/common', `${id}.json`)), null);
  const orig = mergeGraphs(loadCommonGraphFromDisk(commonGraphPath(id)), null);
  // 합성 벡터 파일 + 동봉 실제 파일(두 관심사). 모두 같은 실제 확장 벡터라 한 조회표로 합친다
  const pre = new Map();
  for (const f of [path.join(ROOT, 'src', precomputedPath(id)), ...COMMON_INTERESTS.map(i => path.join('extension', precomputedPath(i.id)))]) {
    if (!fs.existsSync(f)) continue;
    for (const [h, v] of precomputedIndex(JSON.parse(fs.readFileSync(f, 'utf8')), { embedderId: Q.embedderId, passagePrefix: admin.embedding.passagePrefix ?? '' })) pre.set(h, v);
  }
  const vecsOf = g => new Map(embedItems(g, admin.retrieval).map(it => [it.key, pre.get(sha1(it.text))]));
  const qv = Q.qv[id];
  const cs = cases[id];
  const run = (g, opts = {}, filter = null) => {
    const vecs = vecsOf(g);
    const { topK, name: _n, ...base } = mixedSetting(admin, g);
    const ranks = cs.map((c, i) => {
      let gg = g;
      if (filter) { const keep = filter(qv[i], g, vecs); if (keep) gg = { ...g, nodes: g.nodes.filter(n => keep.has(n.id)) }; }
      return retrieve(qv[i], gg, vecs, { ...base, ...opts, topK: gg.nodes.length, aliasText: c.sentence }).map(x => ({ id: x.id, score: x.score }));
    });
    const rank = (c, i) => ranks[i];
    return { s: scoreCases(cs, rank), m: marginsOf(cs, rank), ranks, g };
  };
  const base = run(orig);
  const okOrig = new Set(base.m.filter(x => x.margin > 0).map(x => x.sentence));
  const baseNegFail = new Set(base.s.negative.fails.map(f => f.sentence));
  // 1위 변화 분류(ADR 0015 판정 기준): 원래 맞던 문장의 새 1위가 그 문장의 expectTag를 가지면 "같은 구조"(대안 정답 후보, 메인이
  // 사실로 설명되는지 한 줄씩 확인해야 정답), 아니면 "다른 구조"(진짜 회귀). expectTag가 없는 문장은 보수적으로 진짜 회귀. 음성 문장 새 실패도 진짜 회귀
  const classify = r => {
    const nodeById = new Map(r.g.nodes.map(n => [n.id, n]));
    const same = [], other = [];
    cs.forEach((c, i) => {
      if (!okOrig.has(c.sentence)) return;
      const top = r.ranks[i][0]?.id;
      if (c.expectNodes.includes(top)) return;
      const tags = nodeById.get(top)?.tags || [];
      (c.expectTag && tags.includes(c.expectTag) ? same : other).push({ s: c.sentence.slice(0, 28), top });
    });
    const negNew = r.s.negative.fails.filter(f => !baseNegFail.has(f.sentence)).map(f => ({ s: f.sentence.slice(0, 28), top: f.top }));
    return { same, other, negNew };
  };
  const line = (name, r, detail = false) => {
    const gained = r.m.filter(x => !okOrig.has(x.sentence) && x.margin > 0).length;
    const thin = r.m.filter(x => x.margin > 0 && x.margin < 0.005).length;
    const k = classify(r);
    console.log(`  ${name.padEnd(30)} hit@1 ${r.s.hit1}/${r.s.n} hit@3 ${r.s.hit3}  음성 ${r.s.negative.pass}/${r.s.negative.n}  1위 바뀜: 같은 구조 ${k.same.length} · 다른 구조(진짜 회귀) ${k.other.length + k.negNew.length}  얻음 ${gained}  얇은 여유 ${thin}`);
    if (detail) for (const x of [...k.other, ...k.negNew]) console.log(`      ✗ ${x.s}… → ${x.top}`);
    return k;
  };
  console.log(`\n[${id}] 원래 ${orig.nodes.length}노드 → 합성 ${synth.nodes.length}노드`);
  line('원래 그래프', base);
  // 현실 쪽 스트레스: 다른 관심사의 진짜 노드(검수된 서로 다른 개념, 태그 정상)를 그대로 더한다
  const other = COMMON_INTERESTS.map(i => i.id).filter(x => x !== id).map(x => mergeGraphs(loadCommonGraphFromDisk(commonGraphPath(x)), null));
  const cross = { ...orig, nodes: [...orig.nodes, ...other.flatMap(g => g.nodes.map(n => ({ ...n, id: 'x:' + n.id })))] };
  line(`다른 관심사 진짜 노드 더함(${cross.nodes.length})`, run(cross), true);
  line('합성 1,000 (지금 검색)', run(synth), true);
  // 밀도 곡선: 합성 노드를 앞에서부터 둔 그래프(같은 벡터)
  for (const N of [100, 200, 400, 700]) {
    if (N >= synth.nodes.length) continue;
    const keep = new Set(synth.nodes.slice(0, N).map(n => n.id));
    line(`합성 ${N}`, run({ ...synth, nodes: synth.nodes.filter(n => keep.has(n.id)) }));
  }
  // 후보 1: 태그 관문 두 단계 — 질의와 가까운 태그 T개를 가진 노드만 2단계에서 채점(없으면 전체)
  for (const T of [2, 3, 5]) {
    line(`태그 관문 T=${T}`, run(synth, {}, (q, g, vecs) => {
      const top = g.tags.map(t => ({ id: t.id, s: cos(q, vecs.get('tag:' + t.id) || q.map(() => 0)) })).sort((a, b) => b.s - a.s).slice(0, T).map(t => t.id);
      const keep = new Set(g.nodes.filter(n => (n.tags || []).some(t => top.includes(t))).map(n => n.id));
      return keep.size ? keep : null;
    }));
  }
  // 후보 2: 직접 유사도 1단계 상위 K개만 2단계 채점(K가 작을수록 태그 몫 쏠림이 줄어든다)
  for (const K of [20, 50]) {
    line(`직접 유사도 1단계 K=${K}`, run(synth, {}, (q, g, vecs) => new Set(g.nodes.map(n => ({ id: n.id, s: cos(q, vecs.get('node:' + n.id)) })).sort((a, b) => b.s - a.s).slice(0, K).map(x => x.id))));
  }
  // 근접 중복: 원래 노드마다 가장 가까운 합성 노드(노드 텍스트 코사인). 반자동 후보 관문 임계값 근거
  const sv = vecsOf(synth);
  const synthIds = synth.nodes.filter(n => n.id.startsWith('syn_')).map(n => n.id);
  const near = orig.nodes.map(n => Math.max(...synthIds.map(s => cos(sv.get('node:' + n.id), sv.get('node:' + s)))));
  const origPair = [];
  for (let i = 0; i < orig.nodes.length; i++) for (let j = i + 1; j < orig.nodes.length; j++) origPair.push(cos(sv.get('node:' + orig.nodes[i].id), sv.get('node:' + orig.nodes[j].id)));
  const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) * p)].toFixed(3); };
  console.log(`  원래 노드끼리 코사인: 중앙 ${q(origPair, 0.5)}, 95% ${q(origPair, 0.95)}, 최대 ${q(origPair, 1)}`);
  console.log(`  원래 노드 ↔ 가장 가까운 합성 노드: 중앙 ${q(near, 0.5)}, 최소 ${q(near, 0)}, 최대 ${q(near, 1)}`);
}

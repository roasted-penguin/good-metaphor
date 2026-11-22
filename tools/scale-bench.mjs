// 1,000노드 규모 측정 (T-193, ADR 0015). 합성 그래프는 .tmp/scale 아래에만 만든다(data/common에 넣지 않는다).
//   node tools/scale-bench.mjs [--nodes 1000] [--seed 7]
// 실제 확장(크롬, admin.embedding 모델)으로 잰다. 공유 크롬 잠금을 잡고 돌릴 것.
// 합성 노드: 두 관심사 공통 그래프의 사실 문장을 섞어 2~3개씩 고르고, 라벨은 원래 라벨 + 번호, 태그는 tags.json에서 1~3개.
// 진짜 노드의 사실을 그대로 빌려 오므로 "비슷한 노드가 아주 많은" 비관적 스트레스다(실제 확장 그래프보다 1위 다툼이 거칠다)
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { mergeGraphs, embedItems, sha1 as webSha1, COMMON_INTERESTS } from '../extension/lib/graph.js';
import { loadCommonGraphFromDisk, commonGraphPath } from './load-graph.mjs';
import { retrieve } from '../extension/lib/retrieval.js';
import { buildVectorFile, precomputedIndex, precomputedPath } from '../extension/lib/precomputed-vectors.js';
import { scoreCases, mixedSetting, marginsOf } from './eval-lib.mjs';
import { openBrowserEmbedder } from './browser-embedder.mjs';

const argv = process.argv;
const arg = (f, d) => { const i = argv.indexOf(f); return i > 0 ? argv[i + 1] : d; };
const TARGET = Number(arg('--nodes', 1000));
let seed = Number(arg('--seed', 7));
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = arr => arr[Math.floor(rnd() * arr.length)];

const admin = JSON.parse(fs.readFileSync('extension/config/admin.json', 'utf8'));
const tagsFile = JSON.parse(fs.readFileSync('extension/data/common/tags.json', 'utf8'));
const tagIds = tagsFile.tags.map(t => t.id);
const raws = Object.fromEntries(COMMON_INTERESTS.map(i => [i.id, JSON.parse(fs.readFileSync(commonGraphPath(i.id), 'utf8'))]));
const factPool = Object.values(raws).flatMap(g => g.nodes.flatMap(n => n.facts || []));

const ROOT = path.resolve('.tmp/scale');
const SRC = path.join(ROOT, 'src');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.cpSync('extension', SRC, { recursive: true });
fs.rmSync(path.join(SRC, 'data/vectors'), { recursive: true, force: true }); // 1단계: 미리 계산 없음

// 합성 그래프 쓰기(원래 노드 + 합성 노드 = TARGET)
const synth = {};
for (const [id, g] of Object.entries(raws)) {
  const extra = [];
  for (let k = 0; extra.length < TARGET - g.nodes.length; k++) {
    const base = pick(g.nodes);
    const facts = [...new Set(Array.from({ length: 2 + Math.floor(rnd() * 2) }, () => pick(factPool)))];
    const tags = [...new Set(Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(tagIds)))];
    extra.push({ id: `syn_${id}_${k}`, label: `${base.label} ${k + 1}호`, facts, tags, sources: base.sources, verifiedAt: base.verifiedAt });
  }
  const out = { ...g, nodes: [...g.nodes, ...extra] };
  fs.writeFileSync(path.join(SRC, 'data/common', `${id}.json`), JSON.stringify(out));
  synth[id] = mergeGraphs(loadCommonGraphFromDisk(path.join(SRC, 'data/common', `${id}.json`)), null);
}
const orig = Object.fromEntries(COMMON_INTERESTS.map(i => [i.id, mergeGraphs(loadCommonGraphFromDisk(commonGraphPath(i.id)), null)]));
const textsOf = g => [...new Set(embedItems(g, admin.retrieval).map(it => it.text))];
const report = { target: TARGET, interests: {} };
for (const id of Object.keys(synth)) report.interests[id] = { nodes: synth[id].nodes.length, texts: textsOf(synth[id]).length };
console.log('합성 그래프:', JSON.stringify(report.interests));
if (argv.includes('--dry')) process.exit(0);

const cases = {
  maplestory: [...JSON.parse(fs.readFileSync('tools/eval-set.json')), ...JSON.parse(fs.readFileSync('tools/eval-holdout.json'))],
  restaurant: JSON.parse(fs.readFileSync('tools/eval-set-restaurant.json'))
};
const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const p95 = a => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]; };

const collected = new Map(); // `${embedderId}|${sha1}` -> 벡터 (1단계 vecCache에서 모은다, 다시 임베딩하지 않게)
// 같은 out·프로필(.tmp/ext-eval, .tmp/ext-eval-profile) = 같은 확장 id = 모델 캐시 재사용(build:vectors·eval과 같은 자리).
// 열 때 embed:warmup이 기본 관심사(메이플) 그래프를 준비하므로 그 시간을 메이플 첫 로드로 쓴다(모델 로드 포함).
// 1,000노드 임베딩이 노드당 수백 ms라 캐시 지우고 다시 재는 일은 하지 않는다
async function session(src, label, collect = false) {
  const t0 = performance.now();
  const be = await openBrowserEmbedder({ src });
  const r = { openMs: Math.round(performance.now() - t0), openWarmupMs: be.warmupMs };
  const page = be.sw; // 서비스 워커에서 storage를 본다
  const setInterest = id => be.send('settings:save', { patch: { interest: id } });
  const bytes = () => page.evaluate(() => chrome.storage.local.getBytesInUse('vecCache'));
  const grab = async () => {
    if (!collect) return;
    const vc = await page.evaluate(async () => (await chrome.storage.local.get('vecCache')).vecCache || {});
    for (const [k, v] of Object.entries(vc)) collected.set(k, v);
  };
  r.perInterest = {};
  const ids = Object.keys(synth);
  for (const [n, id] of ids.entries()) {
    await setInterest(id);
    let t = performance.now();
    const w = await be.send('embed:warmup');
    const graphMs = n === 0 ? be.warmupMs : performance.now() - t; // 첫 관심사는 열 때 이미 준비됨
    t = performance.now();
    const w2 = await be.send('embed:warmup');
    const againMs = performance.now() - t;
    await grab();
    // 호버(데모 제공자, 캐시 없이) 10문장
    const hoverMs = [];
    for (const c of cases[id].slice(0, 10)) {
      const ex = await be.send('explain', { sentence: c.sentence, noCache: true });
      if (ex.ok) hoverMs.push(ex.data.debug.ms);
    }
    r.perInterest[id] = { graphMs: Math.round(graphMs), againMs: Math.round(againMs), sources: w.data.vectorSources, sources2: w2.data.vectorSources, vecCacheBytes: await bytes(), hoverMedMs: med(hoverMs), hoverP95Ms: p95(hoverMs) };
    console.log(label, id, JSON.stringify(r.perInterest[id]));
  }
  // 첫 관심사로 돌아가기: LRU 상한(VEC_CACHE_MAX)에 밀려 다시 임베딩하는 개수
  await setInterest(ids[0]);
  let t = performance.now();
  const back = await be.send('embed:warmup');
  r.switchBack = { ms: Math.round(performance.now() - t), sources: back.data.vectorSources };
  console.log(label, '되돌아가기', JSON.stringify(r.switchBack));
  r.vecCacheKeys = await page.evaluate(async () => Object.keys((await chrome.storage.local.get('vecCache')).vecCache || {}).length);
  r.vecCacheBytes = await bytes();
  // vecCache 통째 저장 시간(saveVecCache와 같은 set)
  r.vecCacheSaveMs = await page.evaluate(async () => {
    const { vecCache } = await chrome.storage.local.get('vecCache');
    const t = performance.now(); await chrome.storage.local.set({ vecCache }); return Math.round(performance.now() - t);
  });
  return { be, r };
}

// 1단계: 미리 계산 없이
const A = await session(SRC, '[미리 계산 없음]', true);
report.noPrecomputed = A.r;
const embedderId = A.be.embedderId;
// 벡터 모으기: 각 관심사 준비 직후 vecCache에서 모은 것(확장이 실제로 쓴 벡터). 없으면 다시 임베딩
const vecByText = new Map();
const qv = {};
for (const id of Object.keys(synth)) {
  const need = [];
  for (const t of textsOf(synth[id])) {
    const v = collected.get(`${embedderId}|${await webSha1(t)}`);
    if (v) vecByText.set(t, v); else if (!vecByText.has(t)) need.push(t);
  }
  if (need.length) {
    console.log(`${id}: vecCache에 없는 ${need.length}개 다시 임베딩`);
    const vs = await A.be.embed(need, 'passage');
    need.forEach((t, i) => vecByText.set(t, vs[i]));
  }
  qv[id] = await A.be.embed(cases[id].map(c => c.sentence), 'query');
}
await A.be.close();
// 오프라인 분석용(검색 변경 제안을 크롬 없이 시험): 질의 벡터 저장. 그래프 벡터는 아래 2단계 벡터 파일에 있다
fs.writeFileSync(path.join(ROOT, 'query-vectors.json'), JSON.stringify({ embedderId, qv, sentences: Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, v.map(c => c.sentence)])) }));

// 검색 시간·여유: 원래 그래프 vs 합성 그래프(같은 질의 벡터)
report.retrieval = {};
for (const id of Object.keys(synth)) {
  const out = {};
  for (const [name, g] of [['original', orig[id]], ['synthetic', synth[id]]]) {
    const vecs = new Map(embedItems(g, admin.retrieval).map(it => [it.key, vecByText.get(it.text)]));
    const { topK, name: _n, ...base } = mixedSetting(admin, g);
    const times = [];
    const ranks = cases[id].map((c, i) => {
      const t = performance.now();
      const rr = retrieve(qv[id][i], g, vecs, { ...base, topK: g.nodes.length, aliasText: c.sentence }).map(x => ({ id: x.id, score: x.score }));
      times.push(performance.now() - t);
      return rr;
    });
    const rank = (c, i) => ranks[i];
    const s = scoreCases(cases[id], rank);
    const m = marginsOf(cases[id], rank);
    out[name] = { n: s.n, hit1: s.hit1, hit3: s.hit3, negative: `${s.negative.pass}/${s.negative.n}`, retrieveMedMs: +med(times).toFixed(2), retrieveP95Ms: +p95(times).toFixed(2), margins: m, misses: s.misses.map(x => ({ s: x.sentence.slice(0, 30), got: x.got[0], exp: x.expect })) };
  }
  // 원래 그래프에서 맞힌 문장이 합성 그래프에서 틀린 것(합성 노드에게 1위를 빼앗김)
  const okOrig = new Set(out.original.margins.filter(x => x.margin > 0).map(x => x.sentence));
  const lost = out.synthetic.margins.filter(x => okOrig.has(x.sentence) && x.margin <= 0);
  const mo = new Map(out.original.margins.map(x => [x.sentence, x.margin]));
  out.rank1Lost = lost.length;
  out.marginDrop = out.synthetic.margins.filter(x => mo.has(x.sentence)).map(x => ({ s: x.sentence.slice(0, 30), before: +mo.get(x.sentence).toFixed(4), after: +x.margin.toFixed(4) }));
  // 밀도 곡선: 합성 노드를 앞에서부터 N개까지만 둔 그래프(같은 벡터)로 1위 잃음·여유 중앙값
  out.curve = [];
  for (const N of [orig[id].nodes.length, 100, 200, 400, 700, synth[id].nodes.length]) {
    if (N > synth[id].nodes.length) continue;
    const keepIds = new Set(synth[id].nodes.slice(0, N).map(n => n.id));
    const g = { ...synth[id], nodes: synth[id].nodes.filter(n => keepIds.has(n.id)), edges: (synth[id].edges || []).filter(e => keepIds.has(e.from) && keepIds.has(e.to)) };
    const vecs = new Map(embedItems(g, admin.retrieval).map(it => [it.key, vecByText.get(it.text)]));
    const { topK, name: _n, ...base } = mixedSetting(admin, g);
    const ranks = cases[id].map((c, i) => retrieve(qv[id][i], g, vecs, { ...base, topK: g.nodes.length, aliasText: c.sentence }).map(x => ({ id: x.id, score: x.score })));
    const sc = scoreCases(cases[id], (c, i) => ranks[i]);
    const ms = marginsOf(cases[id], (c, i) => ranks[i]);
    const lostN = ms.filter(x => okOrig.has(x.sentence) && x.margin <= 0).length;
    const pos = ms.filter(x => x.margin > 0).map(x => x.margin);
    out.curve.push({ N, hit1: sc.hit1, n: sc.n, negative: `${sc.negative.pass}/${sc.negative.n}`, rank1Lost: lostN, thin005: pos.filter(m => m < 0.005).length, marginMed: pos.length ? +med(pos).toFixed(4) : null });
  }
  console.log(id, '밀도 곡선', JSON.stringify(out.curve));
  report.retrieval[id] = out;
  console.log(id, `원래 hit@1 ${out.original.hit1}/${out.original.n} → 합성 ${out.synthetic.hit1}/${out.synthetic.n}, 1위 잃음 ${lost.length}, 검색 중앙 ${out.original.retrieveMedMs}→${out.synthetic.retrieveMedMs}ms`);
}

// 2단계: 미리 계산 벡터 동봉
fs.mkdirSync(path.join(SRC, 'data/vectors'), { recursive: true });
report.vectorFiles = {};
for (const id of Object.keys(synth)) {
  const entries = [];
  for (const t of textsOf(synth[id])) entries.push({ hash: await webSha1(t), vector: vecByText.get(t) });
  const file = buildVectorFile({ interest: id, embedderId, passagePrefix: admin.embedding.passagePrefix ?? '', entries });
  const p = path.join(SRC, precomputedPath(id));
  fs.writeFileSync(p, JSON.stringify(file, null, 1));
  const raw = fs.readFileSync(p, 'utf8');
  const t = performance.now();
  const idx = precomputedIndex(JSON.parse(raw), { embedderId, passagePrefix: admin.embedding.passagePrefix ?? '' });
  report.vectorFiles[id] = { count: file.count, bytes: raw.length, nodeDecodeMs: Math.round(performance.now() - t), decoded: idx.size };
}
console.log('벡터 파일:', JSON.stringify(report.vectorFiles));
const B = await session(SRC, '[미리 계산 있음]');
report.precomputed = B.r;
await B.be.close();

fs.writeFileSync(path.join(ROOT, 'report.json'), JSON.stringify(report, null, 1));
console.log('보고:', path.join(ROOT, 'report.json'));

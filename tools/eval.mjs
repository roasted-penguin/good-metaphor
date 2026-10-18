// 검색 품질 평가: 문장별로 기대 노드가 상위 1개·3개 안에 드는지, 가중치 설정별로 비교한다.
// 사용법 (프로젝트 루트에서):
//   npm install                            # 처음 한 번
//   npm run eval                       # 실제 임베딩 모델 (약 120MB 다운로드), -- -v 로 틀린 문장 출력
//   npm run eval:fallback              # 글자 n-gram 대체 임베더
import fs from 'node:fs';
import { mergeGraphs, tagText, nodeText } from '../extension/lib/graph.js';
import { retrieve, topTags } from '../extension/lib/retrieval.js';
import { hashEmbed } from '../extension/lib/fallback-embed.js';
import { scoreCases, mixedSetting } from './eval-lib.mjs';

const here = new URL('.', import.meta.url);
const admin = JSON.parse(fs.readFileSync(new URL('../extension/config/admin.json', here)));
const common = JSON.parse(fs.readFileSync(new URL('../extension/data/common/maplestory.json', here)));
const sets = [
  { name: '평가셋', cases: JSON.parse(fs.readFileSync(new URL('./eval-set.json', here))) },
  // 검증셋: 가중치·텍스트 조정에 쓰지 않는 문장 (T-113). 과적합 확인용
  { name: '검증셋', cases: JSON.parse(fs.readFileSync(new URL('./eval-holdout.json', here))) }
];
const useFallback = process.argv.includes('--fallback');
const verbose = process.argv.includes('-v');

let embed;
if (useFallback) {
  embed = async (texts, kind) => texts.map(t => hashEmbed(t));
} else {
  const { pipeline } = await import('@huggingface/transformers');
  const cfg = admin.embedding;
  console.log(`모델 불러오는 중: ${cfg.model} (${cfg.dtype})`);
  const ex = await pipeline('feature-extraction', cfg.model, { dtype: cfg.dtype });
  embed = async (texts, kind) => {
    const prefix = kind === 'query' ? cfg.queryPrefix : cfg.passagePrefix;
    return (await ex(texts.map(t => prefix + t), { pooling: 'mean', normalize: true })).tolist();
  };
}

const graph = mergeGraphs(common, null);
const tagMap = new Map(graph.tags.map(t => [t.id, t]));
const keys = [...graph.tags.map(t => 'tag:' + t.id), ...graph.nodes.map(n => 'node:' + n.id)];
const texts = [...graph.tags.map(tagText), ...graph.nodes.map(n => nodeText(n, tagMap))];
const vs = await embed(texts, 'passage');
const vecs = new Map(keys.map((k, i) => [k, vs[i]]));
const settings = [
  { name: '노드 직접 비교만', directWeight: 1, tagWeight: 0 },
  { name: '태그 경유만 (그래프 홉)', directWeight: 0, tagWeight: 1 },
  mixedSetting(admin)
];
const pct = (a, b) => `${a}/${b} (${Math.round(a / b * 100)}%)`;

for (const { name, cases } of sets) {
  const qs = await embed(cases.map(c => c.sentence), 'query');
  console.log(`\n[${name}] 문장 ${cases.length}개 · 임베더: ${useFallback ? 'fallback n-gram' : admin.embedding.model}\n`);
  for (const s of settings) {
    const { topK, ...opts } = s;
    const r = scoreCases(cases, (c, i) => retrieve(qs[i], graph, vecs, { ...opts, topK: 3 }).map(x => x.id));
    const groups = Object.entries(r.groups).map(([g, v]) => `  ${g} ${v.hit1}/${v.n}`).join('');
    console.log(`${s.name.padEnd(18)}  hit@1 ${pct(r.hit1, r.n)}  hit@3 ${pct(r.hit3, r.n)}${groups}`);
    if (verbose) for (const m of r.misses) console.log(`  ✗ ${m.sentence.slice(0, 32)}… → ${m.got.join(', ')} (기대: ${m.expect.join('/')})`);
  }
  let t1 = 0;
  cases.forEach((c, i) => { if (topTags(qs[i], graph, vecs, 1)[0]?.id === c.expectTag) t1++; });
  console.log(`\n추상 태그 top-1 정확도: ${pct(t1, cases.length)}`);
}

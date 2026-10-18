// 검색 품질 평가: 문장별로 기대 노드가 상위 1개·3개 안에 드는지, 가중치 설정별로 비교한다.
// 사용법 (프로젝트 루트에서):
//   npm install                            # 처음 한 번
//   npm run eval                       # 실제 임베딩 모델 (약 120MB 다운로드), -- -v 로 틀린 문장 출력
//   npm run eval:fallback              # 글자 n-gram 대체 임베더
//   npm run eval -- --rewrite gemini   # 질의를 LLM으로 추상 구조로 바꿔 함께 비교 (T-113 (4)). <ID>_API_KEY 필요,
//                                      # 결과는 .tmp/rewrite-<제공자>-<모델>.json 에 캐시(다시 돌려도 호출 안 함)
import fs from 'node:fs';
import { mergeGraphs, tagText, nodeText } from '../extension/lib/graph.js';
import { retrieve, topTags } from '../extension/lib/retrieval.js';
import { hashEmbed } from '../extension/lib/fallback-embed.js';
import { scoreCases, mixedSetting, regressions } from './eval-lib.mjs';
import { PROVIDERS, complete } from '../extension/lib/providers.js';
import { buildAbstractPrompt, rewriteQueryText } from '../extension/lib/prompt.js';

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
// 회귀 가드: 지금 맞히는 문장은 계속 맞혀야 한다(사용자 원칙, T-113). --guard면 하나라도 틀릴 때 종료 코드 1.
// 어떤 변경이 문장을 새로 맞히면 그 PR에서 eval-guard.json에 더한다. 빼는 것은 사용자 승인 없이 하지 않는다.
// 가드 목록은 실제 모델(admin.embedding) 기준이다. --fallback과 함께 쓰면 의미가 없다
const guard = JSON.parse(fs.readFileSync(new URL('./eval-guard.json', here)));
const failGuard = process.argv.includes('--guard');
let regressed = 0;

// 질의 재작성 (정밀 모드와 같은 프롬프트). 문장별 결과를 캐시해 무료 한도를 아끼고 결과를 고정한다
const rwAt = process.argv.indexOf('--rewrite');
const rewriteId = rwAt > 0 ? process.argv[rwAt + 1] : null;
let rewrites = null, rewriteCacheFile = null;
if (rewriteId) {
  const def = PROVIDERS[rewriteId];
  if (!def) throw new Error(`알 수 없는 제공자: ${rewriteId}`);
  const env = rewriteId.toUpperCase();
  const provider = { id: rewriteId, def, model: process.env[`${env}_MODEL`] || admin.defaultModels?.[rewriteId] || def.defaultModel, apiKey: process.env[`${env}_API_KEY`] || '', baseUrl: def.baseUrl };
  rewriteCacheFile = new URL(`../.tmp/rewrite-${rewriteId}-${provider.model.replace(/[^\w.-]/g, '_')}.json`, here);
  rewrites = fs.existsSync(rewriteCacheFile) ? JSON.parse(fs.readFileSync(rewriteCacheFile)) : {};
  for (const c of sets.flatMap(x => x.cases)) {
    if (rewrites[c.sentence]) continue;
    const p = buildAbstractPrompt({ sentence: c.sentence });
    // 무료 한도(분당 요청)에 걸리면 기다렸다 다시. 평가 도구 전용
    for (let tries = 0; ; tries++) {
      try { rewrites[c.sentence] = (await complete(provider, p.system, p.user, { json: false })).trim(); break; }
      catch (e) {
        if (tries >= 4 || !(e.status === 429 || e.status >= 500)) throw e;
        console.log(`  ${e.status}, 30초 뒤 다시 (${tries + 1}/4)`);
        await new Promise(r => setTimeout(r, 30000));
      }
    }
    fs.mkdirSync(new URL('../.tmp/', here), { recursive: true });
    fs.writeFileSync(rewriteCacheFile, JSON.stringify(rewrites, null, 2));
  }
  console.log(`질의 재작성: ${rewriteId} ${provider.model} (캐시 ${rewriteCacheFile.pathname})`);
}
const queryModes = rewrites ? [['원문', null], ['정밀(추상+원문)', 'precise'], ['추상만', 'abstract']] : [['원문', null]];

let embed;
if (useFallback) {
  embed = async (texts, kind) => texts.map(t => hashEmbed(t));
} else {
  const { pipeline } = await import('@huggingface/transformers');
  const cfg = admin.embedding;
  console.log(`모델 불러오는 중: ${cfg.model} (${cfg.dtype})`);
  const ex = await pipeline('feature-extraction', cfg.model, { dtype: cfg.dtype });
  // q8은 같은 문장도 함께 묶인 배치에 따라 벡터가 조금 달라진다(활성값 양자화 스케일이 배치 단위).
  // 확장과 같게 노드·태그는 한 배치로, 질의는 한 문장씩 임베딩해 결과를 고정한다 (T-113)
  const run = async texts => (await ex(texts, { pooling: 'mean', normalize: true })).tolist();
  embed = async (texts, kind) => {
    if (kind === 'passage') return run(texts.map(t => cfg.passagePrefix + t));
    const out = [];
    for (const t of texts) out.push((await run([cfg.queryPrefix + t]))[0]);
    return out;
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

for (const [modeName, mode] of queryModes) for (const { name, cases } of sets) {
  const qs = await embed(cases.map(c => mode ? rewriteQueryText(rewrites[c.sentence], c.sentence, mode) : c.sentence), 'query');
  console.log(`\n[${name}${rewrites ? ' · 질의 ' + modeName : ''}] 문장 ${cases.length}개 · 임베더: ${useFallback ? 'fallback n-gram' : admin.embedding.model}\n`);
  for (const s of settings) {
    const { topK, ...opts } = s;
    const r = scoreCases(cases, (c, i) => retrieve(qs[i], graph, vecs, { ...opts, topK: 3 }).map(x => x.id));
    const groups = Object.entries(r.groups).map(([g, v]) => `  ${g} ${v.hit1}/${v.n}`).join('');
    console.log(`${s.name.padEnd(18)}  hit@1 ${pct(r.hit1, r.n)}  hit@3 ${pct(r.hit3, r.n)}${groups}`);
    if (verbose) for (const m of r.misses) console.log(`  ✗ ${m.sentence.slice(0, 32)}… → ${m.got.join(', ')} (기대: ${m.expect.join('/')})`);
    if (s.name === mixedSetting(admin).name) {
      const reg = regressions(guard, r);
      regressed += reg.length;
      console.log(reg.length ? reg.map(x => `  ⚠ 회귀(잘 맞던 문장이 틀림): ${x}`).join('\n') : '  회귀 없음');
    }
  }
  let t1 = 0;
  cases.forEach((c, i) => { if (topTags(qs[i], graph, vecs, 1)[0]?.id === c.expectTag) t1++; });
  console.log(`\n추상 태그 top-1 정확도: ${pct(t1, cases.length)}`);
}
if (failGuard && regressed) { console.log(`\n회귀 ${regressed}건`); process.exit(1); }

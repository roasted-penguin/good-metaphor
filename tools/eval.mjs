// 검색 품질 평가: 문장별로 기대 노드가 상위 1개·3개 안에 드는지, 가중치 설정별로 비교한다.
// 사용법 (프로젝트 루트에서):
//   npm install                            # 처음 한 번
//   npm run eval                       # 실제 모델을 실제 확장(크롬, wasm) 안에서 임베딩해 잰다. -- -v 로 틀린 문장 출력
//   npm run eval -- --node             # Node(onnxruntime-node)로 빠르게. q8 계산이 브라우저와 달라 수치가 실제와 다를 수 있다(T-128)
//   npm run eval:fallback              # 글자 n-gram 대체 임베더
//   npm run eval -- --rewrite gemini   # 질의를 LLM으로 추상 구조로 바꿔 함께 비교 (T-113 (4)). <ID>_API_KEY 필요,
//                                      # 결과는 .tmp/rewrite-<제공자>-<모델>.json 에 캐시(다시 돌려도 호출 안 함)
//   npm run eval -- --server <url>     # 같은 문장을 analogy-api(POST /v1/analogy)의 debug.candidates 순위로도 채점하고 관문 한 줄 (T-405)
//        [--server-only]               # 브라우저 평가 생략   [--rpm 20] 분당 요청 수   [--token <값>] 기본은 eval-<무작위>
//   npm run eval -- --holdout          # 평가셋·검증셋 대신 홀드아웃(tools/eval-unseen.json, 예문 고를 때 보지 않는 문장)만 채점 (T-150)
//   [--margin 0.005]                   # 여유(1위 − 경쟁자 점수 차)가 이보다 작은 맞힌 문장을 요약 끝에 목록으로 (T-150). -v면 문장별 여유
//   [--retrieval '{"nodeTextMode":"desc"}']  # admin.retrieval 위에 덮어쓸 설정(JSON). 측정용, 파일은 바꾸지 않는다 (T-154)
//   npm run eval -- --interest restaurant  # 다른 공통 관심사 그래프로 그 관심사 평가셋(tools/eval-set-<id>.json)만 채점 (T-302, 가드 없음. --guard·--holdout·--margin-guard·--server와 같이 쓰면 오류)
//   [--margin-guard]                   # 가드 문장 중 여유가 --margin 미만이면 종료 코드 1 (선택, 여유 경고는 기본으로 실패가 아님)
import fs from 'node:fs';
import { mergeGraphs, embedItems } from '../extension/lib/graph.js';
import { loadInterestGraph, interestFromArgv } from './load-graph.mjs';
import { commonInterest } from '../extension/lib/graph.js';
import { retrieve, topTags } from '../extension/lib/retrieval.js';
import { hashEmbed } from '../extension/lib/fallback-embed.js';
import { embedEach } from '../extension/lib/embed-each.js';
import { openBrowserEmbedder } from './browser-embedder.mjs';
import { scoreCases, mixedSetting, regressions, marginsOf, lowMargins, marginGuardFails, fmtMargin, lowMarginLines, missLine, marginThreshold, pickSets, interestArgError } from './eval-lib.mjs';
import { PROVIDERS, complete } from '../extension/lib/providers.js';
import { buildAbstractPrompt, rewriteQueryText } from '../extension/lib/prompt.js';
import { rankAllViaServer, gateLine, ServerUnavailable } from './eval-server.mjs';

const here = new URL('.', import.meta.url);
const admin = JSON.parse(fs.readFileSync(new URL('../extension/config/admin.json', here)));
// --retrieval '<JSON>': admin.retrieval에 덮어써 같은 방식(임베딩 텍스트·점수)으로 채점한다 (T-154)
const retrievalAt = process.argv.indexOf('--retrieval');
if (retrievalAt > 0) {
  const over = JSON.parse(process.argv[retrievalAt + 1]);
  admin.retrieval = { ...admin.retrieval, ...over };
  console.log(`retrieval 덮어쓰기: ${JSON.stringify(over)}`);
}
// --interest <id>: 공통 관심사(T-302). 기본은 메이플
const interest = commonInterest(interestFromArgv(process.argv));
const isDefaultInterest = interest.id === 'maplestory';
// 메이플 전용 옵션(--guard·--holdout·--margin-guard·--server)을 다른 관심사와 같이 주면 바로 멈춘다
{ const err = interestArgError(process.argv, interest); if (err) throw new Error(err); }
const common = loadInterestGraph(interest.id); // 그래프 + tags.json (T-304)
console.log(`관심사: ${interest.label} (${common.id} ${common.version})`);
const readSet = f => JSON.parse(fs.readFileSync(new URL(f, here)));
// 평가셋·검증셋(eval-holdout.json), --holdout이면 홀드아웃(eval-unseen.json)만 (T-150). 다른 관심사면 그 관심사 평가셋만
const sets = pickSets(process.argv, {
  evalSet: isDefaultInterest ? readSet('./eval-set.json') : [],
  validation: isDefaultInterest ? readSet('./eval-holdout.json') : [],
  holdout: isDefaultInterest && process.argv.includes('--holdout') ? readSet('./eval-unseen.json') : [],
  interestSet: isDefaultInterest ? [] : readSet(`./eval-set-${interest.id}.json`)
}, interest);
const useFallback = process.argv.includes('--fallback');
const verbose = process.argv.includes('-v');
// 회귀 가드: 지금 맞히는 문장은 계속 맞혀야 한다(사용자 원칙, T-113). --guard면 하나라도 틀릴 때 종료 코드 1.
// 어떤 변경이 문장을 새로 맞히면 그 PR에서 eval-guard.json에 더한다. 빼는 것은 사용자 승인 없이 하지 않는다.
// 가드 목록은 실제 모델(admin.embedding) 기준이다. --fallback과 함께 쓰면 의미가 없다
const guard = JSON.parse(fs.readFileSync(new URL('./eval-guard.json', here)));
const failGuard = process.argv.includes('--guard');
let regressed = 0;
// 여유(T-150): 정보용 경고. --margin-guard일 때만 가드 문장의 작은 여유를 실패로 친다
const marginMin = marginThreshold(process.argv);
const failMarginGuard = process.argv.includes('--margin-guard');
let marginGuardFailed = [];

// 서버 모드 (T-405). 토큰은 평가용 무작위 문자열이고 출력하지 않는다
const argAfter = flag => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : null; };
const serverUrl = argAfter('--server');
const serverOnly = !!serverUrl && process.argv.includes('--server-only');
const serverRpm = Number(argAfter('--rpm')) || 20;
const serverToken = argAfter('--token') || `eval-${Math.random().toString(36).slice(2, 12)}`;
if (process.argv.includes('--server-only') && !serverUrl) throw new Error('--server-only는 --server <url>과 함께 써요');
let browserHit1 = null; // 평가셋 · 원문 · 혼합 hit@1 (관문 비교용)

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

let embed, embedderLabel, closeEmbedder = async () => {};
if (serverOnly) {
  // 브라우저 평가 생략
} else if (useFallback) {
  embed = async (texts, kind) => texts.map(t => hashEmbed(t));
  embedderLabel = 'fallback n-gram';
} else if (!process.argv.includes('--node')) {
  console.log(`확장 안에서 모델 준비 중: ${admin.embedding.model} (${admin.embedding.dtype}, 첫 실행은 다운로드)`);
  const be = await openBrowserEmbedder();
  embed = be.embed;
  closeEmbedder = be.close;
  embedderLabel = `${be.embedderId} · 브라우저`;
} else {
  const { pipeline } = await import('@huggingface/transformers');
  const cfg = admin.embedding;
  console.log(`모델 불러오는 중: ${cfg.model} (${cfg.dtype})`);
  const ex = await pipeline('feature-extraction', cfg.model, { dtype: cfg.dtype });
  // 확장 오프스크린과 같게 노드·태그·질의 모두 한 문장씩 (q8은 묶음에 따라 벡터가 달라진다, T-128)
  const run = async texts => (await ex(texts, { pooling: 'mean', normalize: true })).tolist();
  embed = async (texts, kind) => embedEach(texts.map(t => (kind === 'query' ? cfg.queryPrefix : cfg.passagePrefix) + t), run);
  embedderLabel = `${cfg.model} · Node (확장과 다를 수 있음)`;
}

const graph = mergeGraphs(common, null);
// 확장(ensureGraphVectors)과 같은 함수·같은 설정으로 임베딩 항목을 만든다 (T-154)
const items = embedItems(graph, admin.retrieval);
const embedStart = Date.now();
const vs = serverOnly ? [] : await embed(items.map(it => it.text), 'passage');
if (!serverOnly) console.log(`그래프 벡터 ${items.length}개 임베딩 ${Date.now() - embedStart}ms`);
const vecs = new Map(items.map((it, i) => [it.key, vs[i]]));
const settings = [
  { name: '노드 직접 비교만', directWeight: 1, tagWeight: 0 },
  { name: '태그 경유만 (그래프 홉)', directWeight: 0, tagWeight: 1 },
  mixedSetting(admin)
];
const pct = (a, b) => `${a}/${b} (${Math.round(a / b * 100)}%)`;

const pctLine = (label, r) => {
  const groups = Object.entries(r.groups).map(([g, v]) => `  ${g} ${v.hit1}/${v.n}`).join('');
  return `${label.padEnd(18)}  hit@1 ${pct(r.hit1, r.n)}  hit@3 ${pct(r.hit3, r.n)}${groups}`;
};
// 회귀(가드 기준)와 T-103 새 문장 줄. 브라우저 혼합 줄과 서버 줄이 함께 쓴다
function printGuardAndNew(cases, r, rank, guarded = true) {
  if (!guarded) { console.log('  (회귀 가드 대상 아님)'); return; }
  const reg = regressions(guard, r);
  regressed += reg.length;
  console.log(reg.length ? reg.map(x => `  ⚠ 회귀(잘 맞던 문장이 틀림): ${x}`).join('\n') : '  회귀 없음');
  // 조정에 쓰지 않은 T-103 새 문장만 따로 (깨끗한 확인용)
  const idx = cases.map((c, i) => [c, i]).filter(([c]) => c.since === 'T-103');
  if (idx.length) {
    const f = scoreCases(idx.map(([c]) => c), (c, j) => rank(c, idx[j][1]));
    console.log(`  T-103 새 문장  hit@1 ${pct(f.hit1, f.n)}  hit@3 ${pct(f.hit3, f.n)}`);
  }
}

if (!serverOnly) for (const [modeName, mode] of queryModes) for (const { name, cases, guarded } of sets) {
  const qs = await embed(cases.map(c => mode ? rewriteQueryText(rewrites[c.sentence], c.sentence, mode) : c.sentence), 'query');
  console.log(`\n[${name}${rewrites ? ' · 질의 ' + modeName : ''}] 문장 ${cases.length}개 · 임베더: ${embedderLabel}\n`);
  let margins = [];
  for (const s of settings) {
    const { topK, ...opts } = s;
    // 전체 순위를 받는다: scoreCases는 앞 3개만 보고, 여유는 기대 노드가 아닌 첫 노드까지 봐야 한다(T-150)
    const rank = (c, i) => retrieve(qs[i], graph, vecs, { ...opts, topK: graph.nodes.length, aliasText: c.sentence }).map(x => ({ id: x.id, score: x.score }));
    const r = scoreCases(cases, rank);
    console.log(pctLine(s.name, r));
    if (verbose) for (const m of r.misses) console.log(missLine(m));
    if (s.name === mixedSetting(admin).name) {
      margins = marginsOf(cases, rank);
      if (verbose) for (const m of margins) console.log(`  여유 ${fmtMargin(m.margin)}  ${m.sentence.slice(0, 32)}…`);
      // 음성 문장(T-149): 1위가 금지 노드가 아니면 통과. hit@1 분모와 따로
      if (r.negative.n) {
        console.log(`  alias-negative ${r.negative.pass}/${r.negative.n}`);
        if (verbose) for (const f of r.negative.fails) console.log(`  ✗ ${f.sentence.slice(0, 32)}… → 1위 ${f.top} (금지: ${f.forbid.join('/')})`);
      }
      if (name === '평가셋' && !mode) browserHit1 = r.hit1;
      printGuardAndNew(cases, r, rank, guarded);
      // 비유가 없어야 하는 문장의 1위 점수 vs 맞힌 문장의 1위 점수 (임계값 근거)
      if (r.noMatch.length) {
        const hs = [...r.hitScores].sort((a, b) => a - b);
        const fmt = x => x.toFixed(3);
        console.log(`  비유 없음 ${r.noMatch.length}문장 1위 점수 ${r.noMatch.map(m => fmt(m.score)).join(' ')} | 맞힌 문장 1위 점수 최소 ${fmt(hs[0])} · 중간 ${fmt(hs[hs.length >> 1])}`);
      }
    }
  }
  let t1 = 0;
  const tagged = cases.filter(c => c.expectTag);
  cases.forEach((c, i) => { if (c.expectTag && topTags(qs[i], graph, vecs, 1)[0]?.id === c.expectTag) t1++; });
  console.log(`\n추상 태그 top-1 정확도: ${pct(t1, tagged.length)}`);
  // 여유 작은 맞힌 문장 (혼합 설정, -v와 상관없이). 기존 줄 뒤에 덧붙이기만 한다
  console.log(lowMarginLines(lowMargins(margins, marginMin), marginMin).join('\n'));
  if (guarded && !mode) marginGuardFailed.push(...marginGuardFails(guard, margins, marginMin));
}
await closeEmbedder();

if (serverUrl) {
  let serverHit1 = null, serverN = 0;
  try {
    for (const { name, cases, guarded } of sets) {
      const onProgress = process.stdout.isTTY ? (i, n) => process.stdout.write(`\r  서버 요청 ${i}/${n}`) : undefined;
      const ranked = await rankAllViaServer({ url: serverUrl, token: serverToken, cases, rpm: serverRpm, onProgress });
      if (onProgress) process.stdout.write('\r\x1b[K');
      const rank = (c, i) => ranked[i];
      const r = scoreCases(cases, rank);
      console.log(`\n[${name} · 서버] 문장 ${cases.length}개 · 서버: ${serverUrl} (분당 ${serverRpm}회)\n`);
      console.log(pctLine('서버', r));
      if (verbose) for (const m of r.misses) console.log(missLine(m));
      printGuardAndNew(cases, r, rank, guarded);
      if (r.noMatch.length) console.log(`  비유 없음 ${r.noMatch.length}문장 1위 후보 ${r.noMatch.map(m => m.top ?? '-').join(' ')}`);
      if (name === '평가셋') { serverHit1 = r.hit1; serverN = r.n; }
    }
  } catch (e) {
    if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');
    console.log(`\n${e instanceof ServerUnavailable ? '서버 평가를 멈췄어요' : '서버 평가 실패'}: ${e.message}`);
    process.exit(1);
  }
  console.log(`\n${gateLine(serverHit1, serverOnly ? null : browserHit1, serverN)}`);
}
if (failMarginGuard && marginGuardFailed.length) {
  console.log(`\n여유 가드: 가드 문장 ${marginGuardFailed.length}개가 여유 < ${marginMin}`);
  for (const s of marginGuardFailed) console.log(`  ${s}`);
}
if (failGuard && regressed) { console.log(`\n회귀 ${regressed}건`); process.exit(1); }
if (failMarginGuard && marginGuardFailed.length) process.exit(1);

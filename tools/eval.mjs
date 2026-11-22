// 검색 품질 평가: 문장별로 기대 노드가 상위 1개·3개 안에 드는지, 가중치 설정별로 비교한다.
// 사용법 (프로젝트 루트에서):
//   npm install                            # 처음 한 번
//   npm run eval                       # 실제 모델을 실제 확장(크롬, wasm) 안에서 임베딩해 잰다. -- -v 로 틀린 문장 출력
//   npm run eval -- --node             # Node(onnxruntime-node)로 빠르게. q8 계산이 브라우저와 달라 수치가 실제와 다를 수 있다(T-128)
//   npm run eval:fallback              # 글자 n-gram 대체 임베더
//   npm run eval:fallback -- --baseline        # 모든 셋(메이플 평가·검증·홀드아웃, 식당 평가·홀드아웃)을 기준선
//                                      # (tools/eval-fallback-baseline.json)과 문장별 비교. 맞던 문장이 1위에서 틀리면 종료 코드 1 (T-179)
//   npm run eval:fallback -- --write-baseline  # 기준선 다시 쓰기
//   npm run eval -- --rewrite gemini   # 질의를 LLM으로 추상 구조로 바꿔 함께 비교 (T-113 (4)). <ID>_API_KEY 필요,
//                                      # 결과는 .tmp/rewrite-<제공자>-<모델>.json 에 캐시(다시 돌려도 호출 안 함)
//   npm run eval -- --server <url>     # 같은 문장을 analogy-api(POST /v1/analogy)의 debug.candidates 순위로도 채점하고 관문 한 줄 (T-405)
//        [--server-only]               # 브라우저 평가 생략(질의 재작성도 건너뜀)   [--rpm 20] 분당 요청 수   [--token <값>] 기본은 eval-<무작위>
//                                      # 관문 줄에 양쪽 임베더 이름(서버는 debug.embedderId)을 함께 찍는다. --holdout이면 홀드아웃으로 관문 (T-142)
//   npm run eval -- --holdout          # 평가셋·검증셋 대신 홀드아웃(tools/eval-unseen.json, 예문 고를 때 보지 않는 문장)만 채점 (T-150)
//   [--margin 0.005]                   # 여유(1위 − 경쟁자 점수 차)가 이보다 작은 맞힌 문장을 요약 끝에 목록으로 (T-150). -v면 문장별 여유
//   [--retrieval '{"nodeTextMode":"desc"}']  # admin.retrieval 위에 덮어쓸 설정(JSON). 측정용, 파일은 바꾸지 않는다 (T-154)
//   npm run eval -- --interest restaurant  # 다른 공통 관심사 그래프로 그 관심사 평가셋(tools/eval-set-<id>.json)만 채점 (T-302)
//        [--guard]                     # 그 관심사 가드(tools/eval-guard-<id>.json)로 회귀 검사 (T-156)
//        [--holdout]                   # 그 관심사 홀드아웃(tools/eval-unseen-<id>.json)만 (T-156). --margin-guard·--server는 메이플 전용(오류)
//   [--margin-guard]                   # 가드 문장 중 여유가 --margin 미만이면 종료 코드 1 (선택, 여유 경고는 기본으로 실패가 아님).
//                                      # 단 tools/eval-margin-known.json(아는 얇은 문장, T-188)에 있고 여유가 그 바닥 이상이면 통과(래칫)
//   [--write-margin-known]             # 지금 얇은 가드 문장으로 eval-margin-known.json 다시 쓰기(바닥 = 여유 넷째 자리 내림, task 이어받음).
//                                      # 더 얇아진 것을 받아들일 때만, 그 PR에 EVAL_LOG 한 줄과 함께. 실제 확장(크롬) 평가로만 쓴다
//   npm run eval -- --judge gemini-choice  # 판정기(lib/judges.js)에 문장 → 추상 태그(다중 선택)를 묻고 (T-120, ADR 0014)
//                                      # 판정 태그 top-1, 태그 유사도 대신(replace)·함께(combine) 쓴 노드 hit@1/@3, 1위 회귀(혼합 대비), 판정 지연을 출력.
//        [--judge-weight 0.05]         # 함께(combine)의 가중치: 태그 점수 = 유사도 − 감점 + w·p
//        [--rpm 10]                    # 판정 분당 요청 수(새로 물을 때만). 결과는 .tmp/judge-<id>-<모델>.json 캐시(다시 돌려도 호출 안 함)
//                                      # jev는 키(JEV_API_KEY)와 API 문서가 아직 없어 멈춘다
//   npm run eval -- --judge precise    # 정밀 모드 합침(T-184): 추상화+태그 판정 한 번의 호출(확장 runAbstract와 같은 프롬프트, Gemini)을
//                                      # .tmp/judge-precise-<모델>.json에 캐시하고, 임베딩만 / 정밀(판정 없음) / 정밀+판정을 문장별 1위 변화와 함께 비교
//        [--judge-floor 0.7]           # 판정 확률 하한(기본 admin.preciseTagJudge.floor). --judge-weight 기본은 admin.preciseTagJudge.weight
//        [--judge-sweep]               # 하한 후보별 한 줄 요약(하한은 검증셋·가드로 고른다, 홀드아웃으로 고르지 않는다)
//        [--judge-offline]             # 새로 묻지 않고 캐시만(한도 소진 때). 캐시 없는 문장은 "판정 빠짐"으로 원문 질의
//        [--judge-candidate combine-best] # 결합 방식 후보를 지금 방식(admin.preciseTagJudge.mode)과 문장별 1위로 비교(T-186)
//   [--precomputed]                    # 그래프 벡터를 동봉 파일(extension/data/vectors)에서 꺼내 채점, 런타임과 비트 동일 수 출력 (T-193)
//   [--dump-top1 <파일>]               # 셋·줄별 문장 1위를 JSON으로 저장(다른 실행과 비교용, T-186). 정밀은 임베딩만·정밀·정밀+판정·후보
import fs from 'node:fs';
import { mergeGraphs, embedItems } from '../extension/lib/graph.js';
import { loadInterestGraph, interestFromArgv } from './load-graph.mjs';
import { commonInterest } from '../extension/lib/graph.js';
import { retrieve, topTags } from '../extension/lib/retrieval.js';
import { hashEmbed } from '../extension/lib/fallback-embed.js';
import { embedEach } from '../extension/lib/embed-each.js';
import { openBrowserEmbedder } from './browser-embedder.mjs';
import { scoreCases, mixedSetting, regressions, latencyStats, rank1Regressions, rank1Gains, rank1Changes, marginsOf, lowMargins, marginGuardFails, judgeMarginGuard, knownFromFails, marginGuardLines, fmtMargin, lowMarginLines, missLine, marginThreshold, pickSets, interestArgError, interestEvalFiles } from './eval-lib.mjs';
import { PROVIDERS, complete } from '../extension/lib/providers.js';
import { buildAbstractPrompt, rewriteQueryText } from '../extension/lib/prompt.js';
import { loadJudgeResults, loadPreciseJudgeResults } from './eval-judge.mjs';
import { topChoice, judgeTagProbs, judgeSaysNone, isStructureless, NONE_CHOICE } from '../extension/lib/judges.js';
import { rankAllViaServer, gateLine, serverEmbedderLabel, rewriteIdFromArgv, ServerUnavailable } from './eval-server.mjs';

const here = new URL('.', import.meta.url);
const admin = JSON.parse(fs.readFileSync(new URL('../extension/config/admin.json', here)));
// --retrieval '<JSON>': admin.retrieval에 덮어써 같은 방식(임베딩 텍스트·점수)으로 채점한다 (T-154)
const retrievalAt = process.argv.indexOf('--retrieval');
if (retrievalAt > 0) {
  const over = JSON.parse(process.argv[retrievalAt + 1]);
  admin.retrieval = { ...admin.retrieval, ...over };
  console.log(`retrieval 덮어쓰기: ${JSON.stringify(over)}`);
}
// --baseline / --write-baseline (T-179): 대체 임베더 기준선 비교·다시 쓰기. 모든 셋을 한 번에 보고 끝낸다
if (process.argv.includes('--baseline') || process.argv.includes('--write-baseline')) {
  if (!process.argv.includes('--fallback')) throw new Error('--baseline·--write-baseline은 대체 임베더 전용이에요: npm run eval:fallback -- --baseline');
  const { runFallbackBaseline } = await import('./fallback-baseline.mjs');
  process.exit(runFallbackBaseline(process.argv, admin, { retrievalOverridden: retrievalAt > 0 }));
}
// --interest <id>: 공통 관심사(T-302). 기본은 메이플
const interest = commonInterest(interestFromArgv(process.argv));
const isDefaultInterest = interest.id === 'maplestory';
// 메이플 전용 옵션(--margin-guard·--server)을 다른 관심사와 같이 주면 바로 멈춘다
{ const err = interestArgError(process.argv, interest); if (err) throw new Error(err); }
const common = loadInterestGraph(interest.id); // 그래프 + tags.json (T-304)
console.log(`관심사: ${interest.label} (${common.id} ${common.version})`);
const readSet = f => JSON.parse(fs.readFileSync(new URL(f, here)));
const files = interestEvalFiles(interest); // 관심사별 평가셋·홀드아웃·가드 파일 (T-156)
// 평가셋·검증셋(eval-holdout.json), --holdout이면 홀드아웃(eval-unseen.json)만 (T-150). 다른 관심사면 그 관심사 평가셋이나 홀드아웃만
const sets = pickSets(process.argv, {
  evalSet: isDefaultInterest ? readSet('./eval-set.json') : [],
  validation: isDefaultInterest ? readSet('./eval-holdout.json') : [],
  holdout: process.argv.includes('--holdout') ? readSet(`./${files.holdout}`) : [],
  interestSet: isDefaultInterest ? [] : readSet(`./${files.evalSet}`)
}, interest);
const useFallback = process.argv.includes('--fallback');
const verbose = process.argv.includes('-v');
// 회귀 가드: 지금 맞히는 문장은 계속 맞혀야 한다(사용자 원칙, T-113). --guard면 하나라도 틀릴 때 종료 코드 1.
// 어떤 변경이 문장을 새로 맞히면 그 PR에서 eval-guard.json에 더한다. 빼는 것은 사용자 승인 없이 하지 않는다.
// 가드 목록은 실제 모델(admin.embedding) 기준이다. --fallback과 함께 쓰면 의미가 없다
// 관심사마다 가드 파일이 따로다(메이플 eval-guard.json, 식당 eval-guard-restaurant.json, T-156)
const failGuard = process.argv.includes('--guard');
const guardUrl = new URL(`./${files.guard}`, here);
if (failGuard && !fs.existsSync(guardUrl)) throw new Error(`가드 파일이 없어요: tools/${files.guard}`);
const guard = fs.existsSync(guardUrl) ? JSON.parse(fs.readFileSync(guardUrl)) : [];
let regressed = 0;
// 여유(T-150): 정보용 경고. --margin-guard일 때만 가드 문장의 작은 여유를 실패로 친다
const marginMin = marginThreshold(process.argv);
const writeMarginKnown = process.argv.includes('--write-margin-known');
const failMarginGuard = process.argv.includes('--margin-guard') || writeMarginKnown;
let marginGuardFailed = [];
// 아는 얇은 가드 문장(T-188). 바닥은 실제 확장(크롬) 여유라 Node·대체 임베더로 쓰지 않는다
const marginKnownUrl = new URL('eval-margin-known.json', here);
const marginKnown = fs.existsSync(marginKnownUrl) ? JSON.parse(fs.readFileSync(marginKnownUrl)) : { sentences: [] };
if (writeMarginKnown && (process.argv.includes('--holdout') || process.argv.includes('--node') || useFallback)) {
  throw new Error('--write-margin-known은 실제 확장(크롬) 평가셋·검증셋으로만 써요(--holdout·--node·대체 임베더 불가).');
}

// 서버 모드 (T-405). 토큰은 평가용 무작위 문자열이고 출력하지 않는다
const argAfter = flag => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : null; };
const serverUrl = argAfter('--server');
const serverOnly = !!serverUrl && process.argv.includes('--server-only');
const serverRpm = Number(argAfter('--rpm')) || 20;
const serverToken = argAfter('--token') || `eval-${Math.random().toString(36).slice(2, 12)}`;
if (process.argv.includes('--server-only') && !serverUrl) throw new Error('--server-only는 --server <url>과 함께 써요');
let browserHit1 = null; // 첫 셋 · 원문 · 혼합 hit@1 (관문 비교용)

// 질의 재작성 (정밀 모드와 같은 프롬프트). 문장별 결과를 캐시해 무료 한도를 아끼고 결과를 고정한다
// --server-only면 브라우저 평가를 안 하니 재작성도 건너뛴다 (T-142)
const rewriteId = rewriteIdFromArgv(process.argv);
if (serverOnly && process.argv.includes('--rewrite')) console.log('--server-only라 질의 재작성은 건너뛰어요');
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

// 판정기 (T-120). 원문 질의에만 쓴다. 캐시가 있으면 호출하지 않는다. 크롬을 띄우기 전에 물어 둔다(긴 대기 중 확장이 잠들지 않게)
const judgeId = argAfter('--judge');
const precise = judgeId === 'precise'; // T-184: 정밀 모드 합침 응답
const ptj = admin.preciseTagJudge || {};
const judgeWeight = Number(argAfter('--judge-weight')) || (precise ? ptj.weight : 0) || 0.05;
const judgeFloor = argAfter('--judge-floor') !== null ? Number(argAfter('--judge-floor')) : (ptj.floor ?? 0);
const judgeMode = ptj.mode || 'combine';
const judgeCandidate = argAfter('--judge-candidate'); // T-186: 결합 방식 후보(예 combine-best)
// 문장별 1위 저장(T-186): { "<셋 이름>": { "<줄>": { "<문장>": "<1위 노드>" } } }
const dumpTop1File = argAfter('--dump-top1');
const top1Dump = {};
const dumpTop1 = (setName, line, cases, tops) => {
  if (!dumpTop1File) return;
  (top1Dump[setName] ??= {})[line] = Object.fromEntries(cases.map((c, i) => [c.sentence, tops[i] ?? null]));
};
let judged = null;
if (judgeId && !serverOnly) {
  try {
    const args = { cases: sets.flatMap(x => x.cases), graph: mergeGraphs(common, null), admin, rpm: Number(argAfter('--rpm')) || 10 };
    judged = precise ? await loadPreciseJudgeResults({ ...args, offline: process.argv.includes('--judge-offline') }) : await loadJudgeResults({ judgeId, ...args });
  } catch (e) {
    console.log(`판정기 ${judgeId}를 쓸 수 없어요: ${e.message}`);
    process.exit(1);
  }
}
let embed, embedderLabel, closeEmbedder = async () => {};
let browserEmbedderId = null; // 실제 확장 평가일 때만(--precomputed, T-193)
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
  browserEmbedderId = be.embedderId;
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
// --precomputed (T-193): 그래프 벡터를 확장 동봉 파일(extension/data/vectors/<관심사>.json)에서 꺼내 채점한다(런타임과 같은 조회 규칙).
// 런타임 임베딩과 비트 단위로 같은지도 센다. 실제 확장(크롬) 평가에서만
if (process.argv.includes('--precomputed')) {
  if (!browserEmbedderId) throw new Error('--precomputed는 실제 확장(크롬) 평가에서만 써요(--node·대체 임베더 불가)');
  const { precomputedIndex, precomputedPath } = await import('../extension/lib/precomputed-vectors.js');
  const { createHash } = await import('node:crypto');
  const fileUrl = new URL(`../extension/${precomputedPath(interest.id)}`, here);
  const pre = fs.existsSync(fileUrl) ? precomputedIndex(JSON.parse(fs.readFileSync(fileUrl)), { embedderId: browserEmbedderId, passagePrefix: admin.embedding.passagePrefix ?? '' }) : new Map();
  let used = 0, same = 0;
  items.forEach((it, i) => {
    const v = pre.get(createHash('sha1').update(it.text, 'utf8').digest('hex'));
    if (!v) return;
    used++;
    if (v.length === vs[i].length && v.every((x, k) => x === vs[i][k])) same++;
    vecs.set(it.key, v);
  });
  console.log(`미리 계산 벡터 ${used}/${items.length}개 사용, 그중 런타임 임베딩과 비트 동일 ${same}개`);
}
const settings = [
  { name: '노드 직접 비교만', directWeight: 1, tagWeight: 0 },
  { name: '태그 경유만 (그래프 홉)', directWeight: 0, tagWeight: 1 },
  mixedSetting(admin, graph) // 관심사 그래프 감점을 확장과 같게 덮어쓴다 (T-156)
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

// 판정기 줄 (T-120): 혼합 설정 위에 tagJudge만 얹어 비교한다. 가드 회귀는 정보로만 보여 주고 --guard 종료 코드에는 넣지 않는다
function printJudge(name, cases, qs, mixedResult, guarded) {
  const probs = c => judged.results.get(c.sentence)?.answers || [];
  const mixed = mixedSetting(admin, graph);
  const { topK, name: _n, ...base } = mixed;
  console.log(`\n[${name} · 판정기 ${judged.label}]`);
  const tagged = cases.filter(c => c.expectTag);
  const jt1 = tagged.filter(c => topChoice(probs(c)) === c.expectTag).length;
  console.log(`  판정 태그 top-1: ${pct(jt1, tagged.length)}`);
  for (const [label, tj] of [['판정 대신(replace)', { mode: 'replace' }], [`판정 함께 w=${judgeWeight}`, { mode: 'combine', weight: judgeWeight }]]) {
    const rank = (c, i) => retrieve(qs[i], graph, vecs, { ...base, topK: graph.nodes.length, aliasText: c.sentence, tagJudge: { ...tj, p: probs(c) } }).map(x => ({ id: x.id, score: x.score }));
    const r = scoreCases(cases, rank);
    console.log(pctLine(label, r));
    if (verbose) for (const m of r.misses) console.log(missLine(m));
    if (r.negative.n) {
      console.log(`  alias-negative ${r.negative.pass}/${r.negative.n} (혼합 ${mixedResult.negative.pass}/${mixedResult.negative.n})`);
      for (const f of r.negative.fails) console.log(`    ⚠ 음성 실패: ${f.sentence.slice(0, 32)}… → 1위 ${f.top} (금지: ${f.forbid.join('/')})`);
    }
    const reg = rank1Regressions(mixedResult, r), gain = rank1Gains(mixedResult, r);
    console.log(`  혼합 대비 1위 회귀 ${reg.length} · 개선 ${gain.length}`);
    for (const s of reg) console.log(`    ⚠ 회귀: ${s.slice(0, 40)}…`);
    for (const s of gain) console.log(`    + 개선: ${s.slice(0, 40)}…`);
    if (guarded) {
      const g = regressions(guard, r);
      console.log(`  가드 놓침 ${g.length}${g.length ? ' (혼합 기준 놓침 ' + regressions(guard, mixedResult).length + ')' : ''}`);
    }
  }
  const st = latencyStats(cases.map(c => judged.results.get(c.sentence)?.ms));
  const fails = cases.filter(c => judged.results.get(c.sentence)?.error).length;
  console.log(`  판정 지연 ${st ? `중앙값 ${st.median}ms · p90 ${st.p90}ms (${st.n}문장, 처음 호출 때 잰 값)` : '없음'}${fails ? ` · 판정 실패 ${fails}` : ''}`);
}

// 정밀 모드 합침 줄 (T-184): 임베딩만(원문 질의) / 정밀(합침 응답의 추상 구조 + 원문, 판정 없음) / 정밀 + 판정(combine, 하한·없음 적용,
// "구조 없음"(없음 우세·하한 넘는 태그 없음)이면 원문 질의).
// 1위 회귀는 임베딩만 기준과 정밀(판정 없음) 기준 둘 다. 문장별 1위 변화는 임베딩만 기준으로 모두 찍는다
async function printPrecise(name, cases, qs, guarded) {
  const res = c => judged.results.get(c.sentence) || {};
  const qsP = await embed(cases.map(c => rewriteQueryText(res(c).abstract, c.sentence)), 'query');
  const { topK, name: _n, ...base } = mixedSetting(admin, graph);
  const ranker = (vecsOf, tj) => (c, i) => retrieve(vecsOf[i], graph, vecs, { ...base, topK: graph.nodes.length, aliasText: c.sentence, tagJudge: tj ? tj(c) : null }).map(x => ({ id: x.id, score: x.score }));
  const judgeOf = (floor, mode = judgeMode) => c => { const p = judgeTagProbs(res(c).answers, { floor }); return p?.length ? { p, mode, weight: judgeWeight } : null; };
  const top1s = rank => cases.map((c, i) => rank(c, i)[0]?.id);
  // 정밀+판정의 질의: 판정이 "구조 없음"(없음 우세·하한 넘는 태그 없음)이면 원문 벡터(확장 runAbstract와 같다), 아니면 추상 구조 + 원문
  const qsJ = floor => cases.map((c, i) => (isStructureless(judgeTagProbs(res(c).answers, { floor })) ? qs[i] : qsP[i]));
  const rankE = ranker(qs), rankP = ranker(qsP);
  const rE = scoreCases(cases, rankE), rP = scoreCases(cases, rankP);
  const tE = top1s(rankE), tP = top1s(rankP);
  console.log(`\n[${name} · ${judged.label} · 하한 ${judgeFloor} · w=${judgeWeight}]`);
  const tagged = cases.filter(c => c.expectTag);
  const tagTop = c => topChoice((res(c).answers || []).filter(a => a.id !== NONE_CHOICE.id));
  console.log(`  판정 태그 top-1: ${pct(tagged.filter(c => tagTop(c) === c.expectTag).length, tagged.length)} · "없음" 우세 ${cases.filter(c => judgeSaysNone(res(c).answers)).length}문장 · 하한 ${judgeFloor}에서 원문 질의 ${cases.filter(c => isStructureless(judgeTagProbs(res(c).answers, { floor: judgeFloor }))).length}문장 · 판정 빠짐 ${cases.filter(c => !res(c).answers).length}`);
  const negLine = r => r.negative.n ? `  음성 ${r.negative.pass}/${r.negative.n}` : '';
  const guardLine = r => guarded ? `  가드 놓침 ${regressions(guard, r).length}` : '';
  const summary = (label, r, t) => {
    const chE = rank1Changes(cases, tE, t), chP = rank1Changes(cases, tP, t);
    const n = (ch, k) => ch.filter(x => x[k]).length;
    return `${pctLine(label, r)}${negLine(r)}${guardLine(r)}  | 임베딩만 대비 회귀 ${n(chE, 'regressed')} 개선 ${n(chE, 'gained')} | 정밀 대비 회귀 ${n(chP, 'regressed')} 개선 ${n(chP, 'gained')}`;
  };
  console.log(summary('임베딩만', rE, tE));
  console.log(summary('정밀(판정 없음)', rP, tP));
  dumpTop1(name, '임베딩만', cases, tE);
  dumpTop1(name, '정밀', cases, tP);
  const floors = process.argv.includes('--judge-sweep') ? [0, 0.5, 0.6, 0.7, 0.8, 0.9] : [judgeFloor];
  for (const f of floors) {
    const rankJ = ranker(qsJ(f), judgeOf(f));
    const rJ = scoreCases(cases, rankJ), tJ = top1s(rankJ);
    console.log(summary(`정밀+판정 하한 ${f}`, rJ, tJ));
    if (f !== judgeFloor) continue;
    // 원문 질의 + 같은 판정(정밀 질의 효과와 판정 효과를 나눠 보기)
    const rankOJ = ranker(qs, judgeOf(f));
    console.log(summary(`원문+판정 하한 ${f}`, scoreCases(cases, rankOJ), top1s(rankOJ)));
    const mark = ok => (ok === null ? '·' : ok ? '✓' : '✗');
    const changeLines = (before, after) => rank1Changes(cases, before, after).map(x => `    ${x.regressed ? '⚠ 회귀' : x.gained ? '+ 개선' : '  변화'} ${x.sentence.slice(0, 40)}… ${x.before}${mark(x.beforeOk)} → ${x.after}${mark(x.afterOk)}`);
    for (const l of changeLines(tE, tJ)) console.log(l);
    dumpTop1(name, '정밀+판정', cases, tJ);
    if (judgeCandidate && judgeCandidate !== judgeMode) {
      // 후보 결합 방식: 같은 질의·같은 판정, 결합만 다르게. 문장별 1위는 지금 방식(정밀+판정) 대비
      const rankC = ranker(qsJ(f), judgeOf(f, judgeCandidate));
      const rC = scoreCases(cases, rankC), tC = top1s(rankC);
      const chJ = rank1Changes(cases, tJ, tC);
      console.log(`${summary(`후보 ${judgeCandidate} 하한 ${f}`, rC, tC)} | 지금(${judgeMode}) 대비 회귀 ${chJ.filter(x => x.regressed).length} 개선 ${chJ.filter(x => x.gained).length}`);
      for (const l of changeLines(tJ, tC)) console.log(l);
      dumpTop1(name, `후보 ${judgeCandidate}`, cases, tC);
    }
  }
  const st = latencyStats(cases.map(c => res(c).ms));
  console.log(`  합침 호출 지연 ${st ? `중앙값 ${st.median}ms · p90 ${st.p90}ms (${st.n}문장, 처음 호출 때 잰 값)` : '없음'}`);
}

if (!serverOnly) for (const [modeName, mode] of queryModes) for (const { name, cases, guarded } of sets) {
  const qs = await embed(cases.map(c => mode ? rewriteQueryText(rewrites[c.sentence], c.sentence, mode) : c.sentence), 'query');
  console.log(`\n[${name}${rewrites ? ' · 질의 ' + modeName : ''}] 문장 ${cases.length}개 · 임베더: ${embedderLabel}\n`);
  let margins = [], mixedResult = null;
  for (const s of settings) {
    const { topK, ...opts } = s;
    // 전체 순위를 받는다: scoreCases는 앞 3개만 보고, 여유는 기대 노드가 아닌 첫 노드까지 봐야 한다(T-150)
    const rank = (c, i) => retrieve(qs[i], graph, vecs, { ...opts, topK: graph.nodes.length, aliasText: c.sentence }).map(x => ({ id: x.id, score: x.score }));
    const r = scoreCases(cases, rank);
    console.log(pctLine(s.name, r));
    if (verbose) for (const m of r.misses) console.log(missLine(m));
    if (s.name === mixedSetting(admin, graph).name) {
      mixedResult = r;
      dumpTop1(name, mode ? `혼합 · ${modeName}` : '혼합', cases, cases.map((c, i) => rank(c, i)[0]?.id));
      margins = marginsOf(cases, rank);
      if (verbose) for (const m of margins) console.log(`  여유 ${fmtMargin(m.margin)}  ${m.sentence.slice(0, 32)}…`);
      // 음성 문장(T-149): 1위가 금지 노드가 아니면 통과. hit@1 분모와 따로
      if (r.negative.n) {
        console.log(`  alias-negative ${r.negative.pass}/${r.negative.n}`);
        if (verbose) for (const f of r.negative.fails) console.log(`  ✗ ${f.sentence.slice(0, 32)}… → 1위 ${f.top} (금지: ${f.forbid.join('/')})`);
      }
      if (name === sets[0].name && !mode) browserHit1 = r.hit1; // 관문은 첫 셋(평가셋, --holdout이면 홀드아웃)으로
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
  if (judged && !mode) await (precise ? printPrecise(name, cases, qs, guarded) : printJudge(name, cases, qs, mixedResult, guarded));
  // 여유 작은 맞힌 문장 (혼합 설정, -v와 상관없이). 기존 줄 뒤에 덧붙이기만 한다
  console.log(lowMarginLines(lowMargins(margins, marginMin), marginMin).join('\n'));
  if (guarded && !mode) marginGuardFailed.push(...marginGuardFails(guard, margins, marginMin));
}
await closeEmbedder();
if (dumpTop1File) { fs.writeFileSync(dumpTop1File, JSON.stringify(top1Dump, null, 1)); console.log(`문장별 1위 저장: ${dumpTop1File}`); }

if (serverUrl) {
  let serverHit1 = null, serverN = 0;
  const serverEmbedders = new Set(); // 서버 응답 debug.embedderId (T-142)
  const onDebug = d => serverEmbedders.add(d?.embedderId);
  try {
    for (const { name, cases, guarded } of sets) {
      const onProgress = process.stdout.isTTY ? (i, n) => process.stdout.write(`\r  서버 요청 ${i}/${n}`) : undefined;
      const ranked = await rankAllViaServer({ url: serverUrl, token: serverToken, cases, rpm: serverRpm, onProgress, onDebug });
      if (onProgress) process.stdout.write('\r\x1b[K');
      const rank = (c, i) => ranked[i];
      const r = scoreCases(cases, rank);
      console.log(`\n[${name} · 서버] 문장 ${cases.length}개 · 서버: ${serverUrl} (분당 ${serverRpm}회) · 임베더: ${serverEmbedderLabel(serverEmbedders)}\n`);
      console.log(pctLine('서버', r));
      if (verbose) for (const m of r.misses) console.log(missLine(m));
      printGuardAndNew(cases, r, rank, guarded);
      if (r.noMatch.length) console.log(`  비유 없음 ${r.noMatch.length}문장 1위 후보 ${r.noMatch.map(m => m.top ?? '-').join(' ')}`);
      if (name === sets[0].name) { serverHit1 = r.hit1; serverN = r.n; }
    }
  } catch (e) {
    if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');
    console.log(`\n${e instanceof ServerUnavailable ? '서버 평가를 멈췄어요' : '서버 평가 실패'}: ${e.message}`);
    process.exit(1);
  }
  const realBrowser = !useFallback && !process.argv.includes('--node');
  console.log(`\n${gateLine(serverHit1, serverOnly ? null : browserHit1, serverN, { server: serverEmbedderLabel(serverEmbedders), browser: embedderLabel, browserReal: realBrowser })}`);
}
// 여유 가드(T-150·T-188): 아는 얇은 문장은 바닥 이상이면 통과, 새로 얇아졌거나 바닥보다 더 얇아지면 실패
let marginJudge = null;
if (failMarginGuard) {
  marginJudge = judgeMarginGuard(marginGuardFailed, marginKnown.sentences);
  console.log('\n' + marginGuardLines(marginJudge, marginMin).join('\n'));
  if (writeMarginKnown) {
    const sentences = knownFromFails(marginGuardFailed, marginKnown.sentences);
    fs.writeFileSync(marginKnownUrl, JSON.stringify({ ...marginKnown, updated: new Date().toISOString().slice(0, 10), threshold: marginMin, sentences }, null, 2) + '\n');
    console.log(`아는 얇은 문장 ${sentences.length}개를 tools/eval-margin-known.json에 썼어요`);
  }
}
if (failGuard && regressed) { console.log(`\n회귀 ${regressed}건`); process.exit(1); }
if (failMarginGuard && !writeMarginKnown && marginJudge.fail.length) process.exit(1);

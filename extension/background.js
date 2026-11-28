// 서비스 워커: 저장소 병합 → 임베딩 → 그래프 검색 → LLM 비유 생성
import { getAdminConfig, getSettings, saveSettings, resolveProvider } from './lib/config.js';
import { complete, PROVIDERS } from './lib/providers.js';
import { buildChain, completeWithFallback, reorderChain } from './lib/fallback.js';
import { mergeGraphs, embedItems, sha1, COMMON_INTERESTS, DEFAULT_INTEREST, commonInterest } from './lib/graph.js';
import { loadCommonGraph, loadBlocklist, getUserStore, validateOverlay, normalizeOverlay } from './lib/stores.js';
import { retrieve, topTags, feedbackAdjust, retrievalFor } from './lib/retrieval.js';
import { addRecord, removeRecord, setReason, REASONS, applyFeedback, similarMemory, feedbackKey, maskSentence, bumpHover, summarizeFeedback, summarizeAgentFeedback, localDay, boostForNode, reportedNodes, feedbackForGraph } from './lib/feedback.js';
import { callAnalogyServer, serverSkipReason, getInstallToken, serverOriginPattern, shouldCacheLocal, nextServerCooldown, inServerCooldown, cacheEntryFor, readCacheEntry } from './lib/analogy-server.js';
import { runAbstract, runAnalogy } from './lib/pipeline.js';
import { applyBlocklist, findBlocked, activeTerms } from './lib/blocklist.js';
import { touch, pruneVecCache, VEC_CACHE_MAX } from './lib/vec-cache.js';
import { precomputedIndex, precomputedPath } from './lib/precomputed-vectors.js';
import { syncCorrectionExamples, buildCorrectionsExport } from './lib/corrections.js';
import { makeGroundingEntry, addGroundingEntry, bumpGroundingCount, flagGroundingEntry, summarizeGrounding } from './lib/grounding-log.js';
import { buildDraftPrompt } from './lib/prompt.js';
import { parseDraft, validDraftName, draftNameError, demoDraftText, withDeadline, draftError, DRAFT_DEADLINE_MS } from './lib/draft.js';
import './lib/site-filter.js'; // globalThis.AnalogySiteFilter (콘텐츠 스크립트와 같은 파일)
import { loadErrorReason } from './lib/embed-status.js';
import { takeDailyCall } from './lib/agent.js';
import { runFollowup, cleanQuestion } from './lib/agent-tools.js';
import { runDiagnose, diagnoseAction } from './lib/agent-diagnose.js';
import { newHelperState, runHelper, helperView, mergeHelperDrafts, cleanNotes, HELPER_TEXT } from './lib/interest-helper.js';

/* ───────────── 오프스크린(임베딩) ───────────── */

let creatingOffscreen = null;
async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (ctx.length) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: '브라우저 안에서 임베딩 모델을 실행해 관심사 그래프를 검색합니다.'
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function offscreen(type, payload = {}) {
  await ensureOffscreen();
  const admin = await getAdminConfig();
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type, config: admin.embedding, ...payload });
  if (res?.error) throw new Error(res.error);
  return res;
}

// 모델을 받는 동안 서비스 워커가 잠들지 않게 한다
async function keepAlive(promise) {
  const t = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  try { return await promise; } finally { clearInterval(t); }
}

/* ───────────── 그래프 + 벡터 ───────────── */

async function getSessionAndOverlay() {
  const store = await getUserStore();
  const session = await store.getSession();
  let overlay = null;
  if (session) {
    try { overlay = await store.loadOverlay(session); }
    catch (e) { console.warn('[user-store] 오버레이를 못 읽었어요', e); }
  }
  return { store, session, overlay };
}

// 사용자가 고른 공통 관심사 그래프(T-302, 설정 interest). 로그아웃이어도 고를 수 있다. 모르는 값이면 로더가 메이플로
async function loadChosenCommon() {
  const { interest } = await getSettings();
  return loadCommonGraph(interest);
}

async function getMergedGraph() {
  const common = await loadChosenCommon();
  const { session, overlay } = await getSessionAndOverlay();
  // 로그아웃 상태 = 고른 공통 관심사만. 로그인 상태 = 고른 공통 관심사 + 내 오버레이(useCommon false면 공통 노드 없음)
  return { graph: mergeGraphs(common, session ? overlay : null), session };
}

let vecMem = null; // `${embedderId}|${hash}` -> number[]
async function loadVecCache() {
  if (vecMem) return vecMem;
  const { vecCache } = await chrome.storage.local.get('vecCache');
  vecMem = new Map(Object.entries(vecCache || {}));
  return vecMem;
}
async function saveVecCache() {
  await chrome.storage.local.set({ vecCache: Object.fromEntries(vecMem) });
}

// 미리 계산한 그래프 벡터(T-193, ADR 0015). 관심사별 확장 동봉 데이터 파일, 서비스 워커가 살아 있는 동안 메모리에 둔다.
// embedderId·passagePrefix가 다르면 빈 조회표(대체 임베더 포함, 지금처럼 런타임 임베딩). 파일이 없거나 못 읽어도 빈 조회표
const preMem = new Map(); // `${interestId}|${embedderId}|${prefix}` -> Map(hash -> number[])
async function loadPrecomputed(interestId, embedderId, passagePrefix) {
  const k = `${interestId}|${embedderId}|${passagePrefix}`;
  if (preMem.has(k)) return preMem.get(k);
  let idx = new Map();
  try {
    const res = await fetch(chrome.runtime.getURL(precomputedPath(interestId)));
    if (res.ok) idx = precomputedIndex(await res.json(), { embedderId, passagePrefix });
  } catch (e) {
    console.warn('[vectors] 미리 계산 벡터를 못 읽어서 런타임 임베딩만 써요', e);
  }
  preMem.set(k, idx);
  return idx;
}

async function ensureGraphVectors(graph) {
  const init = await keepAlive(offscreen('init'));
  // fallbackOnError false면 대체 검색으로 넘어가지 않고 여기서 멈춘다(원인은 짧은 한국어로)
  if (init.status === 'error') throw new Error('검색 모델을 준비하지 못했어요: ' + loadErrorReason(init.loadError));
  const embedderId = init.embedderId;
  const cache = await loadVecCache();
  const admin = await getAdminConfig();
  const { interest } = await getSettings();
  const pre = await loadPrecomputed(commonInterest(interest)?.id || DEFAULT_INTEREST, embedderId, admin.embedding?.passagePrefix ?? '');
  // 노드 텍스트·태그 벡터 방식은 admin.retrieval(nodeTextMode·tagVectorMode)을 따른다. 평가 도구와 같은 함수 (T-154)
  const items = embedItems(graph, admin.retrieval);
  for (const it of items) {
    it.hash = await sha1(it.text);
    it.cacheKey = `${embedderId}|${it.hash}`;
  }
  // 미리 계산 벡터가 있으면 그것을 쓰고 vecCache에는 넣지 않는다(저장 공간은 오버레이·바뀐 텍스트 몫으로)
  const fromPre = items.filter(it => pre.has(it.hash));
  const rest = items.filter(it => !pre.has(it.hash));
  const missing = rest.filter(it => !cache.has(it.cacheKey));
  if (missing.length) {
    const { vectors } = await keepAlive(offscreen('embed', { texts: missing.map(m => m.text), kind: 'passage' }));
    missing.forEach((m, i) => cache.set(m.cacheKey, vectors[i]));
  }
  // 정리(T-110): 이번 키를 최근 사용으로 옮기고, 다른 임베더 항목과 상한 초과분을 지운다(이번 키는 지키고).
  // 미리 계산으로 덮인 키는 예전 vecCache에서 지운다(같은 벡터를 두 번 저장하지 않게)
  const used = rest.map(it => it.cacheKey);
  let dropped = 0;
  for (const it of fromPre) if (cache.delete(it.cacheKey)) dropped++;
  touch(cache, used);
  const { cache: pruned, removed } = pruneVecCache(cache, { embedderId, max: admin.vecCacheMax ?? VEC_CACHE_MAX, keep: new Set(used) });
  // 임베딩을 기다리는 사이 "캐시 지우기"나 다른 호출이 vecMem을 바꿨으면 덮어쓰지 않는다(이번 결과 vecs는 그대로 쓴다)
  if (vecMem === cache) {
    vecMem = pruned;
    // 추가·삭제가 있을 때만 저장한다. touch만으로는 저장하지 않는다(호버마다 쓰지 않게, 저장 순서는 LRU 근사로 충분)
    if (missing.length || removed || dropped) await saveVecCache();
  }
  const vecs = new Map(items.map(it => [it.key, pre.get(it.hash) || pruned.get(it.cacheKey)]));
  // 벡터 출처 수(T-193): 미리 계산 / vecCache / 이번에 임베딩. 설정 화면·e2e·측정이 본다
  const vectorSources = { precomputed: fromPre.length, cached: rest.length - missing.length, embedded: missing.length };
  return { vecs, embedderId, embedderStatus: init.status, loadError: init.loadError || null, vectorSources };
}

/* ───────────── 설명 파이프라인 ───────────── */

// 429 쿨다운 기록. 서비스 워커가 잠들어도 브라우저를 닫기 전까지 유지된다
const cooldowns = {
  get: async () => (await chrome.storage.session.get('llmCooldowns')).llmCooldowns || {},
  set: llmCooldowns => chrome.storage.session.set({ llmCooldowns })
};

// 서버 실패 뒤 쿨다운(T-159). 429 쿨다운처럼 브라우저를 닫기 전까지 유지된다. 설정 화면도 읽는다
const serverCooldownStore = {
  get: async () => (await chrome.storage.session.get('serverCooldown')).serverCooldown || null,
  set: serverCooldown => serverCooldown ? chrome.storage.session.set({ serverCooldown }) : chrome.storage.session.remove('serverCooldown')
};

// 말풍선 피드백 층(ADR 0010, T-129). 사용자 크롬 프로필에만 저장한다(D-7)
const feedbackStore = {
  get: async () => (await chrome.storage.local.get('feedback')).feedback || [],
  set: feedback => chrome.storage.local.set({ feedback })
};
// 날짜별 호버 수(T-132 "내 피드백" 통계). 동시에 여러 번 불려도 빠지지 않게 차례로 쓴다.
// 사용자가 직접 연 비유(호버 포트, 설정 화면 "시험해 보기")만 센다. 피드백 뒤 다시 비유는 세지 않는다(호버 대비 비율이 부풀지 않게).
// 호버 응답을 늦추지 않게 기다리지 않고 부른다. 캐시 적중도 한 번으로 센다
let hoverQueue = Promise.resolve();
function countHover() {
  hoverQueue = hoverQueue.then(async () => {
    const { hoverCounts } = await chrome.storage.local.get('hoverCounts');
    await chrome.storage.local.set({ hoverCounts: bumpHover(hoverCounts || {}, localDay(Date.now())) });
  }).catch(e => console.warn('호버 집계 실패', e));
  return hoverQueue;
}
const sentenceHashOf = sentence => sha1(String(sentence || '').trim());

// 근거 검사 실사용 오탐률(T-146). 이 기기에만 쌓는다(D-7, 서버로 보내지 않음).
// 숨김은 groundingLog에 가린 문장·비유로 한 건, 통과는 groundingCounts에 날짜별 개수만.
// 호버 응답을 늦추지 않게 기다리지 않고 부르고, 실패해도 결과는 그대로(경고만). countHover처럼 차례로 쓴다
let groundingQueue = Promise.resolve();
function recordGrounding({ grounding, hidden, sentence, interest, blocklist }) {
  if (!grounding) return groundingQueue; // 근거 검사를 안 한 결과(규칙 1 숨김, 비유 없음)는 세지 않는다
  const ts = Date.now();
  groundingQueue = groundingQueue.then(async () => {
    const { groundingLog, groundingCounts } = await chrome.storage.local.get(['groundingLog', 'groundingCounts']);
    const patch = { groundingCounts: bumpGroundingCount(groundingCounts || {}, localDay(ts), !grounding.ok) };
    if (!grounding.ok) {
      const entry = makeGroundingEntry({ id: crypto.randomUUID(), ts, reason: grounding.reason, nodeId: hidden?.nodeId, interest, sentence, analogy: hidden?.analogy }, activeTerms(blocklist));
      if (entry) patch.groundingLog = addGroundingEntry(groundingLog || [], entry);
    }
    await chrome.storage.local.set(patch);
  }).catch(e => console.warn('근거 검사 기록 실패', e));
  return groundingQueue;
}

const RESULT_CACHE_MAX = 200;
async function cacheGet(key) {
  const got = await chrome.storage.session.get('results');
  // 쿨다운 중 결과는 쿨다운이 끝나면 놓침(T-159). 지난 항목은 다음 cachePut 이 덮거나 오래된 순으로 밀려난다
  return readCacheEntry(got.results?.[key], Date.now());
}
async function cachePut(key, value) {
  const got = await chrome.storage.session.get('results');
  const results = got.results || {};
  results[key] = cacheEntryFor(value); // 쿨다운 결과만 expiresAt(T-159), 나머지는 그대로
  const keys = Object.keys(results);
  if (keys.length > RESULT_CACHE_MAX) for (const k of keys.slice(0, keys.length - RESULT_CACHE_MAX)) delete results[k];
  await chrome.storage.session.set({ results });
}

// 피드백 기록에 붙이는 질의 벡터(T-130). explain과 같은 오프스크린 embed(kind query)지만,
// 정밀 모드의 질의 재작성은 LLM 호출이라 하지 않고 원문 문장으로 만든다. 저장 크기를 줄이려 소수 넷째 자리로 반올림.
// 임베딩이 실패하면 null — 피드백은 벡터 없이도 저장한다
async function queryVector(sentence) {
  try {
    const { vectors: [v] } = await keepAlive(offscreen('embed', { texts: [String(sentence ?? '')], kind: 'query' }));
    return Array.isArray(v) ? v.map(x => Math.round(x * 1e4) / 1e4) : null;
  } catch (e) {
    console.warn('[feedback] 문장 벡터를 못 만들었어요', e);
    return null;
  }
}

// onPartial({ meaning }) 은 스트리밍 중 meaning 이 처음 완성될 때 한 번 불린다. 비유는 넣지 않는다(검증 전이라서)
// merged: 부르는 쪽이 이미 getMergedGraph()를 했으면 넘겨 같은 결과를 다시 읽지 않는다(T-108 포트 경로)
async function explain({ sentence, context, word, pageTitle, noCache }, onStage = () => {}, onPartial = null, merged = null) {
  const t0 = Date.now();
  const settings = await getSettings();
  const admin = await getAdminConfig();
  const provider = await resolveProvider();

  onStage('graph');
  const { graph, session } = merged || await getMergedGraph();
  // 내 태그 예문(교정 예문 포함, T-131)과 가중치(nodeBoosts + feedbackBoosts)가 바뀌어도 다른 문장의 캐시가 갈리게 짧은 지문을 넣는다
  const userTagKey = (await sha1(JSON.stringify([graph.tags.filter(t => t.source === 'user').map(t => [t.id, t.examples || []]), graph.boosts || {}]))).slice(0, 12);
  const graphKey = JSON.stringify([graph.sources, session?.userId || null, graph.nodes.length, userTagKey]);
  // graph.sources에 공통 그래프 id·판본이 있어 관심사를 바꾸면 결과 캐시 키가 갈린다(T-302). 벡터 캐시는 텍스트 해시라 섞이지 않는다
  const sentenceHash = await sentenceHashOf(sentence);
  // 지금 그래프 노드를 가리키는 기록만 쓴다(T-302). 다른 관심사에서 남긴 👎·고정은 후보·캐시 키·서버 판정 어디에도 끼지 않는다
  const feedbackRecords = feedbackForGraph(await feedbackStore.get(), graph);
  // 피드백 지문을 캐시 키에 넣어, 그 문장의 피드백이 바뀌면 캐시가 저절로 무효가 된다
  // 비슷한 문장 메모리(T-130)는 다른 문장의 기록이라, 그 기록 id 목록도 키에 넣어 새 👎·고정이 생기면 무효가 되게 한다
  const memoryKey = feedbackRecords.filter(r => r.vec && r.vote !== 'up' && r.sentenceHash !== sentenceHash).map(r => r.id).join(',');
  // "사실이 틀렸어요" 제보 3건으로 빠지는 공통 노드(T-118). 다른 문장 기록으로 정해지니 캐시 키에도 넣는다
  const reported = reportedNodes(feedbackRecords, graph);
  const reportedKey = [...reported].sort().join(',');
  // 서버 출처 권한(T-141). 주소가 있을 때만 확인하고, 허용 여부를 캐시 키에 넣어 허용하면 권한 없음 결과가 저절로 갈린다
  const serverPerm = await serverPermission(admin.analogyServer?.url);
  const cacheKey = await sha1([sentence, word, graphKey, provider.id, provider.model, settings.preciseMode, feedbackKey(feedbackRecords, sentenceHash), memoryKey, reportedKey, serverPerm.key].join('|'));
  if (!noCache) {
    const hit = await cacheGet(cacheKey);
    if (hit) return { ...hit, cached: true };
  }

  // 서버 모드(T-404): analogy-api 를 먼저 부르고, 실패하면 아래 로컬 파이프라인으로 간다.
  // 주소가 비었으면(서버 모드 꺼짐) source·debug.server 를 붙이지 않는다(지금 결과 그대로)
  // 서버가 막 실패했으면 쿨다운 동안 건너뛴다(T-159). 주소가 없으면 읽지 않는다
  const serverCooldown = admin.analogyServer?.url ? await serverCooldownStore.get() : null;
  const skip = serverSkipReason({
    admin, session, providerKind: provider.def.kind,
    commonId: graph.sources.common?.id ?? null, // 서버는 메이플만 안다(T-302)
    sentenceRecords: feedbackRecords.filter(r => r.sentenceHash === sentenceHash),
    hasPermission: serverPerm.granted,
    inCooldown: inServerCooldown(serverCooldown, Date.now())
  });
  let serverInfo = skip === 'off' ? null
    : skip === 'cooldown' ? { used: false, reason: 'cooldown', until: serverCooldown.until }
    : { used: false, reason: skip };
  // 금칙어 목록(T-114): 서버 결과 재검사·로컬 생성·정밀 모드 추상 구조에 같이 쓴다
  const blocklist = await loadBlocklist();
  if (!skip) {
    onStage('server');
    const token = await getInstallToken(chrome.storage.local);
    const r = await callAnalogyServer({
      url: admin.analogyServer.url,
      token,
      timeoutMs: admin.analogyServer.timeoutMs,
      payload: { sentence, word: word || '', context: context || '', pageTitle: pageTitle || '' },
      // 규칙 1(T-141): 서버 근거는 서버 후보뿐 아니라 지금 관심사의 로컬 공통 노드에도 있어야 한다
      localNodeIds: new Set(graph.nodes.filter(n => n.source === 'common').map(n => n.id))
    });
    // 성공하면 쿨다운을 바로 풀고, 실패하면 연속 실패 수만큼 길게 쉰다(T-159). 기록 실패로 호버를 막지 않는다
    try {
      if (r.ok) { if (serverCooldown) await serverCooldownStore.set(null); }
      else await serverCooldownStore.set(nextServerCooldown(serverCooldown, r.reason, Date.now(), admin.analogyServer, r.retryAfterMs));
    } catch (e) { console.warn('[server] 쿨다운을 기록하지 못했어요', e); }
    // 서버는 내 제보를 모른다(ADR 0010). 근거가 제보로 빠진 노드면 서버 결과를 버리고 로컬로 간다(T-118)
    if (r.ok && reported.has(r.result.evidence?.nodeId)) {
      serverInfo = { used: false, reason: 'reported' };
    } else if (r.ok) {
      // callAnalogyServer 가 이미 규칙 1 검증(checkServerResult)을 거쳤다. 서버 경로에는 partial 이 없다.
      // 금칙어는 서버도 검사하지만 규칙 1처럼 확장이 한 번 더 검사한다(T-114)
      const { answer: checked, blocked } = applyBlocklist(r.result, blocklist);
      const result = { ...checked, source: 'server', feedbackApplied: false, debug: { ...checked.debug, server: { used: true, ms: r.ms } } };
      if (blocked) result.debug.blocked = blocked; // 필드 이름만
      await cachePut(cacheKey, result);
      return result;
    } else {
      serverInfo = { used: false, reason: r.reason };
    }
  }

  onStage('model');
  const { vecs, embedderId, embedderStatus, vectorSources } = await ensureGraphVectors(graph);

  const llmStats = { retries: 0 };
  // 사용자가 고른 제공자 → 관리자 fallbackChain 순서로 부른다(T-124). 실제로 답한 모델을 debug 에 남긴다
  const chain = buildChain(provider, admin, settings);
  let answered = provider;
  const fallbacks = [];
  const ask = async (system, user, opts) => {
    const r = await completeWithFallback(chain, system, user, { ...opts, stats: llmStats }, { cooldowns, cooldown: admin.cooldown });
    answered = r.provider;
    fallbacks.push(...r.fallbacks);
    return r.text;
  };
  let queryText = sentence;
  let abstractText = null;
  // 정밀 모드 태그 판정(T-184): 켜져 있으면 추상화 호출 한 번에 태그 확률도 함께 받는다(호출 수 그대로)
  const ptj = admin.preciseTagJudge;
  let judge = null;
  if (settings.preciseMode && provider.def.kind !== 'demo') {
    const tagJudge = ptj?.enabled ? { tags: graph.tags, floor: ptj.floor ?? 0 } : null;
    ({ abstractText, queryText, judge } = await runAbstract({ sentence, word, pageTitle, ask, onStage, tagJudge }));
    // 추상 구조는 검색 질의로만 쓰고, debug 로 보일 때 금칙어가 섞였으면 지운다(T-114)
    if (findBlocked(abstractText, blocklist)) abstractText = '';
  }

  onStage('search');
  const { vectors: [q] } = await offscreen('embed', { texts: [queryText], kind: 'query' });
  // 피드백으로 빠지는 후보가 있어도 topK를 채우도록 넉넉히 뽑은 뒤 적용한다
  const topK = admin.retrieval?.topK ?? 3;
  // 다른 문장의 👎·고정 중 지금 문장과 코사인이 임계값 이상인 것만 점수를 가감한다(T-130)
  const memory = similarMemory(feedbackRecords, sentenceHash);
  // 정밀 모드는 q가 추상 구조 + 원문이라 원문으로 만든 기록 벡터(queryVector)와 코사인이 낮다.
  // 메모리가 있을 때만 원문을 한 번 더 임베딩해(LLM 호출 없음) 비슷한 문장 판정에만 쓴다(T-138). 실패하면 q로 대체
  let fq = q, queryVec = 'query', extraEmbedMs = 0;
  if (memory.length && queryText !== sentence) {
    const te = Date.now();
    try {
      const { vectors: [v] } = await offscreen('embed', { texts: [sentence], kind: 'query' });
      if (Array.isArray(v) && v.length) { fq = v; queryVec = 'sentence'; }
    } catch (e) {
      console.warn('[feedback] 정밀 모드 원문 벡터를 못 만들어 검색 벡터로 판정해요', e);
    }
    extraEmbedMs = Date.now() - te;
  }
  // 제보로 빠진 공통 노드는 그 문장 👎처럼 후보에서 뺀 뒤 피드백을 적용한다(고정도 못 한다)
  const unreported = list => list.filter(c => !reported.has(c.id));
  // 판정 확률은 정밀 모드에서만 태그 점수에 더한다. 판정이 없거나(형식 어김) "없음"이면 예전과 같다
  const tagJudgeOpt = judge?.probs?.length ? { p: judge.probs, mode: ptj.mode || 'combine', weight: ptj.weight ?? 0.05 } : null;
  // 관심사 그래프의 감점(tagPenalty)을 admin.retrieval 위에 덮어쓴다(T-156, 메이플은 그대로)
  const fb = applyFeedback(unreported(retrieve(q, graph, vecs, { ...retrievalFor(admin.retrieval, graph), topK: topK + 5, feedbackMemory: memory, feedbackQuery: fq, aliasText: sentence, tagJudge: tagJudgeOpt })), feedbackRecords, sentenceHash, topK);
  const candidates = fb.candidates;
  const similar = memory.length
    ? [...feedbackAdjust(fq, memory, { sim: admin.retrieval?.feedbackSim ?? 0.92, max: admin.retrieval?.feedbackMax ?? 0.1 })]
      .filter(([, d]) => d).map(([nodeId, d]) => ({ nodeId, delta: +d.toFixed(4) }))
    : [];
  // 비슷한 문장 가감이 상위 topK 순서를 바꿨는지는 메모리 없이 한 번 더 뽑아 비교한다(검색은 가볍다)
  let similarChanged = false;
  if (similar.length) {
    const plain = applyFeedback(unreported(retrieve(q, graph, vecs, { ...retrievalFor(admin.retrieval, graph), topK: topK + 5, feedbackQuery: fq, aliasText: sentence, tagJudge: tagJudgeOpt })), feedbackRecords, sentenceHash, topK);
    similarChanged = plain.candidates.map(c => c.id).join() !== candidates.map(c => c.id).join();
  }
  const tags = topTags(q, graph, vecs, 5);

  // 비유 프롬프트 → LLM → 파싱 → 규칙 1 nodeId 검증 → 근거 검사(T-123) → 금칙어 검사(T-114)는 lib/pipeline.js(T-104)
  const { answer, grounding, groundingHidden, evidence, blocked, ending } = await runAnalogy({
    sentence, word, context, pageTitle, graph, candidates, ask,
    providerKind: provider.def.kind, onStage, onPartial, blocklist
  });
  // 기기 안 오탐률 기록(T-146). 기다리지 않는다. 관심사는 공통 그래프 id(내 관심사만 쓰면 null)
  try { recordGrounding({ grounding, hidden: groundingHidden, sentence, interest: graph.sources?.common?.id ?? null, blocklist }); }
  catch (e) { console.warn('근거 검사 기록 실패', e); }

  const result = {
    meaning: answer.meaning || '',
    analogy: answer.analogy || '',
    mapping: answer.mapping || '',
    rejected: answer.rejected || null,
    evidence,
    domain: graph.domain,
    theme: graph.theme,
    // 비유 없음 문구(T-302). 공통 관심사별, 내 관심사면 빈 문자열(말풍선이 기본 문구)
    noMatchText: graph.noMatchText || '',
    feedbackApplied: fb.applied || similarChanged,
    debug: {
      feedback: { excluded: fb.excluded, pinned: fb.pinned, similar, queryVec, extraEmbedMs, reported: [...reported] },
      // tagId: 그 후보의 최고 태그. 말풍선 "더 맞는 개념"이 교정 기록(pickedTagId)에 싣는다(T-131)
      candidates: candidates.map(c => ({ id: c.id, label: c.label, score: c.score, direct: c.direct, tag: c.tag?.label, tagId: c.tag?.id, tagSim: c.tag?.sim, source: c.source })),
      topTags: tags,
      abstractText,
      // 정밀 모드 태그 판정(T-184): 하한·없음 적용 뒤 쓴 확률(probs), 없음 확률, 구조 없음 판정(참이면 원문으로 검색). 꺼져 있으면 null
      tagJudge: judge ? { probs: judge.probs, none: judge.answers?.find(a => a.id === 'none')?.p ?? null, structureless: judge.none } : null,
      embedderId,
      embedderStatus,
      vectorSources,
      provider: `${answered.id}/${answered.model}`,
      fallbacks,
      llmRetries: llmStats.retries,
      user: session ? session.name : null,
      ms: Date.now() - t0
    }
  };
  if (grounding) result.debug.grounding = grounding;
  // 끝맺음 검사(T-122): { ok, retried, issues }. ok=false면 다시 불러도 ~습니다·~다로 끝난 답이다
  if (ending) result.debug.ending = ending;
  if (blocked) result.debug.blocked = blocked; // 필드 이름만, 금칙어 자체는 없다
  if (serverInfo) {
    result.source = 'local';
    result.debug.server = serverInfo;
  }
  // 서버를 시도했다가 실패해서 만든 로컬 결과는 캐시하지 않는다(T-141). 서버가 살아나면 다음 호버에 서버로.
  // 쿨다운으로 건너뛴 결과(T-159)는 쿨다운이 끝날 때까지만 캐시한다(INTENTIONAL_SKIPS, cachePut 의 expiresAt)
  if (shouldCacheLocal(serverInfo)) await cachePut(cacheKey, result);
  return result;
}

// 서버 주소의 출처 권한(T-141). 주소가 없으면 확인하지 않는다(key 빈 값 = 예전 캐시 키 모양).
// 틀린 주소·확인 실패는 권한 없음으로 본다 → 서버를 부르지 않고 조용히 로컬(no-permission)
async function serverPermission(url) {
  if (!url) return { granted: true, key: '' };
  const pattern = serverOriginPattern(url);
  let granted = false;
  if (pattern) {
    try { granted = await chrome.permissions.contains({ origins: [pattern] }); }
    catch (e) { console.warn('[server] 권한을 확인하지 못했어요', e); }
  }
  return { granted, key: granted ? 'server-ok' : 'server-denied' };
}

/* ───────────── 말풍선 이어 묻기 에이전트 (T-216, ADR 0017) ───────────── */

// 에이전트 LLM 호출의 하루 상한(admin agent.dailyCallCap). 호버 체인 한도와 따로 센다(사용자 결정 2026-11-28).
// 이 기기 chrome.storage.local agentCalls = { day, count }. 동시에 여러 질문이 와도 빠지지 않게 차례로 쓴다
const AGENT_DAILY_CAP_DEFAULT = 40;
let agentQueue = Promise.resolve();
function takeAgentCall(cap) {
  const job = agentQueue.then(async () => {
    const { agentCalls } = await chrome.storage.local.get('agentCalls');
    const r = takeDailyCall(agentCalls || null, localDay(Date.now()), cap);
    if (r.ok) await chrome.storage.local.set({ agentCalls: r.state });
    return r.ok;
  });
  agentQueue = job.catch(() => {});
  return job;
}

const str = (v, n) => String(v ?? '').slice(0, n);

// 에이전트 공통 준비(T-216·T-220): LLM은 explain과 같은 길(사용자 제공자 → fallbackChain, 429 쿨다운 공유, 규칙 7·8),
// search_graph 도구는 한 문장 임베딩(오프스크린, 한 문장씩) + retrieve. 제보로 빠진 공통 노드(T-118)는 호버처럼 뺀다.
// 하루 상한은 이어 묻기·교정 진단이 같은 agentCalls를 센다
async function agentDeps(graph) {
  const [settings, admin, provider] = await Promise.all([getSettings(), getAdminConfig(), resolveProvider()]);
  // 에이전트는 JSON 액션 형식을 잘 지키는 순서로(T-222, admin agent.providerOrder). 체인 항목끼리 자리만 바꾼다
  const chain = reorderChain(buildChain(provider, admin, settings), admin.agent?.providerOrder);
  const state = { answered: chain[0] || provider, fallbacks: [] };
  const ask = async (system, user, opts) => {
    const r = await completeWithFallback(chain, system, user, opts, { cooldowns, cooldown: admin.cooldown });
    state.answered = r.provider;
    state.fallbacks.push(...r.fallbacks);
    return r.text;
  };
  const searchGraph = async (text, exclude) => {
    const { vecs } = await ensureGraphVectors(graph);
    const { vectors: [v] } = await offscreen('embed', { texts: [text], kind: 'query' });
    const reported = reportedNodes(feedbackForGraph(await feedbackStore.get(), graph), graph);
    const topK = (admin.retrieval?.topK ?? 3) + exclude.length + reported.size;
    return retrieve(v, graph, vecs, { ...retrievalFor(admin.retrieval, graph), topK, aliasText: text })
      .filter(c => !exclude.includes(c.id) && !reported.has(c.id));
  };
  const cap = admin.agent?.dailyCallCap ?? AGENT_DAILY_CAP_DEFAULT;
  const providerText = () => `${state.answered.id}/${state.answered.model}`;
  return { provider, ask, searchGraph, budget: { take: () => takeAgentCall(cap) }, state, providerText };
}
const cleanPayload = payload => ({ sentence: str(payload?.sentence, 1000), word: str(payload?.word, 100), context: str(payload?.context, 1000), pageTitle: str(payload?.pageTitle, 120) });
const cleanEvidence = ev => (ev?.nodeId ? { nodeId: str(ev.nodeId, 100), nodeLabel: str(ev.nodeLabel, 100) } : null);

// 이어 묻기 한 번. 보내는 글은 호버와 같은 범위(문장·단어·앞 문장·제목)만 받는다(문단은 받지 않는다, ADR 0017 열린 결정 1).
// 호버 결과 캐시·피드백 기록은 건드리지 않는다
async function followup({ payload, question, prev, candidateIds }) {
  const t0 = Date.now();
  const q = cleanQuestion(question);
  if (!q) throw new Error('질문을 두 글자 이상 적어 주세요.');
  const [{ graph }, blocklist] = await Promise.all([getMergedGraph(), loadBlocklist()]);
  const base = { answer: '', evidence: null, rejected: null, capped: false, found: [], theme: graph.theme, domain: graph.domain };
  const deps = await agentDeps(graph);
  if (deps.provider.def.kind === 'demo') return { ...base, stopText: '데모 모드에서는 이어 묻기를 쓸 수 없어요.', debug: { trace: [], calls: 0 } };
  const p = cleanPayload(payload);
  if (!p.sentence.trim()) throw new Error('물어볼 문장이 없어요.');
  const pv = { meaning: str(prev?.meaning, 300), analogy: str(prev?.analogy, 300), evidence: cleanEvidence(prev?.evidence) };
  const r = await keepAlive(runFollowup({
    graph, payload: p, question: q, prev: pv,
    candidateIds: Array.isArray(candidateIds) ? candidateIds.slice(0, 10).map(id => str(id, 100)) : [],
    ask: deps.ask, searchGraph: deps.searchGraph, blocklist, budget: deps.budget
  }));
  // 보인 답 수(날짜별, T-218 👎 비율의 분모). 14일만 남긴다
  if (r.answer) {
    const { agentAnswerCounts } = await chrome.storage.local.get('agentAnswerCounts');
    await chrome.storage.local.set({ agentAnswerCounts: bumpHover(agentAnswerCounts || {}, localDay(Date.now())) });
  }
  return { ...base, ...r, question: q, debug: { ...r.debug, provider: deps.providerText(), fallbacks: deps.state.fallbacks, ms: Date.now() - t0 } };
}

/* ───────────── 👎 교정 진단 에이전트 (T-220, ADR 0017 에이전트 3) ───────────── */

// 원래 결과(👎한 결과) 기록 다듬기. 콘텐츠 스크립트가 준 값은 진단 단서로만 쓰고, 노드 사실은 늘 그래프에서 읽는다
const num = v => (Number.isFinite(v) ? v : null);
function cleanOrig(orig) {
  const cands = Array.isArray(orig?.candidates) ? orig.candidates.slice(0, 10) : [];
  return {
    meaning: str(orig?.meaning, 300),
    analogy: str(orig?.analogy, 300),
    evidence: cleanEvidence(orig?.evidence),
    candidates: cands.filter(c => typeof c?.id === 'string').map(c => ({ id: str(c.id, 100), label: str(c.label, 100), score: num(c.score), tagId: typeof c.tagId === 'string' ? str(c.tagId, 100) : null, tagSim: num(c.tagSim) })),
    grounding: orig?.grounding ? { ok: orig.grounding.ok === true, reason: str(orig.grounding.reason, 40) } : null,
    ending: orig?.ending ? { ok: orig.ending.ok !== false } : null,
    reason: REASONS.includes(orig?.reason) ? orig.reason : null
  };
}

// 진단 한 번. 쓰기는 하지 않는다(제안 action만 돌려주고, 사용자가 누르면 agent:diagnose-apply)
async function diagnose({ payload, orig, rerun, downNodeId }) {
  const t0 = Date.now();
  const [{ graph, session }, blocklist, common] = await Promise.all([getMergedGraph(), loadBlocklist(), loadChosenCommon()]);
  const base = { diagnosis: null, analogy: '', evidence: null, rejected: null, note: null, capped: false, found: [], action: null, theme: graph.theme, domain: graph.domain };
  const deps = await agentDeps(graph);
  if (deps.provider.def.kind === 'demo') return { ...base, stopText: '데모 모드에서는 살펴보기를 쓸 수 없어요.', debug: { trace: [], calls: 0 } };
  const p = cleanPayload(payload);
  if (!p.sentence.trim()) throw new Error('살펴볼 문장이 없어요.');
  const o = cleanOrig(orig);
  const down = str(downNodeId || o.evidence?.nodeId, 100);
  const r = await keepAlive(runDiagnose({
    graph, payload: p, orig: o,
    rerun: rerun ? { analogy: str(rerun.analogy, 300), evidence: cleanEvidence(rerun.evidence) } : null,
    downNodeIds: down ? [down] : [],
    ask: deps.ask, searchGraph: deps.searchGraph, blocklist, budget: deps.budget
  }));
  const action = r.analogy && r.evidence
    ? diagnoseAction({ graph, nodeId: r.evidence.nodeId, sentence: p.sentence, loggedIn: !!session, commonTagIds: new Set(common.tags.map(t => t.id)), blockTerms: blocklist })
    : null;
  return { ...base, ...r, action, downNodeId: down || null, debug: { ...r.debug, provider: deps.providerText(), fallbacks: deps.state.fallbacks, ms: Date.now() - t0 } };
}

/* ───────────── 새 관심사 만들기 도우미 (T-225, ADR 0017 에이전트 2) ───────────── */

// 상태는 chrome.storage.session interestHelper 하나. 단계마다 저장하고, 서비스 워커가 깨면(아래 맨 끝, helper:status) 이어 간다.
// LLM·하루 상한은 다른 에이전트와 같은 agentDeps(agent.providerOrder 체인, agentCalls 공유).
// 쓰기는 마지막 단계 한 번: 로그인한 같은 사용자의 오버레이 뒤에 검수 대기(draft) 노드만 붙인다(규칙 3). 공통 그래프는 읽기만
const HELPER_KEY = 'interestHelper';
let helperRun = null;

const readHelper = async () => (await chrome.storage.session.get(HELPER_KEY))[HELPER_KEY] || null;

async function helperDeps(st) {
  const [{ overlay }, common, blockTerms, agent] = await Promise.all([getSessionAndOverlay(), loadChosenCommon(), loadBlocklist(), agentDeps(null)]);
  const ov = normalizeOverlay(overlay);
  const existing = [...(ov.nodes || []), ...(st.mode === 'add' ? common.nodes : [])];
  return {
    ask: agent.ask, budget: agent.budget, tags: common.tags, blockTerms, existing,
    reservedIds: common.nodes.map(n => n.id),
    write: async nodes => {
      const { store, session, overlay: fresh } = await getSessionAndOverlay();
      if (!session || (st.user && session.name !== st.user)) throw new Error(HELPER_TEXT.loggedOut);
      const next = mergeHelperDrafts(normalizeOverlay(fresh), nodes, { name: st.name, mode: st.mode, reservedIds: common.nodes.map(n => n.id) });
      if (validateOverlay(next).length) throw new Error(HELPER_TEXT.writeFail);
      await store.saveOverlay(session, next);
      return { written: nodes.length };
    }
  };
}

// 돌고 있지 않으면 세션 상태에서 이어 돈다(한 서비스 워커 안에서 하나만)
function kickHelper() {
  if (helperRun) return helperRun;
  helperRun = keepAlive((async () => {
    const st = await readHelper();
    if (st?.status !== 'running') return;
    const deps = await helperDeps(st);
    await runHelper(st, deps, { save: s => chrome.storage.session.set({ [HELPER_KEY]: s }) });
  })()).catch(async e => {
    console.warn('[helper] 도우미가 멈췄어요', e);
    const st = await readHelper();
    if (st?.status === 'running') await chrome.storage.session.set({ [HELPER_KEY]: { ...st, status: 'error', phase: 'done', error: String(e?.message || e).slice(0, 200) } });
  }).finally(() => { helperRun = null; });
  return helperRun;
}

async function helperStatus() {
  const st = await readHelper();
  if (st?.status === 'running') kickHelper();
  const common = await loadChosenCommon();
  return helperView(st, common.tags);
}

/* ───────────── 메시지 ───────────── */

// 이중 방어(T-107): content.js가 막지만, 보낸 탭 호스트가 제외 목록이면 임베딩·LLM 없이 끝낸다.
// explain()을 부르는 모든 길(포트, sendMessage explain, 피드백 rerun)에서 먼저 확인한다.
// topHost(T-111): iframe이면 content.js가 페이로드에 싣는 최상위 페이지 호스트. 보낸 문서(sender.url)가
// 제외가 아니어도 최상위가 제외면 막는다. explain 포트·메시지는 우리 콘텐츠 스크립트만 보낼 수 있어
// (externally_connectable 없음, 페이지 스크립트는 chrome.runtime에 못 닿음) 이 값을 믿어도 된다
const SITE_OFF = '이 사이트에서는 꺼져 있어요.';
async function siteBlocked(sender, topHost) {
  if (!sender?.tab) return false; // 확장 페이지 등은 설정을 읽지 않고 통과
  const { excludedHosts } = await getSettings();
  return globalThis.AnalogySiteFilter.isBlockedSender(sender, excludedHosts, topHost);
}
async function assertSiteAllowed(sender, topHost) {
  if (await siteBlocked(sender, topHost)) throw new Error(SITE_OFF);
}

// 한 탭에는 말풍선 하나(T-147): 어떤 프레임에서 explain이 시작되면 같은 탭의 다른 프레임 말풍선을 닫는다.
// frameId 없이 보내 모든 프레임이 받고, 보낸 프레임은 자기 표지(exceptToken)라 무시한다. tabs 권한은 필요 없다.
// 콘텐츠 스크립트가 없는 프레임만 있으면 거절되는데, 닫을 말풍선도 없다는 뜻이라 무시한다
function closeOtherBubbles(sender, exceptToken) {
  const tabId = sender?.tab?.id;
  if (tabId == null || tabId < 0 || !exceptToken) return;
  try { chrome.tabs.sendMessage(tabId, { type: 'close-bubble', exceptToken }).catch(() => {}); } catch {}
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'explain') return;
  port.onMessage.addListener(async msg => {
    if (msg.type !== 'explain') return;
    try {
      const post = m => { try { port.postMessage({ id: msg.id, ...m }); } catch {} };
      if (await siteBlocked(port.sender, msg.payload?.topHost)) { post({ type: 'error', error: SITE_OFF }); return; }
      closeOtherBubbles(port.sender, msg.frameToken);
      countHover();
      // 병합 그래프를 먼저 읽어 모든 stage 메시지에 테마를 싣는다(T-108). 첫 결과 전 말풍선이 다른 테마로 뜨지 않게.
      // 읽은 그래프는 explain에 넘겨 다시 읽지 않는다
      const merged = await getMergedGraph();
      const theme = merged.graph.theme;
      const result = await explain(msg.payload, stage => post({ type: 'stage', stage, theme }), partial => post({ type: 'partial', partial }), merged);
      port.postMessage({ type: 'result', id: msg.id, result });
    } catch (e) {
      console.error(e);
      try { port.postMessage({ type: 'error', id: msg.id, error: String(e?.message || e) }); } catch {}
    }
  });
});

// 로그인 사용자만: 같은 노드에 서로 다른 문장 👎가 쌓이면 오버레이 feedbackBoosts를 낮춘다(T-130).
// feedbackBoosts는 지금 기록만으로 정해진다(boostForNode). 기록이 바뀌는 모든 길(👎·되돌리기·전부 지우기,
// 500건 상한으로 오래된 기록이 밀려남)에서 부른다. 이미 있는 키 전부 + 이번에 건드린 노드를 다시 계산하고,
// 0이 된 키는 지우며, 값이 바뀔 때만 저장한다.
// 오버레이 변경은 로그인 세션의 saveOverlay로만(규칙 3). 실패해도 피드백 기록은 이미 저장돼 있다.
async function syncBoosts(records, touchedNodeIds = []) {
  try {
    // getSessionAndOverlay()는 읽기 실패를 null로 삼키므로, 빈 오버레이로 덮어쓰지 않게 여기서 직접 읽는다
    const store = await getUserStore();
    const session = await store.getSession();
    if (!session) return;
    const ov = normalizeOverlay(await store.loadOverlay(session));
    // 손으로 넣은 nodeBoosts는 건드리지 않고 feedbackBoosts에만 쓴다. 둘은 mergeGraphs가 더한다
    const current = ov.feedbackBoosts || {};
    const next = {};
    for (const id of new Set([...Object.keys(current), ...touchedNodeIds.filter(Boolean)])) {
      const v = boostForNode(records, id);
      if (v !== 0) next[id] = v;
    }
    const same = Object.keys(next).length === Object.keys(current).length && Object.entries(next).every(([id, v]) => current[id] === v);
    if (same) return;
    await store.saveOverlay(session, { ...ov, feedbackBoosts: next });
  } catch (e) {
    console.warn('[feedback] 오버레이 가중치를 못 바꿨어요', e);
  }
}

// 로그인 사용자만: "더 맞는 개념" 교정 중 내 노드 + 내 태그 대상을 그 태그 examples에 넣는다(T-131, ADR 0010 3단계).
// 지금 기록만으로 정해져(syncCorrectionExamples) 되돌리기·전부 지우기·500건 상한에도 맞춰진다. 바뀔 때만 저장.
// 공통 태그 대상은 오버레이를 건드리지 않고 운영자 내보내기로만 간다(규칙 3·9). 실패해도 피드백 기록은 이미 저장돼 있다.
async function syncCorrections(records) {
  try {
    const store = await getUserStore();
    const session = await store.getSession();
    if (!session) return;
    const ov = normalizeOverlay(await store.loadOverlay(session));
    // 고른 공통 관심사(T-302). 여기서는 내 노드·내 태그 대상만 다루고 태그 사전(tags.json)은 공유라, 어느 관심사여도 결과가 같다
    const common = await loadChosenCommon();
    const { overlay, changed } = syncCorrectionExamples(ov, records, mergeGraphs(common, ov), {
      blockTerms: await loadBlocklist(),
      commonTagIds: new Set(common.tags.map(t => t.id))
    });
    if (changed) await store.saveOverlay(session, overlay);
  } catch (e) {
    console.warn('[feedback] 교정 예문을 내 그래프에 넣지 못했어요', e);
  }
}

const handlers = {
  async 'settings:get'() {
    const admin = await getAdminConfig();
    const provider = await resolveProvider();
    return {
      settings: await getSettings(),
      admin: { ...admin, sharedApiKeys: Object.fromEntries(Object.keys(admin.sharedApiKeys || {}).map(k => [k, true])) },
      providers: Object.fromEntries(Object.entries(PROVIDERS).map(([id, p]) => [id, { label: p.label, models: p.models, defaultModel: p.defaultModel, keyUrl: p.keyUrl, free: !!p.free, keyOptional: !!p.keyOptional }])),
      active: { id: provider.id, model: provider.model, hasKey: !!provider.apiKey, locked: provider.locked }
    };
  },
  async 'settings:save'({ patch }) {
    return saveSettings(patch);
  },
  async 'auth:status'() {
    const store = await getUserStore();
    return { adapter: store.id, adapterLabel: store.label, session: await store.getSession() };
  },
  async 'auth:login'({ nickname }) {
    const store = await getUserStore();
    return store.login({ nickname });
  },
  async 'auth:logout'() {
    const store = await getUserStore();
    await store.logout();
    return true;
  },
  async 'overlay:get'() {
    const { session, overlay } = await getSessionAndOverlay();
    if (!session) throw new Error('로그인이 필요해요.');
    return normalizeOverlay(overlay);
  },
  async 'overlay:save'({ overlay }) {
    const { store, session } = await getSessionAndOverlay();
    if (!session) throw new Error('로그인이 필요해요.');
    const errors = validateOverlay(overlay);
    if (errors.length) return { ok: false, errors };
    await store.saveOverlay(session, normalizeOverlay(overlay));
    return { ok: true };
  },
  // AI 관심사 그래프 초안(T-301). 로그인 사용자만(규칙 3·D-4). 기존 제공자 체인으로 한 번 부르고(규칙 7),
  // 태그 목록은 공통 태그 사전(tags.json, 규칙 9)에서. 저장하지 않고 검수 대기 노드만 돌려준다(설정 화면이 overlay:save로 저장)
  async 'graph:draft'({ name, mode }) {
    const { session, overlay } = await getSessionAndOverlay();
    if (!session) throw new Error('로그인이 필요해요.');
    // 태그 사전은 공유(tags.json)라 관심사와 무관. 피할 id는 고른 공통 관심사 노드 + 내 노드(T-302)
    const [common, blockTerms, admin, settings, provider] = await Promise.all([loadChosenCommon(), loadBlocklist(), getAdminConfig(), getSettings(), resolveProvider()]);
    // 이름은 domain·analogyPrefix로 말풍선에 보이므로 금칙어도 막는다(규칙 11)
    const nameErr = draftNameError(name, blockTerms);
    if (nameErr) throw new Error(nameErr);
    const n = validDraftName(name);
    const ov = normalizeOverlay(overlay);
    let text, answered = `${provider.id}/${provider.model}`;
    if (provider.def.kind === 'demo') text = demoDraftText(n);
    else {
      const { system, user } = buildDraftPrompt({ name: n, tags: common.tags });
      // 체인 전체에 마감 하나(순서마다 남은 시간만 준다). 크롬 이벤트 5분 제한 전에 끝나고, 그동안 서비스 워커를 깨워 둔다
      const ms = admin.draft?.deadlineMs ?? DRAFT_DEADLINE_MS;
      const deadlineAt = Date.now() + ms;
      try {
        const r = await keepAlive(withDeadline(completeWithFallback(buildChain(provider, admin, settings), system, user,
          { json: true, maxTokens: 4000, timeoutMs: ms, deadline: deadlineAt }, { cooldowns, cooldown: admin.cooldown }), ms));
        text = r.text;
        answered = `${r.provider.id}/${r.provider.model}`;
      } catch (e) {
        throw draftError(e, { deadlineAt });
      }
    }
    const existingIds = [...(ov.nodes || []).map(x => x.id), ...common.nodes.map(x => x.id)];
    const parsed = parseDraft(text, { tags: common.tags, existingIds, blockTerms });
    return { ...parsed, name: n, mode: mode === 'new' ? 'new' : 'add', provider: answered };
  },
  // 새 관심사 만들기 도우미(T-225). 로그인 사용자만. 시작만 하고 바로 돌려준다(진행은 helper:status로 본다)
  async 'helper:start'({ name, notes, mode }) {
    const { session } = await getSessionAndOverlay();
    if (!session) throw new Error(HELPER_TEXT.loggedOut);
    const [blockTerms, provider] = await Promise.all([loadBlocklist(), resolveProvider()]);
    const nameErr = draftNameError(name, blockTerms);
    if (nameErr) throw new Error(nameErr);
    const memo = cleanNotes(notes, blockTerms);
    if (memo === null) throw new Error(HELPER_TEXT.notesBlocked);
    if (provider.def.kind === 'demo') throw new Error(HELPER_TEXT.demo);
    const cur = await readHelper();
    if (cur?.status === 'running') { kickHelper(); throw new Error(HELPER_TEXT.running); }
    const st = { ...newHelperState({ name: validDraftName(name), notes: memo, mode }), user: session.name };
    await chrome.storage.session.set({ [HELPER_KEY]: st });
    kickHelper();
    return helperStatus();
  },
  async 'helper:status'() { return helperStatus(); },
  async 'graph:info'() {
    // 설정 화면 "공통 저장소"·팝업·말풍선 테마 미리 받기가 쓴다. 고른 공통 관심사(T-302)
    const common = await loadChosenCommon();
    const { graph, session } = await getMergedGraph();
    return {
      common: { id: common.id, domain: common.domain, version: common.version, nodes: common.nodes.length, tags: common.tags.length, nodeList: common.nodes.map(n => ({ id: n.id, label: n.label })), tagList: common.tags.map(t => ({ id: t.id, label: t.label })) },
      merged: { domain: graph.domain, theme: graph.theme, nodes: graph.nodes.length, tags: graph.tags.length, userNodes: graph.sources.userNodes, draftNodes: graph.sources.draftNodes, usesCommon: !!graph.sources.common },
      session
    };
  },
  async 'embed:warmup'() {
    const { graph } = await getMergedGraph();
    const r = await ensureGraphVectors(graph);
    return { embedderId: r.embedderId, status: r.embedderStatus, vectors: r.vecs.size, loadError: r.loadError, vectorSources: r.vectorSources };
  },
  async 'embed:status'() {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (!ctx.length) return { status: 'idle' };
    return offscreen('status');
  },
  async 'cache:clear'() {
    vecMem = new Map();
    await chrome.storage.local.remove('vecCache');
    await chrome.storage.session.remove('results');
    return true;
  },
  async 'provider:test'() {
    const provider = await resolveProvider();
    if (provider.def.kind === 'demo') return { ok: true, text: '데모 모드는 LLM을 부르지 않아요.' };
    const text = await complete(provider, '짧게 답하는 도우미다.', '"연결 성공"이라고만 답해.', { json: false });
    return { ok: true, text: text.trim().slice(0, 80), provider: `${provider.id}/${provider.model}` };
  },
  async explain(payload, sender) { await assertSiteAllowed(sender, payload?.topHost); countHover(); return explain(payload); },
  // 말풍선 이어 묻기(T-216). 제외 사이트 이중 방어는 explain과 같다
  async 'agent:ask'(msg, sender) { await assertSiteAllowed(sender, msg.payload?.topHost); return followup(msg); },
  // 👎 교정 진단(T-220). 사용자가 "왜 틀렸는지 살펴볼게요"를 눌렀을 때만. 쓰기 없음
  async 'agent:diagnose'(msg, sender) { await assertSiteAllowed(sender, msg.payload?.topHost); return diagnose(msg); },
  // 진단 뒤 사용자가 누른 쓰기 하나: 피드백 층 고정(pick) 또는 로그인 + 내 노드·내 태그면 내 태그 예문(같은 pick 기록을
  // syncCorrections가 corrections.js 거름으로 반영, T-131). 제안은 여기서 다시 계산해 콘텐츠 스크립트 값을 믿지 않는다.
  // 공통 그래프는 어떤 길로도 쓰지 않는다(규칙 3·9)
  async 'agent:diagnose-apply'({ kind, sentence, downNodeId, nodeId, provider, topHost }, sender) {
    await assertSiteAllowed(sender, topHost);
    if (kind !== 'pin' && kind !== 'example') throw new Error('알 수 없는 조치예요.');
    const s = str(sentence, 1000);
    if (!s.trim()) throw new Error('문장이 없어요.');
    const [{ graph, session }, blockTerms, common] = await Promise.all([getMergedGraph(), loadBlocklist(), loadChosenCommon()]);
    const action = diagnoseAction({ graph, nodeId: str(nodeId, 100), sentence: s, loggedIn: !!session, commonTagIds: new Set(common.tags.map(t => t.id)), blockTerms });
    if (!action) throw new Error('지금 그래프에 없는 개념이에요.');
    if (kind === 'example' && action.kind !== 'example') throw new Error(session ? '이 개념에는 내 태그 예문을 넣을 수 없어요.' : '로그인해야 내 태그 예문을 넣을 수 있어요.');
    const down = str(downNodeId, 100);
    const res = await handlers.feedback({ record: { sentence: s, nodeId: down && graph.nodes.some(n => n.id === down) ? down : null, tagId: null, vote: 'pick', pickedNodeId: action.nodeId, pickedTagId: action.tagId, provider: str(provider, 100) } }, sender);
    return { id: res.id, kind: action.kind };
  },
  // 피드백 기록 → 같은 문장을 바로 다시 비유(rerun이 있으면). 결과의 feedbackApplied로 반영 여부를 보인다
  async feedback({ record, rerun }, sender) {
    await assertSiteAllowed(sender, record?.topHost || rerun?.topHost);
    const r = { ...record, id: crypto.randomUUID(), ts: Date.now(), sentenceHash: await sentenceHashOf(record.sentence) };
    delete r.vec; // 벡터는 받지 않고 여기서 만든다
    delete r.topHost; // 검사용일 뿐 기록·내보내기에 남기지 않는다(T-111)
    // 이어 묻기 답을 본 뒤 남긴 피드백인지(T-218, 👎 비율 집계용). 참일 때만 남긴다
    if (record?.afterAgent === true) r.afterAgent = true; else delete r.afterAgent;
    if (r.vote === 'down' || r.vote === 'pick') {
      const vec = await queryVector(record.sentence);
      if (vec) r.vec = vec;
    }
    const records = addRecord(await feedbackStore.get(), r);
    await feedbackStore.set(records);
    // 👍·고정이어도 500건 상한으로 오래된 👎가 밀려났을 수 있어 항상 맞춘다
    await syncBoosts(records, r.vote === 'down' ? [r.nodeId] : []);
    await syncCorrections(records);
    return { id: r.id, result: rerun ? await explain(rerun) : null };
  },
  async 'feedback-reason'({ id, reason }) {
    await feedbackStore.set(setReason(await feedbackStore.get(), id, reason));
    return true;
  },
  async 'feedback-undo'({ id, rerun }, sender) {
    if (rerun) await assertSiteAllowed(sender, rerun.topHost);
    const before = await feedbackStore.get();
    const undone = before.find(r => r.id === id);
    const records = removeRecord(before, id);
    await feedbackStore.set(records);
    if (undone?.vote === 'down') await syncBoosts(records, [undone.nodeId]);
    if (undone?.vote === 'pick') await syncCorrections(records);
    return { id, result: rerun ? await explain(rerun) : null };
  },
  // "내 피드백" 설정 화면(T-132). 최신순, 라벨은 지금 병합 그래프에서 찾고 없으면 id 그대로
  async 'feedback:list'() {
    const [records, { graph }, settings, ...commons] = await Promise.all([feedbackStore.get(), getMergedGraph(), getSettings(), ...COMMON_INTERESTS.map(i => loadCommonGraph(i.id))]);
    // 다른 공통 관심사에서 남긴 기록도 라벨로 보이게 모든 공통 그래프에서 찾는다(T-302). 지금 병합 그래프가 먼저
    const labels = new Map([...commons.flatMap(c => c.nodes), ...graph.nodes].map(n => [n.id, n.label]));
    const labelOf = id => (id ? labels.get(id) || id : null);
    // 기록은 뒤에 붙으므로 먼저 뒤집어, ts가 같아도 나중 기록이 앞에 오게 한다(안정 정렬)
    const items = [...records].reverse().sort((a, b) => b.ts - a.ts).map(r => ({
      id: r.id, ts: r.ts, sentence: r.sentence, masked: maskSentence(r.sentence ?? ''), vote: r.vote, reason: r.reason || null,
      nodeId: r.nodeId, nodeLabel: labelOf(r.nodeId), pickedNodeId: r.pickedNodeId || null, pickedLabel: labelOf(r.pickedNodeId)
    }));
    return { items, share: settings.feedbackShare === true };
  },
  async 'feedback:stats'() {
    const { hoverCounts, agentAnswerCounts } = await chrome.storage.local.get(['hoverCounts', 'agentAnswerCounts']);
    const records = await feedbackStore.get(), today = localDay(Date.now());
    // agent: 이어 묻기 뒤 👎 비율(T-218)
    return { ...summarizeFeedback(records, hoverCounts || {}, today), agent: summarizeAgentFeedback(records, hoverCounts || {}, agentAnswerCounts || {}, today) };
  },
  // 근거 검사 주간 집계(T-146, "내 피드백" 아래)
  async 'grounding:stats'() {
    const { groundingLog, groundingCounts } = await chrome.storage.local.get(['groundingLog', 'groundingCounts']);
    return summarizeGrounding(groundingLog || [], groundingCounts || {}, localDay(Date.now()));
  },
  // "괜찮은 비유였어요"(오탐 표시). flag null이면 표시를 뗀다. 기록 쓰기와 겹치지 않게 같은 차례로
  async 'grounding:flag'({ id, flag }) {
    const job = groundingQueue.then(async () => {
      const { groundingLog } = await chrome.storage.local.get('groundingLog');
      await chrome.storage.local.set({ groundingLog: flagGroundingEntry(groundingLog || [], id, flag ?? null) });
    });
    groundingQueue = job.catch(() => {}); // 실패해도 다음 기록은 이어서
    await job;
    return true;
  },
  // 운영자용 교정 내보내기(T-131). 공통 노드·공통 태그 대상만, 가린 문장만. 서버로 보내지 않는다(설정 화면이 로컬 파일로 받는다)
  async 'corrections:export'() {
    // 공통 그래프로 노드·기존 예문을 찾는다(내 관심사만 쓰는 useCommon false여도 공통 노드 교정을 내보낸다).
    // 지금 고른 관심사(settings.interest) 하나만(T-157). 파일 최상위 interest로 승인 절차가 그 관심사 평가셋·가드로 간다.
    // 다른 관심사 기록은 buildCorrectionsExport가 걸러 한 파일에 섞이지 않는다. 모르는 값이면 로더처럼 메이플
    const [records, settings, blockTerms, { groundingLog }] = await Promise.all([feedbackStore.get(), getSettings(), loadBlocklist(), chrome.storage.local.get('groundingLog')]);
    const interest = commonInterest(settings.interest)?.id || DEFAULT_INTEREST;
    const common = await loadCommonGraph(interest);
    return buildCorrectionsExport(records, common, {
      interest,
      blockTerms,
      // 근거 검사 숨김 샘플(T-146)은 보내기 동의가 켜졌을 때만 싣는다
      share: settings.feedbackShare === true,
      groundingLog: groundingLog || [],
      today: localDay(Date.now()),
      commonTagIds: new Set(common.tags.map(t => t.id)),
      commonGraphVersion: common.version ?? null,
      tagsVersion: common.tagsVersion ?? null
    });
  },
  // 결과 캐시 키에 피드백 지문이 있어서 캐시는 따로 안 지워도 된다
  async 'feedback:clear'() {
    await feedbackStore.set([]);
    // 근거 검사 기록(T-146)도 함께 지운다(처리방침과 같게). 기록 쓰기 차례 뒤에 지워 지운 뒤 되살아나지 않게
    const job = groundingQueue.then(() => chrome.storage.local.remove(['groundingLog', 'groundingCounts']));
    groundingQueue = job.catch(() => {});
    await job;
    await syncBoosts([]);
    await syncCorrections([]);
    return true;
  },
  async 'open-options'() { await chrome.runtime.openOptionsPage(); return true; }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return;
  const h = handlers[msg.type];
  if (!h) return;
  h(msg, sender).then(r => sendResponse({ ok: true, data: r }), e => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});

// 서비스 워커가 다시 뜨면 하다 만 도우미를 이어 간다(T-225)
readHelper().then(st => { if (st?.status === 'running') kickHelper(); }).catch(() => {});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'install') return;
  // 첫 실행 안내(T-116): 설정 화면이 열리기 전에 표시를 남긴다
  try { await chrome.storage.local.set({ onboarding: { pending: true } }); }
  catch (e) { console.warn('[install] 첫 실행 안내 상태를 저장하지 못했어요', e); } // 조용히 삼키지 않는다(T-137)
  finally { chrome.runtime.openOptionsPage(); } // 저장이 실패해도 설정 화면은 연다
});

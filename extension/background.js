// 서비스 워커: 저장소 병합 → 임베딩 → 그래프 검색 → LLM 비유 생성
import { getAdminConfig, getSettings, saveSettings, resolveProvider } from './lib/config.js';
import { complete, parseJSONLoose, PROVIDERS } from './lib/providers.js';
import { buildChain, completeWithFallback } from './lib/fallback.js';
import { mergeGraphs, tagText, nodeText, sha1 } from './lib/graph.js';
import { loadCommonGraph, getUserStore, validateOverlay, normalizeOverlay } from './lib/stores.js';
import { retrieve, topTags } from './lib/retrieval.js';
import { buildAbstractPrompt, buildAnalogyPrompt, demoAnswer, extractMeaning } from './lib/prompt.js';

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

async function getMergedGraph() {
  const common = await loadCommonGraph();
  const { session, overlay } = await getSessionAndOverlay();
  // 로그아웃 상태 = 공통 저장소만. 로그인 상태 = 공통 + 내 오버레이
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

async function ensureGraphVectors(graph) {
  const init = await keepAlive(offscreen('init'));
  const embedderId = init.embedderId;
  const cache = await loadVecCache();
  const tagMap = new Map(graph.tags.map(t => [t.id, t]));
  const items = [
    ...graph.tags.map(t => ({ key: 'tag:' + t.id, text: tagText(t) })),
    ...graph.nodes.map(n => ({ key: 'node:' + n.id, text: nodeText(n, tagMap) }))
  ];
  for (const it of items) it.cacheKey = `${embedderId}|${await sha1(it.text)}`;
  const missing = items.filter(it => !cache.has(it.cacheKey));
  if (missing.length) {
    const { vectors } = await keepAlive(offscreen('embed', { texts: missing.map(m => m.text), kind: 'passage' }));
    missing.forEach((m, i) => cache.set(m.cacheKey, vectors[i]));
    await saveVecCache();
  }
  const vecs = new Map(items.map(it => [it.key, cache.get(it.cacheKey)]));
  return { vecs, embedderId, embedderStatus: init.status };
}

/* ───────────── 설명 파이프라인 ───────────── */

// 429 쿨다운 기록. 서비스 워커가 잠들어도 브라우저를 닫기 전까지 유지된다
const cooldowns = {
  get: async () => (await chrome.storage.session.get('llmCooldowns')).llmCooldowns || {},
  set: llmCooldowns => chrome.storage.session.set({ llmCooldowns })
};

const RESULT_CACHE_MAX = 200;
async function cacheGet(key) {
  const got = await chrome.storage.session.get('results');
  return got.results?.[key] || null;
}
async function cachePut(key, value) {
  const got = await chrome.storage.session.get('results');
  const results = got.results || {};
  results[key] = value;
  const keys = Object.keys(results);
  if (keys.length > RESULT_CACHE_MAX) for (const k of keys.slice(0, keys.length - RESULT_CACHE_MAX)) delete results[k];
  await chrome.storage.session.set({ results });
}

// onPartial({ meaning }) 은 스트리밍 중 meaning 이 처음 완성될 때 한 번 불린다. 비유는 넣지 않는다(검증 전이라서)
async function explain({ sentence, context, word, pageTitle, noCache }, onStage = () => {}, onPartial = null) {
  const t0 = Date.now();
  const settings = await getSettings();
  const admin = await getAdminConfig();
  const provider = await resolveProvider();

  onStage('graph');
  const { graph, session } = await getMergedGraph();
  const graphKey = JSON.stringify([graph.sources, session?.userId || null, graph.nodes.length]);
  const cacheKey = await sha1([sentence, word, graphKey, provider.id, provider.model, settings.preciseMode].join('|'));
  if (!noCache) {
    const hit = await cacheGet(cacheKey);
    if (hit) return { ...hit, cached: true };
  }

  onStage('model');
  const { vecs, embedderId, embedderStatus } = await ensureGraphVectors(graph);

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
  if (settings.preciseMode && provider.def.kind !== 'demo') {
    onStage('abstract');
    const p = buildAbstractPrompt({ sentence, word, pageTitle });
    abstractText = (await ask(p.system, p.user, { json: false })).trim();
    if (abstractText) queryText = `${abstractText} ${sentence}`;
  }

  onStage('search');
  const { vectors: [q] } = await offscreen('embed', { texts: [queryText], kind: 'query' });
  const candidates = retrieve(q, graph, vecs, admin.retrieval);
  const tags = topTags(q, graph, vecs, 5);

  onStage('generate');
  let answer;
  if (provider.def.kind === 'demo') {
    answer = demoAnswer({ candidates, analogyPrefix: graph.analogyPrefix });
  } else {
    const p = buildAnalogyPrompt({ sentence, context, word, pageTitle, domain: graph.domain, analogyPrefix: graph.analogyPrefix, candidates });
    let sentMeaning = false;
    const onText = onPartial && (text => {
      if (sentMeaning) return;
      const meaning = extractMeaning(text);
      if (meaning) { sentMeaning = true; onPartial({ meaning }); }
    });
    const raw = await ask(p.system, p.user, { json: true, onText });
    answer = parseJSONLoose(raw);
    if (!answer) throw new Error('모델 응답을 해석하지 못했어요: ' + raw.slice(0, 120));
  }

  // 근거 검증: 후보에 없는 노드를 댔으면 비유를 버린다
  const chosen = candidates.find(c => c.id === answer.nodeId) || null;
  if (answer.analogy && !chosen) {
    answer.analogy = '';
    answer.rejected = '모델이 근거 목록에 없는 개념을 골라서 비유를 숨겼어요.';
  }

  const result = {
    meaning: answer.meaning || '',
    analogy: answer.analogy || '',
    mapping: answer.mapping || '',
    rejected: answer.rejected || null,
    evidence: chosen ? {
      nodeId: chosen.id,
      nodeLabel: chosen.label,
      source: chosen.source,
      tagLabel: graph.tags.find(t => t.id === answer.tagId)?.label || chosen.tag?.label || null
    } : null,
    domain: graph.domain,
    theme: graph.theme,
    debug: {
      candidates: candidates.map(c => ({ id: c.id, label: c.label, score: c.score, direct: c.direct, tag: c.tag?.label, tagSim: c.tag?.sim, source: c.source })),
      topTags: tags,
      abstractText,
      embedderId,
      embedderStatus,
      provider: `${answered.id}/${answered.model}`,
      fallbacks,
      llmRetries: llmStats.retries,
      user: session ? session.name : null,
      ms: Date.now() - t0
    }
  };
  await cachePut(cacheKey, result);
  return result;
}

/* ───────────── 메시지 ───────────── */

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'explain') return;
  port.onMessage.addListener(async msg => {
    if (msg.type !== 'explain') return;
    try {
      const post = m => { try { port.postMessage({ id: msg.id, ...m }); } catch {} };
      const result = await explain(msg.payload, stage => post({ type: 'stage', stage }), partial => post({ type: 'partial', partial }));
      port.postMessage({ type: 'result', id: msg.id, result });
    } catch (e) {
      console.error(e);
      try { port.postMessage({ type: 'error', id: msg.id, error: String(e?.message || e) }); } catch {}
    }
  });
});

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
  async 'graph:info'() {
    const common = await loadCommonGraph();
    const { graph, session } = await getMergedGraph();
    return {
      common: { id: common.id, domain: common.domain, version: common.version, nodes: common.nodes.length, tags: common.tags.length, nodeList: common.nodes.map(n => ({ id: n.id, label: n.label })), tagList: common.tags.map(t => ({ id: t.id, label: t.label })) },
      merged: { domain: graph.domain, nodes: graph.nodes.length, tags: graph.tags.length, userNodes: graph.sources.userNodes, usesCommon: !!graph.sources.common },
      session
    };
  },
  async 'embed:warmup'() {
    const { graph } = await getMergedGraph();
    const r = await ensureGraphVectors(graph);
    return { embedderId: r.embedderId, status: r.embedderStatus, vectors: r.vecs.size };
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
  async explain(payload) { return explain(payload); },
  async 'open-options'() { await chrome.runtime.openOptionsPage(); return true; }
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return;
  const h = handlers[msg.type];
  if (!h) return;
  h(msg).then(r => sendResponse({ ok: true, data: r }), e => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

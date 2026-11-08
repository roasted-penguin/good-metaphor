// 저장소 계층
//  - 공통 저장소: 로그인 없이 누구나 읽는 그래프. 관심사(메이플·식당, T-302)마다 번들 파일 하나.
//    기본 관심사(메이플)만 관리자가 지정한 URL로 바꿀 수 있다.
//  - 사용자 저장소: 로그인한 사용자만. 공통 그래프 위에 얹는 오버레이(추가 노드, 숨김, 관심사 변경).
import { getAdminConfig } from './config.js';
import { EMPTY_OVERLAY, validateGraph, validateTagsFile, resolveCommonGraph, commonInterest, DEFAULT_INTEREST } from './graph.js';

/* ───────────── 공통 저장소 ───────────── */

// 관심사 id → 해석된 그래프. 관심사를 바꿔도 다른 관심사 그래프가 섞이지 않게 따로 둔다
const commonCache = new Map();

// 공통 그래프와 같은 폴더의 태그 파일(T-304). base는 그래프 파일 주소
const TAGS_FILENAME = 'tags.json';
async function fetchJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

// 관심사 그래프 + 같은 폴더의 tags.json → 해석된 그래프. 그래프에 tags가 이미 있으면(하위 호환) 태그 파일을 받지 않는다
async function fetchResolved(graphUrl, init) {
  const graph = await fetchJson(graphUrl, init);
  if (Array.isArray(graph?.tags)) return resolveCommonGraph(graph, null);
  const tagsFile = await fetchJson(new URL(TAGS_FILENAME, graphUrl).href, init);
  const errors = validateTagsFile(tagsFile);
  if (errors.length) throw new Error('태그 파일 오류: ' + errors.join(' / '));
  return resolveCommonGraph(graph, tagsFile);
}

// loadCommonGraph(interestId = 'maplestory', { fresh }). 예전 호출 모양 loadCommonGraph({ fresh })도 기본 관심사로 받는다.
// 모르는 id(오래된 설정 값 등)는 기본 관심사로 바꾼다
export async function loadCommonGraph(interestId = DEFAULT_INTEREST, opts = {}) {
  let fresh = !!opts.fresh;
  if (interestId && typeof interestId === 'object') {
    fresh = !!interestId.fresh;
    interestId = DEFAULT_INTEREST;
  }
  let interest = commonInterest(interestId);
  if (!interest) {
    console.warn(`[common-store] 알 수 없는 관심사 "${interestId}"라서 기본 관심사를 써요.`);
    interest = commonInterest(DEFAULT_INTEREST);
  }
  const id = interest.id;
  if (commonCache.has(id) && !fresh) return commonCache.get(id);
  let graph = null;
  if (id === DEFAULT_INTEREST) {
    const admin = await getAdminConfig();
    const { url, bundled } = admin.commonStore || {};
    if (url) {
      try {
        graph = await fetchResolved(url, { cache: 'no-cache' });
      } catch (e) {
        console.warn('[common-store] 원격 공통 저장소를 못 읽어서 번들 파일을 씁니다.', e);
      }
    }
    if (!graph) graph = await fetchResolved(chrome.runtime.getURL(bundled || 'data/common/' + interest.file));
  } else {
    graph = await fetchResolved(chrome.runtime.getURL('data/common/' + interest.file));
  }
  const errors = validateGraph(graph);
  if (errors.length) throw new Error('공통 저장소 그래프 오류: ' + errors.join(' / '));
  commonCache.set(id, graph);
  return graph;
}

/* ───────────── 금칙어 목록(T-114, 규칙 11) ───────────── */
// 번들 파일만 읽는다(원격 목록 없음). 승인된 카드만 거르는 일은 runAnalogy(blocklist.js)가 한다.
// 못 읽으면 빈 목록(프롬프트 규칙은 남는다). 다음 호출 때 다시 읽는다
let blocklistCache = null;

export async function loadBlocklist() {
  if (blocklistCache) return blocklistCache;
  try {
    const res = await fetch(chrome.runtime.getURL('data/common/blocklist.json'));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    blocklistCache = Array.isArray(data?.terms) ? data.terms : [];
    return blocklistCache;
  } catch (e) {
    console.error('[blocklist] 금칙어 목록을 못 읽었어요', e);
    return [];
  }
}

/* ───────────── 사용자 저장소 어댑터 ───────────── */
// 모든 어댑터는 같은 모양: getSession, login, logout, loadOverlay, saveOverlay

const noneAdapter = {
  id: 'none',
  label: '사용 안 함',
  async getSession() { return null; },
  async login() { throw new Error('이 배포에서는 로그인이 꺼져 있어요.'); },
  async logout() {},
  async loadOverlay() { return null; },
  async saveOverlay() { throw new Error('로그인이 필요해요.'); }
};

// 서버 없이 병합 로직을 시험하기 위한 개발용 어댑터. 이 브라우저에만 저장된다.
const localDevAdapter = {
  id: 'local-dev',
  label: '개발용 로컬 사용자 (서버 없음)',
  async getSession() {
    const { devSession } = await chrome.storage.local.get('devSession');
    return devSession || null;
  },
  async login({ nickname } = {}) {
    const name = (nickname || '').trim() || '테스트사용자';
    const session = { userId: 'dev:' + name, name, adapter: 'local-dev' };
    await chrome.storage.local.set({ devSession: session });
    return session;
  },
  async logout() { await chrome.storage.local.remove('devSession'); },
  async loadOverlay(session) {
    const key = 'devOverlay:' + session.userId;
    const got = await chrome.storage.local.get(key);
    return got[key] || null;
  },
  async saveOverlay(session, overlay) {
    await chrome.storage.local.set({ ['devOverlay:' + session.userId]: overlay });
  }
};

// 실제 서버용 어댑터. 서버 계약은 기획서의 "사용자 저장소 API" 참고.
//   GET  {baseUrl}/auth/start?redirect_uri=...  → 로그인 후 redirect_uri#token=...&name=...
//   GET  {baseUrl}/v1/overlay   (Bearer)        → 오버레이 JSON, 없으면 404
//   PUT  {baseUrl}/v1/overlay   (Bearer)        → 저장
function remoteAdapter(baseUrl) {
  const base = (baseUrl || '').replace(/\/$/, '');
  async function authed(path, init = {}) {
    const { remoteSession } = await chrome.storage.local.get('remoteSession');
    if (!remoteSession) throw new Error('로그인이 필요해요.');
    const res = await fetch(base + path, {
      ...init,
      headers: { ...(init.headers || {}), authorization: `Bearer ${remoteSession.token}`, 'content-type': 'application/json' }
    });
    if (res.status === 401) {
      await chrome.storage.local.remove('remoteSession');
      throw new Error('로그인이 만료됐어요. 다시 로그인해 주세요.');
    }
    return res;
  }
  return {
    id: 'remote',
    label: '서버 계정',
    async getSession() {
      const { remoteSession } = await chrome.storage.local.get('remoteSession');
      return remoteSession ? { userId: remoteSession.userId, name: remoteSession.name, adapter: 'remote' } : null;
    },
    async login() {
      if (!base) throw new Error('관리자 설정에 userStore.baseUrl 이 없어요.');
      const redirect = chrome.identity.getRedirectURL('auth');
      const url = `${base}/auth/start?redirect_uri=${encodeURIComponent(redirect)}`;
      const back = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
      const params = new URLSearchParams(new URL(back).hash.slice(1));
      const token = params.get('token');
      if (!token) throw new Error('로그인 응답에 토큰이 없어요.');
      const session = { token, userId: params.get('user_id') || '', name: params.get('name') || '사용자' };
      await chrome.storage.local.set({ remoteSession: session });
      return { userId: session.userId, name: session.name, adapter: 'remote' };
    },
    async logout() { await chrome.storage.local.remove('remoteSession'); },
    async loadOverlay() {
      const res = await authed('/v1/overlay');
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`오버레이를 못 읽었어요 (${res.status})`);
      return res.json();
    },
    async saveOverlay(_session, overlay) {
      const res = await authed('/v1/overlay', { method: 'PUT', body: JSON.stringify(overlay) });
      if (!res.ok) throw new Error(`오버레이 저장 실패 (${res.status})`);
    }
  };
}

export async function getUserStore() {
  const admin = await getAdminConfig();
  const { adapter, baseUrl } = admin.userStore || {};
  if (adapter === 'remote') return remoteAdapter(baseUrl);
  if (adapter === 'local-dev') return localDevAdapter;
  return noneAdapter;
}

export function validateOverlay(ov) {
  if (!ov || typeof ov !== 'object') return ['오버레이가 객체가 아니에요.'];
  const errors = validateGraph({ domain: ov.domain || 'x', tags: ov.tags || [], nodes: ov.nodes || [] }, { partial: true });
  if (ov.useCommon === false && !ov.domain) errors.push('공통 그래프를 끄려면 domain(내 관심사 이름)이 필요해요.');
  for (const n of ov.nodes || []) {
    if (n.id && !String(n.id).startsWith('u:')) errors.push(`내 노드 id는 "u:"로 시작해야 해요: ${n.id}`);
    // 검수 대기 표시(T-301): draft는 boolean, 초안이면 factsReviewed가 facts와 같은 길이의 boolean 배열
    if (n.draft !== undefined && typeof n.draft !== 'boolean') errors.push(`노드 ${n.id}의 draft는 true 또는 false여야 해요.`);
    else if (n.factsReviewed !== undefined || n.draft === true) {
      const rv = n.factsReviewed;
      if (!Array.isArray(rv) || !rv.every(v => typeof v === 'boolean') || rv.length !== (Array.isArray(n.facts) ? n.facts.length : -1)) {
        errors.push(`노드 ${n.id}의 factsReviewed는 사실 수만큼의 true/false 배열이어야 해요.`);
      }
    }
  }
  return errors;
}

export function normalizeOverlay(ov) {
  return { ...EMPTY_OVERLAY, ...(ov || {}) };
}

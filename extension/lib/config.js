// 설정 우선순위: config/admin.json  <  chrome.storage.managed(조직 정책)  <  사용자 설정(잠금이 아닐 때만)
import { PROVIDERS } from './providers.js';

let adminCache = null;

function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over ?? base;
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(over)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base?.[k], v) : v;
  }
  return out;
}

export async function getAdminConfig({ fresh = false } = {}) {
  if (adminCache && !fresh) return adminCache;
  const res = await fetch(chrome.runtime.getURL('config/admin.json'));
  let admin = await res.json();
  delete admin._comment;
  try {
    const managed = await chrome.storage.managed.get(null);
    if (managed && Object.keys(managed).length) {
      admin = deepMerge(admin, managed);
      admin._managedKeys = Object.keys(managed);
    }
  } catch { /* 정책 저장소가 없는 환경 */ }
  adminCache = admin;
  return admin;
}

export const DEFAULT_SETTINGS = {
  enabled: true,
  triggerMode: 'modifier',     // 'modifier' = 보조키 누른 채 올리기, 'auto' = 머무르면 자동
  modifierKey: 'Alt',          // 'Alt' | 'Shift' | 'Control' | 'Meta'
  dwellMs: 900,
  preciseMode: false,          // true면 LLM이 먼저 추상 개념을 뽑은 뒤 검색 (호출 2회)
  provider: null,              // null이면 관리자 기본값
  models: {},                  // 제공자별 사용자가 고른 모델
  apiKeys: {},                 // 제공자별 사용자 키 (이 브라우저에만 저장)
  customBaseUrl: ''
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

// 실제로 호출에 쓸 제공자·모델·키를 결정
export async function resolveProvider() {
  const admin = await getAdminConfig();
  const s = await getSettings();
  const allowed = (admin.allowedProviders || Object.keys(PROVIDERS)).filter(id => PROVIDERS[id]);
  let id = admin.lockProvider ? admin.defaultProvider : (s.provider || admin.defaultProvider);
  if (!allowed.includes(id)) id = allowed[0];
  const def = PROVIDERS[id];
  const model = (!admin.lockProvider && s.models?.[id]) || admin.defaultModels?.[id] || def.defaultModel;
  const apiKey = s.apiKeys?.[id] || admin.sharedApiKeys?.[id] || '';
  const baseUrl = id === 'custom' ? (s.customBaseUrl || admin.customBaseUrl || '') : def.baseUrl;
  return { id, def, model, apiKey, baseUrl, locked: !!admin.lockProvider, allowed };
}

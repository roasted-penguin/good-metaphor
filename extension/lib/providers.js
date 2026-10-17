// LLM 제공자 레지스트리. 새 제공자는 여기에 항목 하나와 kind별 호출 함수만 추가하면 된다.
// 모델 ID는 2026-09 기준 각 사 문서에서 확인한 값. 바뀌면 config/admin.json 의 defaultModels 로 덮어쓴다.

export const PROVIDERS = {
  gemini: {
    label: 'Google Gemini (무료 티어)',
    kind: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    models: ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'],
    defaultModel: 'gemini-3.8-flash',
    keyUrl: 'https://aistudio.google.com/apikey',
    free: true
  },
  groq: {
    label: 'Groq (무료 티어, 오픈 모델)',
    kind: 'openai-compat',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b'],
    defaultModel: 'openai/gpt-oss-120b',
    keyUrl: 'https://console.groq.com/keys',
    extraBody: { reasoning_effort: 'low' },
    free: true
  },
  openai: {
    label: 'OpenAI',
    kind: 'openai-compat',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-6-luna', 'gpt-6-sol'],
    defaultModel: 'gpt-6-luna',
    keyUrl: 'https://platform.openai.com/api-keys'
  },
  anthropic: {
    label: 'Anthropic Claude',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-haiku-4-5-20251001', 'claude-sonnet-5'],
    defaultModel: 'claude-haiku-4-5-20251001',
    keyUrl: 'https://console.anthropic.com/settings/keys'
  },
  custom: {
    label: 'OpenAI 호환 주소 (OpenRouter, Ollama 등)',
    kind: 'openai-compat',
    baseUrl: '',
    models: [],
    defaultModel: '',
    keyOptional: true
  },
  demo: {
    label: '데모 (키 없이 · LLM 호출 안 함)',
    kind: 'demo',
    models: ['template'],
    defaultModel: 'template',
    keyOptional: true
  }
};

class ProviderError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// 일시 오류 재시도 정책. 테스트에서 delays 를 0으로 바꿔 쓴다.
export const retryPolicy = { delays: [500, 1500], jitter: 0.2, maxRetryAfterMs: 3000 };
const RETRYABLE = new Set([429, 503]);

async function postOnce(url, headers, body, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try { const j = JSON.parse(text); msg = j.error?.message || j.message || msg; } catch {}
      const err = new ProviderError(`${res.status} ${msg}`, res.status);
      const ra = Number(res.headers?.get?.('retry-after'));
      if (ra > 0) err.retryAfterMs = ra * 1000;
      throw err;
    }
    return JSON.parse(text);
  } catch (e) {
    if (e.name === 'AbortError') throw new ProviderError('응답 시간이 초과됐어요.', 0);
    // fetch 자체가 실패(네트워크 끊김 등)하면 status 없이 TypeError 가 온다
    if (e instanceof TypeError) { const err = new ProviderError(`네트워크 오류: ${e.message}`, 0); err.network = true; throw err; }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// 503·429·네트워크 오류만 재시도한다. 키 오류(400·401·403)는 바로 던진다. 전체 시간은 timeoutMs 안에서.
async function postJSON(url, headers, body, { timeoutMs = 30000, stats } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; ; attempt++) {
    try {
      return await postOnce(url, headers, body, Math.max(1, deadline - Date.now()));
    } catch (e) {
      const retryable = e.network || RETRYABLE.has(e.status);
      if (!retryable || attempt >= retryPolicy.delays.length) throw e;
      const base = retryPolicy.delays[attempt];
      let wait = base + base * retryPolicy.jitter * Math.random();
      if (e.retryAfterMs) wait = Math.min(e.retryAfterMs, retryPolicy.maxRetryAfterMs);
      if (Date.now() + wait >= deadline) throw e;
      if (stats) stats.retries = (stats.retries || 0) + 1;
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

async function callGemini({ baseUrl, model, apiKey }, system, user, { json, stats }) {
  const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      ...(json ? { responseMimeType: 'application/json' } : {}),
      thinkingConfig: { thinkingLevel: 'low' }
    }
  };
  let data;
  try {
    data = await postJSON(url, { 'x-goog-api-key': apiKey }, body, { stats });
  } catch (e) {
    // 모델에 따라 thinkingConfig 를 받지 않으면 빼고 다시 시도 (키 오류 같은 다른 400은 그대로 던진다)
    if (e.status !== 400 || !/think/i.test(e.message)) throw e;
    delete body.generationConfig.thinkingConfig;
    data = await postJSON(url, { 'x-goog-api-key': apiKey }, body, { stats });
  }
  const parts = data.candidates?.[0]?.content?.parts || [];
  return parts.filter(p => !p.thought).map(p => p.text || '').join('');
}

async function callOpenAICompat({ baseUrl, model, apiKey, def }, system, user, { stats } = {}) {
  if (!baseUrl) throw new ProviderError('OpenAI 호환 주소가 비어 있어요. 설정에서 입력해 주세요.', 0);
  const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const data = await postJSON(`${baseUrl.replace(/\/$/, '')}/chat/completions`, headers, {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    ...(def.extraBody || {})
  }, { stats });
  return data.choices?.[0]?.message?.content || '';
}

async function callAnthropic({ baseUrl, model, apiKey }, system, user, { stats } = {}) {
  const data = await postJSON(`${baseUrl}/messages`, {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true'
  }, {
    model,
    max_tokens: 700,
    system,
    messages: [{ role: 'user', content: user }]
  }, { stats });
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

// provider = resolveProvider() 결과. opts.stats 객체를 넘기면 재시도 횟수(retries)를 채운다
export async function complete(provider, system, user, opts = {}) {
  const { def, apiKey } = provider;
  if (!apiKey && !def.keyOptional) {
    throw new ProviderError(`${def.label} API 키가 없어요. 설정에서 키를 넣어 주세요.`, 401);
  }
  if (!provider.model) throw new ProviderError('모델 이름이 비어 있어요. 설정에서 모델을 넣어 주세요.', 0);
  switch (def.kind) {
    case 'gemini': return callGemini(provider, system, user, opts);
    case 'openai-compat': return callOpenAICompat(provider, system, user, opts);
    case 'anthropic': return callAnthropic(provider, system, user, opts);
    default: throw new ProviderError(`알 수 없는 제공자 종류: ${def.kind}`, 0);
  }
}

// 모델이 코드블록이나 앞뒤 설명을 붙여도 JSON만 뽑아낸다
export function parseJSONLoose(text) {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch {}
  }
  return null;
}

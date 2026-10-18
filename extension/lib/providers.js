// LLM 제공자 레지스트리. 새 제공자는 여기에 항목 하나와 kind별 호출 함수만 추가하면 된다.
// stream: true 면 onText 를 받은 호출을 SSE 스트리밍으로 보낸다(T-117). 지원 안 하는 주소는 false 로.
// 모델 ID는 2026-09 기준 각 사 문서에서 확인한 값. 바뀌면 config/admin.json 의 defaultModels 로 덮어쓴다.

export const PROVIDERS = {
  gemini: {
    label: 'Google Gemini (무료 티어)',
    kind: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    models: ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.1-flash-lite'],
    defaultModel: 'gemini-3.5-flash-lite',
    keyUrl: 'https://aistudio.google.com/apikey',
    stream: true,
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
    stream: true,
    free: true
  },
  nvidia: {
    label: 'NVIDIA Build (무료, 개발용)',
    kind: 'openai-compat',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    // 2026-10-18 실제 키로 확인: /v1/models 에 있음. deepseek-v4.1-flash·nemotron-3.5-lightning 은 20초 넘게 응답 없음이라 뺐다.
    // 무료는 키당 분당 약 40회(모든 모델 공유), 개발·시험용 약관
    models: ['nvidia/nemotron-3.5-super-vl-120b-a12b', 'nvidia/nemotron-3-super-120b-a12b'],
    defaultModel: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
    // Nemotron 은 기본으로 생각부터 해서 첫 글자까지 14~30초. 끄면 0.2~0.4초(2026-10-18 측정)
    extraBody: { chat_template_kwargs: { enable_thinking: false } },
    keyUrl: 'https://build.nvidia.com/settings/api-keys',
    stream: true,
    free: true
  },
  openai: {
    label: 'OpenAI',
    kind: 'openai-compat',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-6-luna', 'gpt-6-sol'],
    defaultModel: 'gpt-6-luna',
    keyUrl: 'https://platform.openai.com/api-keys',
    stream: true
  },
  anthropic: {
    label: 'Anthropic Claude',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-haiku-4-5-20251001', 'claude-sonnet-5'],
    defaultModel: 'claude-haiku-4-5-20251001',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    stream: true
  },
  custom: {
    label: 'OpenAI 호환 주소 (OpenRouter, Ollama 등)',
    kind: 'openai-compat',
    baseUrl: '',
    models: [],
    defaultModel: '',
    stream: true,
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

// SSE 본문을 줄 단위로 읽어 data 줄의 JSON 을 onData 로 넘긴다
async function readSSE(body, onData) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const flush = line => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    try { onData(JSON.parse(payload)); } catch {}
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    lines.forEach(flush);
  }
  flush(buf + dec.decode());
}

async function postOnce(url, headers, body, timeoutMs, onData) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let started = false;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    if (!res.ok) {
      const text = await res.text();
      let msg = text.slice(0, 300);
      try { const j = JSON.parse(text); msg = j.error?.message || j.message || msg; } catch {}
      const err = new ProviderError(`${res.status} ${msg}`, res.status);
      const ra = Number(res.headers?.get?.('retry-after'));
      if (ra > 0) err.retryAfterMs = ra * 1000;
      throw err;
    }
    if (onData) { started = true; await readSSE(res.body, onData); return null; }
    return JSON.parse(await res.text());
  } catch (e) {
    if (e.name === 'AbortError') throw new ProviderError('응답 시간이 초과됐어요.', 0);
    // 받기 시작한 뒤 끊기면 재시도하지 않는다(앞부분을 이미 화면에 보냈을 수 있음)
    if (started && !(e instanceof ProviderError)) throw new ProviderError(`응답이 중간에 끊겼어요: ${e.message}`, 0);
    // fetch 자체가 실패(네트워크 끊김 등)하면 status 없이 TypeError 가 온다
    if (e instanceof TypeError) { const err = new ProviderError(`네트워크 오류: ${e.message}`, 0); err.network = true; throw err; }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// 503·429·네트워크 오류만 재시도한다. 키 오류(400·401·403)는 바로 던진다. 전체 시간은 timeoutMs 안에서.
async function postJSON(url, headers, body, { timeoutMs = 30000, stats, onData, noRetry429 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; ; attempt++) {
    try {
      return await postOnce(url, headers, body, Math.max(1, deadline - Date.now()), onData);
    } catch (e) {
      // 다음 순서 모델이 있으면(fallback 체인) 429는 기다리지 않고 바로 넘긴다
      const retryable = e.network || (RETRYABLE.has(e.status) && !(noRetry429 && e.status === 429));
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

const geminiText = d => (d.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');

// 종류별 차이는 여기에만: 요청 만들기(build), 한 번에 받은 응답에서 텍스트(text), 스트림 조각에서 텍스트(chunk)
const KINDS = {
  gemini: {
    build({ baseUrl, model, apiKey }, system, user, { json }, stream) {
      return {
        url: `${baseUrl}/models/${encodeURIComponent(model)}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`,
        headers: { 'x-goog-api-key': apiKey },
        body: {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: {
            ...(json ? { responseMimeType: 'application/json' } : {}),
            thinkingConfig: { thinkingLevel: 'low' }
          }
        }
      };
    },
    text: geminiText,
    chunk: geminiText,
    // 모델에 따라 thinkingConfig 를 받지 않으면 빼고 다시 시도 (키 오류 같은 다른 400은 그대로 던진다)
    fallback(e, req) {
      if (e.status !== 400 || !/think/i.test(e.message) || !req.body.generationConfig.thinkingConfig) return false;
      delete req.body.generationConfig.thinkingConfig;
      return true;
    }
  },
  'openai-compat': {
    build({ baseUrl, model, apiKey, def }, system, user, _opts, stream) {
      if (!baseUrl) throw new ProviderError('OpenAI 호환 주소가 비어 있어요. 설정에서 입력해 주세요.', 0);
      return {
        url: `${baseUrl.replace(/\/$/, '')}/chat/completions`,
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        body: {
          model,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          ...(def.extraBody || {}),
          ...(stream ? { stream: true } : {})
        }
      };
    },
    text: d => d.choices?.[0]?.message?.content || '',
    chunk: d => d.choices?.[0]?.delta?.content || ''
  },
  anthropic: {
    build({ baseUrl, model, apiKey }, system, user, _opts, stream) {
      return {
        url: `${baseUrl}/messages`,
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: { model, max_tokens: 700, system, messages: [{ role: 'user', content: user }], ...(stream ? { stream: true } : {}) }
      };
    },
    text: d => (d.content || []).filter(b => b.type === 'text').map(b => b.text).join(''),
    chunk: d => (d.type === 'content_block_delta' ? d.delta?.text || '' : '')
  }
};

async function send(kind, req, opts, stream) {
  if (!stream) return kind.text(await postJSON(req.url, req.headers, req.body, { stats: opts.stats, noRetry429: opts.noRetry429 }));
  let acc = '';
  await postJSON(req.url, req.headers, req.body, {
    stats: opts.stats,
    noRetry429: opts.noRetry429,
    onData: d => { const piece = kind.chunk(d); if (piece) { acc += piece; opts.onText(acc); } }
  });
  return acc;
}

// provider = resolveProvider() 결과. opts.stats 객체를 넘기면 재시도 횟수(retries)를 채운다.
// opts.noRetry429 면 429를 재시도하지 않고 바로 던진다(fallback 체인용).
// opts.onText(지금까지 받은 전체 텍스트) 를 넘기면, 항목이 stream 이면 조각마다, 아니면 끝에 한 번 부른다
export async function complete(provider, system, user, opts = {}) {
  const { def, apiKey } = provider;
  if (!apiKey && !def.keyOptional) {
    throw new ProviderError(`${def.label} API 키가 없어요. 설정에서 키를 넣어 주세요.`, 401);
  }
  if (!provider.model) throw new ProviderError('모델 이름이 비어 있어요. 설정에서 모델을 넣어 주세요.', 0);
  const kind = KINDS[def.kind];
  if (!kind) throw new ProviderError(`알 수 없는 제공자 종류: ${def.kind}`, 0);
  const stream = !!(opts.onText && def.stream);
  const req = kind.build(provider, system, user, opts, stream);
  let text;
  try {
    text = await send(kind, req, opts, stream);
  } catch (e) {
    if (!kind.fallback?.(e, req)) throw e;
    text = await send(kind, req, opts, stream);
  }
  if (opts.onText && !stream) opts.onText(text);
  return text;
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

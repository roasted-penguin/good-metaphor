import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, complete, retryPolicy } from '../../extension/lib/providers.js';

const gemini = { id: 'gemini', def: PROVIDERS.gemini, model: 'm', apiKey: 'k', baseUrl: PROVIDERS.gemini.baseUrl };
const ok = { candidates: [{ content: { parts: [{ text: 'thought', thought: true }, { text: '답' }] } }] };

// fetch 를 순서대로 응답하는 가짜로 바꾸고 받은 본문을 모은다
function mockFetch(t, responses) {
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    const next = responses.shift();
    if (next instanceof Error) throw next;
    const [status, json, hdrs = {}] = next;
    return { ok: status < 400, status, headers: new Headers(hdrs), text: async () => JSON.stringify(json) };
  });
  return bodies;
}

test('Gemini: thinkingConfig 400이면 빼고 한 번 더 시도', async t => {
  const bodies = mockFetch(t, [[400, { error: { message: 'Unknown name "thinkingLevel"' } }], [200, ok]]);
  assert.equal(await complete(gemini, 's', 'u'), '답');
  assert.equal(bodies.length, 2);
  assert.ok(bodies[0].generationConfig.thinkingConfig);
  assert.equal(bodies[1].generationConfig.thinkingConfig, undefined);
});

test('Gemini: 키 오류 400은 재시도하지 않는다', async t => {
  const bodies = mockFetch(t, [[400, { error: { message: 'API key not valid.' } }]]);
  await assert.rejects(complete(gemini, 's', 'u'), /API key not valid/);
  assert.equal(bodies.length, 1);
});

// 재시도 대기 시간을 0으로 두고 시험한다
const groq = { id: 'groq', def: PROVIDERS.groq, model: 'm', apiKey: 'k', baseUrl: PROVIDERS.groq.baseUrl };
const chat = text => ({ choices: [{ message: { content: text } }] });
function fastRetry(t) {
  const saved = { ...retryPolicy };
  Object.assign(retryPolicy, { delays: [0, 0], maxRetryAfterMs: 0 });
  t.after(() => Object.assign(retryPolicy, saved));
}

test('재시도: 503 다음 성공이면 결과를 돌려주고 횟수를 남긴다', async t => {
  fastRetry(t);
  const bodies = mockFetch(t, [[503, { error: { message: 'high demand' } }], [200, chat('답')]]);
  const stats = {};
  assert.equal(await complete(groq, 's', 'u', { stats }), '답');
  assert.equal(bodies.length, 2);
  assert.equal(stats.retries, 1);
});

test('재시도: 429 Retry-After 를 따르되 상한 안에서', async t => {
  fastRetry(t);
  retryPolicy.maxRetryAfterMs = 30;
  const bodies = mockFetch(t, [[429, { error: { message: 'rate' } }, { 'retry-after': '5' }], [200, chat('답')]]);
  const t0 = Date.now();
  assert.equal(await complete(groq, 's', 'u'), '답');
  const waited = Date.now() - t0;
  assert.ok(waited >= 25 && waited < 1000, `대기 ${waited}ms`);
  assert.equal(bodies.length, 2);
});

test('재시도: 네트워크 오류도 재시도한다', async t => {
  fastRetry(t);
  const bodies = mockFetch(t, [new TypeError('fetch failed'), [200, chat('답')]]);
  assert.equal(await complete(groq, 's', 'u'), '답');
  assert.equal(bodies.length, 2);
});

test('재시도: 401 키 오류는 한 번만 호출한다', async t => {
  fastRetry(t);
  const bodies = mockFetch(t, [[401, { error: { message: 'Invalid API Key' } }]]);
  await assert.rejects(complete(groq, 's', 'u'), /401 Invalid API Key/);
  assert.equal(bodies.length, 1);
});

test('재시도: 다 써도 실패하면 마지막 오류를 그대로 던진다', async t => {
  fastRetry(t);
  const bodies = mockFetch(t, [[503, { error: { message: 'a' } }], [503, { error: { message: 'b' } }], [503, { error: { message: 'high demand' } }]]);
  const stats = {};
  await assert.rejects(complete(groq, 's', 'u', { stats }), /503 high demand/);
  assert.equal(bodies.length, 3);
  assert.equal(stats.retries, 2);
});

/* ───── 스트리밍 (T-117) ───── */

// SSE 응답을 흉내 낸다. events = data 줄에 들어갈 문자열 목록. 조각 경계를 일부러 줄 중간에 둔다
function sse(events) {
  const raw = events.map(e => `data: ${e}\n\n`).join('');
  const enc = new TextEncoder();
  const pieces = [];
  for (let i = 0; i < raw.length; i += 7) pieces.push(enc.encode(raw.slice(i, i + 7)));
  return new ReadableStream({ start(c) { pieces.forEach(p => c.enqueue(p)); c.close(); } });
}

// 순서대로 응답하는 가짜 fetch. [status, json] 또는 { sse: [...] }
function mockStreamFetch(t, responses) {
  const reqs = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    reqs.push({ url, body: JSON.parse(init.body) });
    const next = responses.shift();
    if (next.sse) return { ok: true, status: 200, headers: new Headers(), body: sse(next.sse), text: async () => '' };
    const [status, json] = next;
    return { ok: status < 400, status, headers: new Headers(), text: async () => JSON.stringify(json) };
  });
  return reqs;
}

const delta = text => JSON.stringify({ choices: [{ delta: { content: text } }] });

test('스트리밍: openai-compat 은 stream:true 로 보내고 조각마다 누적 텍스트를 넘긴다', async t => {
  const reqs = mockStreamFetch(t, [{ sse: [delta('{"meaning": "뜻'), delta('이에요."'), delta(', "analogy": ""}'), '[DONE]'] }]);
  const seen = [];
  const text = await complete(groq, 's', 'u', { onText: s => seen.push(s) });
  assert.equal(reqs[0].body.stream, true);
  assert.deepEqual(seen, ['{"meaning": "뜻', '{"meaning": "뜻이에요."', '{"meaning": "뜻이에요.", "analogy": ""}']);
  assert.equal(text, '{"meaning": "뜻이에요.", "analogy": ""}');
});

test('스트리밍: gemini 는 streamGenerateContent?alt=sse, thought 조각은 뺀다', async t => {
  const part = (text, thought) => JSON.stringify({ candidates: [{ content: { parts: [{ text, ...(thought ? { thought: true } : {}) }] } }] });
  const reqs = mockStreamFetch(t, [{ sse: [part('생각 중', true), part('{"meaning"'), part(': "뜻"}')] }]);
  const seen = [];
  const text = await complete(gemini, 's', 'u', { json: true, onText: s => seen.push(s) });
  assert.match(reqs[0].url, /\/models\/m:streamGenerateContent\?alt=sse$/);
  assert.deepEqual(seen, ['{"meaning"', '{"meaning": "뜻"}']);
  assert.equal(text, '{"meaning": "뜻"}');
});

test('스트리밍: anthropic 은 content_block_delta 의 text 만 이어 붙인다', async t => {
  const anthropic = { id: 'anthropic', def: PROVIDERS.anthropic, model: 'm', apiKey: 'k', baseUrl: PROVIDERS.anthropic.baseUrl };
  const ev = o => JSON.stringify(o);
  const reqs = mockStreamFetch(t, [{ sse: [
    ev({ type: 'message_start', message: {} }),
    ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: '{"meaning": ' } }),
    ev({ type: 'ping' }),
    ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: '"뜻"}' } }),
    ev({ type: 'message_stop' })
  ] }]);
  const seen = [];
  assert.equal(await complete(anthropic, 's', 'u', { onText: s => seen.push(s) }), '{"meaning": "뜻"}');
  assert.equal(reqs[0].body.stream, true);
  assert.deepEqual(seen, ['{"meaning": ', '{"meaning": "뜻"}']);
});

test('스트리밍: 항목에서 stream:false 면 한 번에 받고 onText 는 전체로 한 번', async t => {
  const noStream = { ...groq, def: { ...PROVIDERS.groq, stream: false } };
  const reqs = mockStreamFetch(t, [[200, chat('답')]]);
  const seen = [];
  assert.equal(await complete(noStream, 's', 'u', { onText: s => seen.push(s) }), '답');
  assert.equal(reqs[0].body.stream, undefined);
  assert.deepEqual(seen, ['답']);
});

test('스트리밍: 응답 시작 전 503 은 재시도한다', async t => {
  fastRetry(t);
  const reqs = mockStreamFetch(t, [[503, { error: { message: 'high demand' } }], { sse: [delta('답'), '[DONE]'] }]);
  const stats = {};
  assert.equal(await complete(groq, 's', 'u', { stats, onText: () => {} }), '답');
  assert.equal(reqs.length, 2);
  assert.equal(stats.retries, 1);
});

test('NVIDIA: 생각(thinking)을 끄는 chat_template_kwargs 를 보낸다 (켜면 첫 글자까지 14~30초)', async t => {
  const nvidia = { id: 'nvidia', def: PROVIDERS.nvidia, model: 'nvidia/nemotron-3.5-super-vl-120b-a12b', apiKey: 'k', baseUrl: PROVIDERS.nvidia.baseUrl };
  const bodies = mockFetch(t, [[200, chat('답')]]);
  assert.equal(await complete(nvidia, 's', 'u'), '답');
  assert.deepEqual(bodies[0].chat_template_kwargs, { enable_thinking: false });
});

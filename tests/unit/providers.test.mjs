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

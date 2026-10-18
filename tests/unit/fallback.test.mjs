import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChain, completeWithFallback } from '../../extension/lib/fallback.js';
import { providerFor } from '../../extension/lib/config.js';
import { retryPolicy } from '../../extension/lib/providers.js';

const admin = {
  allowedProviders: ['gemini', 'groq', 'openai', 'custom', 'demo'],
  defaultModels: {},
  fallbackChain: [{ provider: 'groq', model: 'openai/gpt-oss-120b' }, { provider: 'gemini', model: 'gemini-3.8-flash' }],
  cooldown: { defaultMs: 60_000, maxMs: 600_000 }
};
const settings = { apiKeys: { groq: 'g', gemini: 'm' }, models: {} };
const label = p => `${p.id}/${p.model}`;

// 메모리 쿨다운 저장소
function memCooldowns(init = {}) {
  let data = { ...init };
  return { get: async () => ({ ...data }), set: async d => { data = { ...d }; }, peek: () => data };
}

// URL·모델별로 응답을 정하는 가짜 fetch. route(model, url) → [status, json, headers?]
function mockFetch(t, route) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(init.body);
    const model = body.model || decodeURIComponent(url.match(/models\/([^:]+):/)?.[1] || '');
    calls.push(model);
    const [status, json, hdrs = {}] = route(model, url);
    return { ok: status < 400, status, headers: new Headers(hdrs), text: async () => JSON.stringify(json) };
  });
  return calls;
}
const chat = text => ({ choices: [{ message: { content: text } }] });
const gem = text => ({ candidates: [{ content: { parts: [{ text }] } }] });
const ok = (model, url) => [200, url.includes('googleapis') ? gem(`${model} 답`) : chat(`${model} 답`)];
function fastRetry(t) {
  const saved = { ...retryPolicy };
  Object.assign(retryPolicy, { delays: [0, 0], maxRetryAfterMs: 0 });
  t.after(() => Object.assign(retryPolicy, saved));
}

test('체인: 사용자가 고른 것 먼저, 그다음 관리자 체인 순서, 중복은 한 번', () => {
  const primary = providerFor('groq', 'openai/gpt-oss-120b', admin, settings);
  assert.deepEqual(buildChain(primary, admin, settings).map(label), ['groq/openai/gpt-oss-120b', 'gemini/gemini-3.8-flash']);
  const other = providerFor('openai', 'gpt-6-luna', admin, { ...settings, apiKeys: { ...settings.apiKeys, openai: 'o' } });
  assert.deepEqual(buildChain(other, admin, settings).map(label), ['openai/gpt-6-luna', 'groq/openai/gpt-oss-120b', 'gemini/gemini-3.8-flash']);
});

test('체인: 키 없는 뒤 순서와 허용 안 된 제공자는 빼고, 데모는 체인을 타지 않는다', () => {
  const primary = providerFor('groq', 'openai/gpt-oss-120b', admin, settings);
  assert.deepEqual(buildChain(primary, admin, { apiKeys: { groq: 'g' } }).map(label), ['groq/openai/gpt-oss-120b']);
  assert.deepEqual(buildChain(primary, { ...admin, allowedProviders: ['groq'] }, settings).map(label), ['groq/openai/gpt-oss-120b']);
  const demo = providerFor('demo', 'template', admin, settings);
  assert.deepEqual(buildChain(demo, admin, settings).map(label), ['demo/template']);
});

test('429: 같은 모델을 재시도하지 않고 다음 순서로, Retry-After 만큼 쿨다운', async t => {
  fastRetry(t);
  const calls = mockFetch(t, (model, url) => model === 'openai/gpt-oss-120b' ? [429, { error: { message: 'rate' } }, { 'retry-after': '30' }] : ok(model, url));
  const cd = memCooldowns();
  const chain = buildChain(providerFor('groq', 'openai/gpt-oss-120b', admin, settings), admin, settings);
  const r = await completeWithFallback(chain, 's', 'u', {}, { cooldowns: cd, cooldown: admin.cooldown, now: () => 1000 });
  assert.equal(r.text, 'gemini-3.8-flash 답');
  assert.equal(label(r.provider), 'gemini/gemini-3.8-flash');
  assert.deepEqual(calls, ['openai/gpt-oss-120b', 'gemini-3.8-flash']);
  assert.equal(cd.peek()['groq/openai/gpt-oss-120b'], 1000 + 30_000);
  assert.match(r.fallbacks[0].reason, /^429/);
});

test('429: Retry-After 가 길어도 상한을 넘지 않는다', async t => {
  fastRetry(t);
  mockFetch(t, (model, url) => model === 'openai/gpt-oss-120b' ? [429, { error: { message: 'rate' } }, { 'retry-after': '99999' }] : ok(model, url));
  const cd = memCooldowns();
  const chain = buildChain(providerFor('groq', 'openai/gpt-oss-120b', admin, settings), admin, settings);
  await completeWithFallback(chain, 's', 'u', {}, { cooldowns: cd, cooldown: admin.cooldown, now: () => 0 });
  assert.equal(cd.peek()['groq/openai/gpt-oss-120b'], 600_000);
});

test('429: Retry-After 가 없으면 기본값', async t => {
  fastRetry(t);
  mockFetch(t, (model, url) => model === 'openai/gpt-oss-120b' ? [429, { error: { message: 'rate' } }] : ok(model, url));
  const cd = memCooldowns();
  const chain = buildChain(providerFor('groq', 'openai/gpt-oss-120b', admin, settings), admin, settings);
  await completeWithFallback(chain, 's', 'u', {}, { cooldowns: cd, cooldown: admin.cooldown, now: () => 0 });
  assert.equal(cd.peek()['groq/openai/gpt-oss-120b'], 60_000);
});

test('쿨다운 중이면 그 모델은 부르지 않고, 풀리면 다시 부른다', async t => {
  const calls = mockFetch(t, ok);
  const cd = memCooldowns({ 'groq/openai/gpt-oss-120b': 5000 });
  const chain = buildChain(providerFor('groq', 'openai/gpt-oss-120b', admin, settings), admin, settings);
  const a = await completeWithFallback(chain, 's', 'u', {}, { cooldowns: cd, cooldown: admin.cooldown, now: () => 4999 });
  assert.equal(label(a.provider), 'gemini/gemini-3.8-flash');
  assert.equal(a.fallbacks[0].reason, '쿨다운 중');
  const b = await completeWithFallback(chain, 's', 'u', {}, { cooldowns: cd, cooldown: admin.cooldown, now: () => 5000 });
  assert.equal(label(b.provider), 'groq/openai/gpt-oss-120b');
  assert.deepEqual(calls, ['gemini-3.8-flash', 'openai/gpt-oss-120b']);
});

test('503·네트워크 오류도 다음 순서로 (쿨다운은 남기지 않음)', async t => {
  fastRetry(t);
  mockFetch(t, (model, url) => model === 'openai/gpt-oss-120b' ? [503, { error: { message: 'high demand' } }] : ok(model, url));
  const cd = memCooldowns();
  const chain = buildChain(providerFor('groq', 'openai/gpt-oss-120b', admin, settings), admin, settings);
  const r = await completeWithFallback(chain, 's', 'u', {}, { cooldowns: cd, cooldown: admin.cooldown, now: () => 0 });
  assert.equal(label(r.provider), 'gemini/gemini-3.8-flash');
  assert.deepEqual(cd.peek(), {});
});

test('키 오류(401)는 체인을 타지 않고 그대로 던진다', async t => {
  const calls = mockFetch(t, () => [401, { error: { message: 'Invalid API Key' } }]);
  const chain = buildChain(providerFor('groq', 'openai/gpt-oss-120b', admin, settings), admin, settings);
  await assert.rejects(completeWithFallback(chain, 's', 'u', {}, { cooldowns: memCooldowns(), cooldown: admin.cooldown, now: () => 0 }), /401 Invalid API Key/);
  assert.deepEqual(calls, ['openai/gpt-oss-120b']);
});

test('모두 쿨다운이면 가장 먼저 풀리는 것을 부른다', async t => {
  const calls = mockFetch(t, ok);
  const cd = memCooldowns({ 'groq/openai/gpt-oss-120b': 9000, 'gemini/gemini-3.8-flash': 7000 });
  const chain = buildChain(providerFor('groq', 'openai/gpt-oss-120b', admin, settings), admin, settings);
  const r = await completeWithFallback(chain, 's', 'u', {}, { cooldowns: cd, cooldown: admin.cooldown, now: () => 0 });
  assert.equal(label(r.provider), 'gemini/gemini-3.8-flash');
  assert.deepEqual(calls, ['gemini-3.8-flash']);
});

test('마지막 순서에서는 429 도 기존처럼 재시도한다', async t => {
  fastRetry(t);
  let n = 0;
  const calls = mockFetch(t, (model, url) => (n++ === 0 ? [429, { error: { message: 'rate' } }] : ok(model, url)));
  const only = buildChain(providerFor('groq', 'openai/gpt-oss-120b', admin, settings), admin, { apiKeys: { groq: 'g' } });
  const r = await completeWithFallback(only, 's', 'u', {}, { cooldowns: memCooldowns(), cooldown: admin.cooldown, now: () => 0 });
  assert.equal(r.text, 'openai/gpt-oss-120b 답');
  assert.equal(calls.length, 2);
});

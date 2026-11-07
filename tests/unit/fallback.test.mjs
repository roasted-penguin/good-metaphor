import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChain, completeWithFallback, isDailyLimit, cooldownMsFor } from '../../extension/lib/fallback.js';
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

// 체인은 늘어날 수 있다(사용자 안내, 2026-10-18). 순위 개수에 기대지 않는지 3개로 확인한다
test('체인 3개 이상: 429 → 503 → 세 번째가 답하고, 다음 호출은 쿨다운된 첫째만 건너뛴다', async t => {
  fastRetry(t);
  const admin3 = { ...admin, fallbackChain: [...admin.fallbackChain, { provider: 'openai', model: 'gpt-6-luna' }] };
  const s3 = { ...settings, apiKeys: { ...settings.apiKeys, openai: 'o' } };
  const fails = { 'openai/gpt-oss-120b': [429, { error: { message: 'rate' } }], 'gemini-3.8-flash': [503, { error: { message: 'busy' } }] };
  let gemFails = true;
  const calls = mockFetch(t, (model, url) => {
    if (model === 'gemini-3.8-flash' && !gemFails) return ok(model, url);
    return fails[model] || ok(model, url);
  });
  const cd = memCooldowns();
  const chain = buildChain(providerFor('groq', 'openai/gpt-oss-120b', admin3, s3), admin3, s3);
  assert.deepEqual(chain.map(label), ['groq/openai/gpt-oss-120b', 'gemini/gemini-3.8-flash', 'openai/gpt-6-luna']);
  const a = await completeWithFallback(chain, 's', 'u', {}, { cooldowns: cd, cooldown: admin3.cooldown, now: () => 0 });
  assert.equal(label(a.provider), 'openai/gpt-6-luna');
  assert.deepEqual(a.fallbacks.map(f => f.provider), ['groq/openai/gpt-oss-120b', 'gemini/gemini-3.8-flash']);
  assert.deepEqual(Object.keys(cd.peek()), ['groq/openai/gpt-oss-120b'], '503은 쿨다운을 남기지 않음');
  gemFails = false;
  const b = await completeWithFallback(chain, 's', 'u', {}, { cooldowns: cd, cooldown: admin3.cooldown, now: () => 1 });
  assert.equal(label(b.provider), 'gemini/gemini-3.8-flash');
  assert.equal(calls.filter(m => m === 'openai/gpt-oss-120b').length, 1);
});

// 체인에 순위를 더할 때 빠뜨리기 쉬운 것: 레지스트리 모델 목록, 허용 목록, manifest 호스트 권한
import { readFileSync } from 'node:fs';
import { PROVIDERS } from '../../extension/lib/providers.js';
const realAdmin = JSON.parse(readFileSync(new URL('../../extension/config/admin.json', import.meta.url)));
const manifest = JSON.parse(readFileSync(new URL('../../extension/manifest.json', import.meta.url)));
const covered = url => manifest.host_permissions.some(h => new RegExp('^' + h.replace(/[.]/g, '\\.').replace(/\*/g, '.*') + '$').test(url + '/x'));

test('admin.json 체인: 모든 순위가 레지스트리 모델·허용 목록·호스트 권한 안에 있다', () => {
  assert.ok(realAdmin.fallbackChain.length >= 1);
  for (const { provider, model } of realAdmin.fallbackChain) {
    const def = PROVIDERS[provider];
    assert.ok(def, `${provider} 가 PROVIDERS 에 없음`);
    assert.ok(def.models.includes(model), `${provider}/${model} 이 models 목록에 없음`);
    assert.ok(realAdmin.allowedProviders.includes(provider), `${provider} 가 allowedProviders 에 없음`);
    assert.ok(covered(def.baseUrl), `${def.baseUrl} 이 manifest host_permissions 에 없음`);
  }
});

test('admin.json 체인 (2026-10-18 사용자 결정): Groq → Gemini 3.5 Flash-Lite → NVIDIA → 로컬 Ollama', () => {
  assert.deepEqual(realAdmin.fallbackChain.map(c => c.provider), ['groq', 'gemini', 'nvidia', 'ollama']);
  assert.equal(PROVIDERS.ollama.local, true);
  assert.equal(PROVIDERS.ollama.keyOptional, true);
  assert.equal(PROVIDERS.ollama.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(realAdmin.fallbackChain[1].model, 'gemini-3.5-flash-lite');
  assert.equal(PROVIDERS.nvidia.kind, 'openai-compat');
  assert.equal(PROVIDERS.nvidia.baseUrl, 'https://integrate.api.nvidia.com/v1');
  assert.equal(PROVIDERS.nvidia.stream, true);
});

// 로컬 모델(맥 Ollama)은 최종 방어선: 다른 무료 모델은 무조건 앞 (사용자 결정 2026-10-18, T-127)
test('로컬 제공자는 사용자가 골라도, 관리자 체인 중간에 있어도 항상 맨 뒤', () => {
  const adminL = { ...admin, allowedProviders: [...admin.allowedProviders, 'ollama'],
    fallbackChain: [{ provider: 'ollama', model: 'gemma4:12b' }, ...admin.fallbackChain] };
  const fromGroq = buildChain(providerFor('groq', 'openai/gpt-oss-120b', adminL, settings), adminL, settings);
  assert.deepEqual(fromGroq.map(label), ['groq/openai/gpt-oss-120b', 'gemini/gemini-3.8-flash', 'ollama/gemma4:12b']);
  const fromLocal = buildChain(providerFor('ollama', 'gemma4:12b', adminL, settings), adminL, settings);
  assert.deepEqual(fromLocal.map(label), ['groq/openai/gpt-oss-120b', 'gemini/gemini-3.8-flash', 'ollama/gemma4:12b']);
});

test('로컬 서버가 꺼져 있으면(네트워크 오류) 앞 순위가 모두 실패했을 때만 그 오류가 보인다', async t => {
  fastRetry(t);
  const adminL = { ...admin, allowedProviders: [...admin.allowedProviders, 'ollama'], fallbackChain: [...admin.fallbackChain, { provider: 'ollama', model: 'gemma4:12b' }] };
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).startsWith('http://127.0.0.1')) throw new TypeError('fetch failed');
    return { ok: false, status: 503, headers: new Headers(), text: async () => '{"error":{"message":"busy"}}' };
  });
  const chain = buildChain(providerFor('groq', 'openai/gpt-oss-120b', adminL, settings), adminL, settings);
  await assert.rejects(completeWithFallback(chain, 's', 'u', {}, { cooldowns: memCooldowns(), cooldown: admin.cooldown, now: () => 0 }), /네트워크 오류/);
});

// ── T-126 하루 한도 429는 리셋까지 쿨다운 ──
const bodies = JSON.parse(readFileSync(new URL('./fixtures/429-bodies.json', import.meta.url)));
const cd126 = { defaultMs: 60_000, maxMs: 600_000, dailyDefaultMs: 3_600_000, dailyMaxMs: 86_400_000 };
// postOnce 가 만드는 모양: message = "429 " + 본문의 error.message, body = 원문 본문
const err429 = (b, retryAfterMs) => {
  const text = JSON.stringify(b);
  const e = new Error(`429 ${b.error?.message || b.message || text.slice(0, 300)}`);
  e.status = 429; e.body = text;
  if (retryAfterMs) e.retryAfterMs = retryAfterMs;
  return e;
};
const MIN = 60_000, HOUR = 3_600_000;

test('하루 한도 판정: Groq TPD·RPD, Gemini PerDay 는 하루, TPM·PerMinute·NVIDIA 는 분당', () => {
  assert.equal(isDailyLimit(err429(bodies.groqTPD)), true);
  assert.equal(isDailyLimit(err429(bodies.groqRPD)), true);
  assert.equal(isDailyLimit(err429(bodies.geminiDay)), true);
  assert.equal(isDailyLimit(err429(bodies.groqTPM)), false);
  assert.equal(isDailyLimit(err429(bodies.geminiMinute)), false);
  assert.equal(isDailyLimit(err429(bodies.nvidia)), false);
});

test('하루 한도 판정: 본문 없는 오류(네트워크·옛 오류 객체)도 예외 없이 분당', () => {
  assert.equal(isDailyLimit(new Error('네트워크 오류: fetch failed')), false);
  assert.equal(isDailyLimit({ status: 429 }), false);
  assert.equal(isDailyLimit({}), false);
  assert.equal(cooldownMsFor({ status: 429 }, cd126, 0), 60_000);
  assert.equal(cooldownMsFor({ status: 429, retryAfterMs: 30_000 }, cd126, 0), 30_000);
});

test('하루 한도 기간: Groq "try again in" 시간을 올림해 쓴다', () => {
  assert.equal(cooldownMsFor(err429(bodies.groqTPD), cd126, 0), 5 * MIN + 2400);
  assert.equal(cooldownMsFor(err429(bodies.groqRPD), cd126, 0), HOUR + 12 * MIN + 3000);
  const custom = t => err429({ error: { message: `Rate limit reached on tokens per day (TPD): Limit 1. Please try again in ${t}.` } });
  assert.equal(cooldownMsFor(custom('16m21.6s'), cd126, 0), 16 * MIN + 21_600);
  assert.equal(cooldownMsFor(custom('5.3s'), cd126, 0), 60_000, '최소 defaultMs');
  assert.equal(cooldownMsFor(custom('2m0.0004s'), cd126, 0), 2 * MIN + 1, 'ms 미만은 올림');
  assert.equal(cooldownMsFor(custom('30h'), cd126, 0), 86_400_000, '상한 dailyMaxMs');
});

test('분당 429 는 지금과 같다: Retry-After 또는 defaultMs, 상한 maxMs (본문의 try again·retryDelay 무시)', () => {
  assert.equal(cooldownMsFor(err429(bodies.groqTPM), cd126, 0), 60_000);
  assert.equal(cooldownMsFor(err429(bodies.groqTPM, 30_000), cd126, 0), 30_000);
  assert.equal(cooldownMsFor(err429(bodies.geminiMinute), cd126, 0), 60_000);
  assert.equal(cooldownMsFor(err429(bodies.nvidia, 99_999_000), cd126, 0), 600_000);
  assert.equal(cooldownMsFor(err429(bodies.nvidia), {}, 0), 60_000, '설정이 비어도 기본값');
  assert.equal(cooldownMsFor(err429(bodies.nvidia, 99_999_000), {}, 0), 600_000);
});

test('하루 한도 기간: Gemini PerDay 는 다음 LA 자정까지(retryDelay 무시, 서머타임 안전)', () => {
  const gd = err429(bodies.geminiDay);
  // 2026-03-08 02:00 PST → PDT. 그날은 23시간
  assert.equal(cooldownMsFor(gd, cd126, Date.UTC(2026, 2, 8, 7, 58)), 2 * MIN, '3/7 23:58 PST');
  assert.equal(cooldownMsFor(gd, cd126, Date.UTC(2026, 2, 8, 7, 59)), MIN, '3/7 23:59 PST');
  assert.equal(cooldownMsFor(gd, cd126, Date.UTC(2026, 2, 8, 8, 1)), 23 * HOUR - MIN, '3/8 00:01 PST → 3/9 00:00 PDT');
  // 2026-11-01 02:00 PDT → PST. 그날은 25시간이라 상한에 걸린다
  assert.equal(cooldownMsFor(gd, cd126, Date.UTC(2026, 10, 1, 6, 59)), MIN, '10/31 23:59 PDT');
  assert.equal(cooldownMsFor(gd, cd126, Date.UTC(2026, 10, 1, 7, 1)), 86_400_000, '11/1 00:01 PDT → 11/2 00:00 PST(25h-1m), 상한');
  assert.equal(cooldownMsFor(gd, { ...cd126, dailyMaxMs: 100 * HOUR }, Date.UTC(2026, 10, 1, 7, 1)), 25 * HOUR - MIN);
  // 평범한 날, 정각 자정이면 다음 자정(엄격히 이후)
  assert.equal(cooldownMsFor(gd, cd126, Date.UTC(2026, 10, 9, 8, 0)), 24 * HOUR, '자정 정각은 다음 날 자정(24h)');
});

test('하루 한도 기간: 모양을 모르면 dailyDefaultMs, 설정이 없으면 1시간', () => {
  const unknownDaily = err429({ error: { message: 'Limit reached on requests per day (RPD).' } });
  assert.equal(cooldownMsFor(unknownDaily, cd126, 0), 3_600_000);
  assert.equal(cooldownMsFor(unknownDaily, { ...cd126, dailyDefaultMs: 7_200_000 }, 0), 7_200_000);
  assert.equal(cooldownMsFor(unknownDaily, { defaultMs: 60_000, maxMs: 600_000 }, 0), 3_600_000);
});

test('postOnce: 오류에 원문 본문(앞 4000자)을 붙이고, message 는 그대로', async t => {
  fastRetry(t);
  const long = { error: { message: 'rate' }, pad: 'x'.repeat(5000) };
  mockFetch(t, () => [429, long]);
  const only = buildChain(providerFor('groq', 'openai/gpt-oss-120b', admin, settings), admin, { apiKeys: { groq: 'g' } });
  const e = await completeWithFallback(only, 's', 'u', {}, { cooldowns: memCooldowns(), cooldown: cd126, now: () => 0 }).catch(x => x);
  assert.equal(e.message, '429 rate');
  assert.equal(e.body, JSON.stringify(long).slice(0, 4000));
});

test('통합: 하루 한도 429 모델은 리셋 시각까지 쿨다운, 다음 호출에서 쿨다운 중으로 빠진다', async t => {
  fastRetry(t);
  const now0 = Date.UTC(2026, 10, 9, 20, 0); // LA 11/9 12:00 PST
  const routes = { 'openai/gpt-oss-120b': [429, bodies.groqRPD], 'gemini-3.8-flash': [429, bodies.geminiDay] };
  const admin3 = { ...admin, cooldown: cd126, fallbackChain: [...admin.fallbackChain, { provider: 'openai', model: 'gpt-6-luna' }] };
  const s3 = { ...settings, apiKeys: { ...settings.apiKeys, openai: 'o' } };
  const calls = mockFetch(t, (model, url) => routes[model] || ok(model, url));
  const cd = memCooldowns();
  const chain = buildChain(providerFor('groq', 'openai/gpt-oss-120b', admin3, s3), admin3, s3);
  const a = await completeWithFallback(chain, 's', 'u', {}, { cooldowns: cd, cooldown: admin3.cooldown, now: () => now0 });
  assert.equal(label(a.provider), 'openai/gpt-6-luna');
  assert.equal(cd.peek()['groq/openai/gpt-oss-120b'], now0 + HOUR + 12 * MIN + 3000);
  assert.equal(cd.peek()['gemini/gemini-3.8-flash'], now0 + 12 * HOUR);
  // 분당 상한(10분)보다 한참 뒤에도 둘 다 쿨다운 중
  const b = await completeWithFallback(chain, 's', 'u', {}, { cooldowns: cd, cooldown: admin3.cooldown, now: () => now0 + 30 * MIN });
  assert.equal(label(b.provider), 'openai/gpt-6-luna');
  assert.deepEqual(b.fallbacks, [{ provider: 'groq/openai/gpt-oss-120b', reason: '쿨다운 중' }, { provider: 'gemini/gemini-3.8-flash', reason: '쿨다운 중' }]);
  assert.deepEqual(calls, ['openai/gpt-oss-120b', 'gemini-3.8-flash', 'gpt-6-luna', 'gpt-6-luna']);
});

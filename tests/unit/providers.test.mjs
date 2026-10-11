import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, complete } from '../../extension/lib/providers.js';

const gemini = { id: 'gemini', def: PROVIDERS.gemini, model: 'm', apiKey: 'k', baseUrl: PROVIDERS.gemini.baseUrl };
const ok = { candidates: [{ content: { parts: [{ text: 'thought', thought: true }, { text: '답' }] } }] };

// fetch 를 순서대로 응답하는 가짜로 바꾸고 받은 본문을 모은다
function mockFetch(t, responses) {
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    const [status, json] = responses.shift();
    return { ok: status < 400, status, text: async () => JSON.stringify(json) };
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

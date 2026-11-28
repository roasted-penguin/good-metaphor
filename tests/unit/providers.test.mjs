import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, complete, retryPolicy, parseJSONLoose, firstJSONObject, isToolUseFailed } from '../../extension/lib/providers.js';

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

// T-188: Gemini는 스트림 도중 {"error":{"code":503}} 이벤트를 보내고 끊는다. 예전엔 조각을 무시해
// 잘린 JSON을 돌려줘 "모델 응답을 해석하지 못했어요"가 됐다(스모크 run 45012155475, 로컬 재현 4회 중 1회)
test('스트리밍: 도중에 온 error 이벤트는 상태 코드를 단 오류로 던지고, 다시 보내지 않는다', async t => {
  fastRetry(t);
  const part = text => JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] });
  const reqs = mockStreamFetch(t, [
    { sse: [part('{"meaning": "뜻이에요.",'), JSON.stringify({ error: { code: 503, message: 'high demand', status: 'UNAVAILABLE' } })] },
    { sse: [part('{"meaning": "다시"}')] }
  ]);
  const seen = [];
  await assert.rejects(complete(gemini, 's', 'u', { json: true, onText: s => seen.push(s) }), e => {
    assert.equal(e.status, 503);
    assert.match(e.message, /중간에 끊겼어요/);
    assert.match(e.message, /high demand/);
    return true;
  });
  // 앞부분을 이미 onText로 보냈으니 같은 제공자에 다시 보내지 않는다(이어 붙으면 JSON이 깨진다)
  assert.equal(reqs.length, 1);
  assert.deepEqual(seen, ['{"meaning": "뜻이에요.",']);
});

test('스트리밍: openai-compat 도중 error(숫자 코드 없음)는 상태 0으로 던진다', async t => {
  mockStreamFetch(t, [{ sse: [delta('{"meaning'), JSON.stringify({ error: { message: 'overloaded', type: 'server_error' } })] }]);
  await assert.rejects(complete(groq, 's', 'u', { onText: () => {} }), e => e.status === 0 && /overloaded/.test(e.message));
});

test('NVIDIA: 생각(thinking)을 끄는 chat_template_kwargs 를 보낸다 (켜면 첫 글자까지 14~30초)', async t => {
  const nvidia = { id: 'nvidia', def: PROVIDERS.nvidia, model: 'nvidia/nemotron-3.5-super-vl-120b-a12b', apiKey: 'k', baseUrl: PROVIDERS.nvidia.baseUrl };
  const bodies = mockFetch(t, [[200, chat('답')]]);
  assert.equal(await complete(nvidia, 's', 'u'), '답');
  assert.deepEqual(bodies[0].chat_template_kwargs, { enable_thinking: false });
});

// ── T-222: 이어 묻기 에이전트(JSON 액션)용 ──
test('Groq: jsonObject를 청하면(에이전트) response_format json_object, 호버(json만)·스트리밍·다른 제공자는 안 보낸다', async t => {
  const bodies = mockFetch(t, [[200, chat('{}')], [200, chat('{}')], [200, chat('{}')]]);
  await complete(groq, 's', 'u', { json: true, jsonObject: true });
  await complete(groq, 's', 'u', { json: true });
  const nvidia = { id: 'nvidia', def: PROVIDERS.nvidia, model: 'm', apiKey: 'k', baseUrl: PROVIDERS.nvidia.baseUrl };
  await complete(nvidia, 's', 'u', { json: true, jsonObject: true });
  assert.deepEqual(bodies[0].response_format, { type: 'json_object' });
  assert.equal(bodies[1].response_format, undefined);
  assert.equal(bodies[2].response_format, undefined, '등록부에 jsonObject가 없는 제공자');
});

test('openai-compat: content 없이 tool_calls로 오면 JSON 액션 글자로 바꾼다(arguments가 글자여도)', async t => {
  mockFetch(t, [[200, { choices: [{ message: { content: '', tool_calls: [{ type: 'function', function: { name: 'get_node_facts', arguments: '{"nodeId":"cube"}' } }] } }] }]]);
  assert.equal(await complete(groq, 's', 'u', { json: true }), '{"action":"get_node_facts","args":{"nodeId":"cube"}}');
});

test('openai-compat: 400 tool_use_failed에 원래 생성(failed_generation)이 있으면 그 글을 답으로, JSON을 안 바랐으면 그대로 던진다', async t => {
  const err = { error: { message: 'Tool choice is none, but model called a tool', code: 'tool_use_failed', failed_generation: '{"name":"get_node_facts","arguments":{"nodeId":"cube"}}' } };
  const bodies = mockFetch(t, [[400, err], [400, err]]);
  assert.equal(await complete(groq, 's', 'u', { json: true }), err.error.failed_generation);
  await assert.rejects(complete(groq, 's', 'u', {}), e => e.status === 400 && e.modelOutput === true);
  assert.equal(bodies.length, 2, '다시 보내지 않는다');
});

test('isToolUseFailed: 모델 출력 400만(키 오류 400은 아님)', () => {
  assert.equal(isToolUseFailed({ status: 400, message: '400 Tool choice is none, but model called a tool' }), true);
  assert.equal(isToolUseFailed({ status: 400, message: '400 bad', body: '{"error":{"code":"json_validate_failed"}}' }), true);
  assert.equal(isToolUseFailed({ status: 400, message: "400 Failed to validate JSON. Please adjust your prompt. See 'failed_generation' for more details." }), true, 'Groq JSON 객체 모드 검증 실패(2026-11-28 Actions 스모크 원문)');
  assert.equal(isToolUseFailed({ status: 400, message: '400 API key not valid.' }), false);
  assert.equal(isToolUseFailed({ status: 429, message: 'called a tool' }), false);
});

test('parseJSONLoose: 객체 둘을 이어 붙였으면 앞의 것, 문자열 속 중괄호는 세지 않는다', () => {
  assert.deepEqual(parseJSONLoose('{"a":"x}"}\n{"b":2}'), { a: 'x}' });
  assert.deepEqual(parseJSONLoose('생각: {나쁨} 그래서 {"a":1} 끝 }'), { a: 1 });
  assert.deepEqual(parseJSONLoose('{"a":{"b":"\\"}"}}'), { a: { b: '"}' } });
  assert.equal(parseJSONLoose('{깨짐'), null);
  assert.equal(firstJSONObject('없음'), null);
  // 예전 동작은 그대로
  assert.deepEqual(parseJSONLoose('```json\n{"a":1}\n```'), { a: 1 });
});

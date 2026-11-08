import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callAnalogyServer, checkServerResult, shouldUseServer, serverSkipReason, getInstallToken, REJECTED_TEXT } from '../../extension/lib/analogy-server.js';

// 서버 응답 모양(server/app/pipeline.py 반환값을 흉내)
const serverResult = (over = {}) => ({
  meaning: '돈을 빌려주는 것이에요.',
  analogy: '메소를 빌려주는 것과 같아요.',
  mapping: '',
  rejected: null,
  evidence: { nodeId: 'meso', nodeLabel: '메소', source: 'common', tagLabel: '화폐' },
  domain: 'maplestory',
  theme: 'maple',
  feedbackApplied: false,
  debug: { candidates: [{ id: 'meso', label: '메소' }, { id: 'auction', label: '경매장' }], provider: 'server/x' },
  ...over
});

const jsonRes = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body)
});

const payload = { sentence: '대출은 돈을 빌리는 것이다.', word: '대출', context: '', pageTitle: '경제' };

test('성공: ok·result·ms, POST {url}/v1/analogy 에 본문·헤더를 보낸다(끝 / 정리)', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return jsonRes(serverResult()); };
  const r = await callAnalogyServer({ url: 'https://api.example.com/', token: 'tok-1', payload, timeoutMs: 1000, fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.result.meaning, '돈을 빌려주는 것이에요.');
  assert.equal(r.result.analogy, '메소를 빌려주는 것과 같아요.');
  assert.equal(typeof r.ms, 'number');
  assert.equal(seen.url, 'https://api.example.com/v1/analogy');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers['content-type'], 'application/json');
  assert.equal(seen.init.headers['X-Install-Token'], 'tok-1');
  assert.deepEqual(JSON.parse(seen.init.body), payload);
  assert.ok(seen.init.signal, 'AbortSignal 을 넘긴다');
});

for (const status of [400, 404, 429, 500, 503]) {
  test(`2xx 아님 ${status} → http-${status}`, async () => {
    const r = await callAnalogyServer({ url: 'https://a', token: 't', payload, timeoutMs: 1000, fetchImpl: async () => jsonRes({ detail: 'x' }, status) });
    assert.deepEqual(r, { ok: false, reason: `http-${status}` });
  });
}

test('네트워크 예외 → network', async () => {
  const r = await callAnalogyServer({ url: 'https://a', token: 't', payload, timeoutMs: 1000, fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  assert.deepEqual(r, { ok: false, reason: 'network' });
});

test('느린 응답 → timeout (AbortSignal 로 끊는다)', async () => {
  let aborted = false;
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      aborted = true;
      const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
    });
  });
  const t0 = Date.now();
  const r = await callAnalogyServer({ url: 'https://a', token: 't', payload, timeoutMs: 30, fetchImpl });
  assert.deepEqual(r, { ok: false, reason: 'timeout' });
  assert.equal(aborted, true);
  assert.ok(Date.now() - t0 < 1000);
});

test('본문이 JSON 아님 → bad-json', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); }, text: async () => '<html>' });
  const r = await callAnalogyServer({ url: 'https://a', token: 't', payload, timeoutMs: 1000, fetchImpl });
  assert.deepEqual(r, { ok: false, reason: 'bad-json' });
});

test('필수 키 없음 → bad-shape', async () => {
  const broken = [
    (() => { const x = serverResult(); delete x.meaning; return x; })(),
    (() => { const x = serverResult(); delete x.analogy; return x; })(),
    (() => { const x = serverResult(); delete x.evidence; return x; })(),
    (() => { const x = serverResult(); delete x.domain; return x; })(),
    (() => { const x = serverResult(); delete x.theme; return x; })(),
    serverResult({ debug: {} }),
    serverResult({ debug: { candidates: 'meso' } }),
    null,
    [1, 2]
  ];
  for (const body of broken) {
    const r = await callAnalogyServer({ url: 'https://a', token: 't', payload, timeoutMs: 1000, fetchImpl: async () => jsonRes(body) });
    assert.deepEqual(r, { ok: false, reason: 'bad-shape' }, JSON.stringify(body));
  }
});

test('evidence 가 null 이어도 모양은 맞다', () => {
  const r = checkServerResult(serverResult({ analogy: '', evidence: null }));
  assert.equal(r.evidence, null);
  assert.equal(r.analogy, '');
});

test('규칙 1: 후보 밖 nodeId → analogy 빈 문자열·rejected 문구, 원본은 그대로', async () => {
  const body = serverResult({ evidence: { nodeId: 'starforce', nodeLabel: '스타포스', source: 'common', tagLabel: null } });
  const r = await callAnalogyServer({ url: 'https://a', token: 't', payload, timeoutMs: 1000, fetchImpl: async () => jsonRes(body) });
  assert.equal(r.ok, true);
  assert.equal(r.result.analogy, '');
  assert.equal(r.result.rejected, '모델이 근거 목록에 없는 개념을 골라서 비유를 숨겼어요.');
  assert.equal(REJECTED_TEXT, '모델이 근거 목록에 없는 개념을 골라서 비유를 숨겼어요.');
  assert.equal(r.result.evidence, null);
  assert.equal(r.result.meaning, body.meaning, '뜻은 남긴다');
  // 원본을 바꾸지 않는다
  assert.equal(body.analogy, '메소를 빌려주는 것과 같아요.');
  assert.equal(body.evidence.nodeId, 'starforce');
});

test('규칙 1: 근거 없이 비유만 있으면 숨긴다', () => {
  const r = checkServerResult(serverResult({ evidence: null }));
  assert.equal(r.analogy, '');
  assert.equal(r.rejected, REJECTED_TEXT);
});

test('규칙 1: nodeId 가 후보 안이면 그대로, 새 객체', () => {
  const body = serverResult();
  const r = checkServerResult(body);
  assert.notEqual(r, body);
  assert.equal(r.analogy, '메소를 빌려주는 것과 같아요.');
  assert.equal(r.rejected, null);
  assert.deepEqual(r.evidence, body.evidence);
});

test('checkServerResult: 모양이 틀리면 bad-shape 오류', () => {
  assert.throws(() => checkServerResult({ meaning: 'x' }), e => e.code === 'bad-shape');
});

const admin = { analogyServer: { url: 'https://api.example.com', timeoutMs: 4000 } };

test('shouldUseServer: 조건이 모두 맞으면 서버', () => {
  assert.equal(shouldUseServer({ admin, session: null, sentenceRecords: [], providerKind: 'gemini' }), true);
  assert.equal(shouldUseServer({ admin, session: null, sentenceRecords: [{ vote: 'up' }], providerKind: 'openai-compat' }), true, '👍 은 막지 않는다');
});

test('shouldUseServer (a): url 이 비었거나 없으면 로컬', () => {
  assert.equal(shouldUseServer({ admin: { analogyServer: { url: '' } }, session: null, sentenceRecords: [], providerKind: 'gemini' }), false);
  assert.equal(shouldUseServer({ admin: {}, session: null, sentenceRecords: [], providerKind: 'gemini' }), false);
  assert.equal(shouldUseServer({ admin: undefined, session: null, sentenceRecords: [], providerKind: 'gemini' }), false);
});

test('shouldUseServer (b): 로그인 세션이 있으면 로컬', () => {
  assert.equal(shouldUseServer({ admin, session: { name: 'u' }, sentenceRecords: [], providerKind: 'gemini' }), false);
});

test('shouldUseServer (c): 그 문장에 down·pick 기록이 있으면 로컬', () => {
  assert.equal(shouldUseServer({ admin, session: null, sentenceRecords: [{ vote: 'down' }], providerKind: 'gemini' }), false);
  assert.equal(shouldUseServer({ admin, session: null, sentenceRecords: [{ vote: 'up' }, { vote: 'pick' }], providerKind: 'gemini' }), false);
  assert.equal(shouldUseServer({ admin, session: null, sentenceRecords: undefined, providerKind: 'gemini' }), true);
});

test('shouldUseServer (d): 데모 제공자면 로컬', () => {
  assert.equal(shouldUseServer({ admin, session: null, sentenceRecords: [], providerKind: 'demo' }), false);
});

test('getInstallToken: 없으면 만들어 저장, 두 번 불러도 같은 값', async () => {
  const data = {};
  let sets = 0;
  const storage = {
    async get(key) { return key in data ? { [key]: data[key] } : {}; },
    async set(obj) { sets++; Object.assign(data, obj); }
  };
  const a = await getInstallToken(storage);
  const b = await getInstallToken(storage);
  assert.equal(typeof a, 'string');
  assert.ok(a.length >= 16);
  assert.equal(a, b);
  assert.equal(data.installToken, a);
  assert.equal(sets, 1, '이미 있으면 다시 저장하지 않는다');
});

test('getInstallToken: 이미 있으면 그대로', async () => {
  const storage = { async get() { return { installToken: 'keep-me' }; }, async set() { throw new Error('저장하면 안 돼요'); } };
  assert.equal(await getInstallToken(storage), 'keep-me');
});

test('timeoutMs 를 안 주면 4000ms 로 끊는다', async () => {
  const realSet = globalThis.setTimeout;
  const delays = [];
  globalThis.setTimeout = (fn, ms, ...a) => { delays.push(ms); return realSet(fn, 1e6, ...a);  };
  try {
    const r = await callAnalogyServer({ url: 'https://a', token: 't', payload, fetchImpl: async () => jsonRes(serverResult()) });
    assert.equal(r.ok, true);
  } finally {
    globalThis.setTimeout = realSet;
  }
  assert.deepEqual(delays, [4000]);
});

test('serverSkipReason: 서버를 건너뛰는 이유(off·session·feedback·demo), 쓰면 null', () => {
  const base = { admin, session: null, sentenceRecords: [], providerKind: 'gemini' };
  assert.equal(serverSkipReason(base), null);
  assert.equal(serverSkipReason({ ...base, admin: { analogyServer: { url: '' } } }), 'off');
  assert.equal(serverSkipReason({ ...base, session: { name: 'u' } }), 'session');
  assert.equal(serverSkipReason({ ...base, sentenceRecords: [{ vote: 'pick' }] }), 'feedback');
  assert.equal(serverSkipReason({ ...base, providerKind: 'demo' }), 'demo');
});

// T-302: 서버는 메이플 그래프만 안다. 공통 관심사가 메이플이 아니면 로컬
test('serverSkipReason: 공통 관심사가 메이플이 아니면 interest, 메이플·생략이면 그대로 서버 (T-302)', () => {
  const base = { admin, session: null, sentenceRecords: [], providerKind: 'gemini' };
  assert.equal(serverSkipReason({ ...base, commonId: 'restaurant' }), 'interest');
  assert.equal(shouldUseServer({ ...base, commonId: 'restaurant' }), false);
  assert.equal(serverSkipReason({ ...base, commonId: 'maplestory' }), null);
  assert.equal(serverSkipReason(base), null, '생략하면 메이플(예전 호출 모양)');
  // 주소가 없으면 off가 먼저, 로그인이면 session이 먼저
  assert.equal(serverSkipReason({ ...base, admin: {}, commonId: 'restaurant' }), 'off');
  assert.equal(serverSkipReason({ ...base, session: { name: 'u' }, commonId: 'restaurant' }), 'session');
});

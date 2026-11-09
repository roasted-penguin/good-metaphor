import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callAnalogyServer, checkServerResult, shouldUseServer, serverSkipReason, getInstallToken, REJECTED_TEXT, serverOriginPattern, shouldCacheLocal, nextServerCooldown, inServerCooldown, parseRetryAfter } from '../../extension/lib/analogy-server.js';

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

/* ───────── T-141 서버 모드 실사용 준비 ───────── */

// 규칙 1 로컬 확인: 서버 후보 안이어도 로컬 그래프에 없는 노드면 숨긴다
test('규칙 1(T-141): nodeId 가 서버 후보 안이지만 로컬 노드 집합에 없으면 숨긴다', () => {
  const r = serverResult({
    evidence: { nodeId: 'ghost', nodeLabel: '없는 개념', source: 'common', tagLabel: null },
    debug: { candidates: [{ id: 'ghost', label: '없는 개념' }, { id: 'meso', label: '메소' }] }
  });
  const out = checkServerResult(r, new Set(['meso', 'auction']));
  assert.equal(out.analogy, '');
  assert.equal(out.rejected, REJECTED_TEXT);
  assert.equal(out.evidence, null);
  assert.equal(out.meaning, r.meaning, '뜻은 그대로 보인다');
});

test('규칙 1(T-141): 서버 후보 안이면서 로컬 노드 집합에도 있으면 그대로', () => {
  const out = checkServerResult(serverResult(), new Set(['meso']));
  assert.equal(out.analogy, '메소를 빌려주는 것과 같아요.');
  assert.equal(out.evidence.nodeId, 'meso');
  assert.equal(out.rejected, null);
});

test('규칙 1(T-141): 로컬 노드 집합을 안 주면 예전처럼 서버 후보만 본다', () => {
  assert.equal(checkServerResult(serverResult()).evidence.nodeId, 'meso');
});

test('callAnalogyServer(T-141): localNodeIds 를 넘기면 결과 검증에 쓴다', async () => {
  const r = await callAnalogyServer({ url: 'https://a', token: 't', payload, timeoutMs: 1000, localNodeIds: new Set(['auction']), fetchImpl: async () => jsonRes(serverResult()) });
  assert.equal(r.ok, true);
  assert.equal(r.result.analogy, '');
  assert.equal(r.result.rejected, REJECTED_TEXT);
});

test('serverSkipReason(T-141): 서버 출처 권한이 없으면 no-permission, 다른 건너뜀 이유가 먼저', () => {
  const base = { admin, session: null, sentenceRecords: [], providerKind: 'gemini' };
  assert.equal(serverSkipReason({ ...base, hasPermission: false }), 'no-permission');
  assert.equal(serverSkipReason({ ...base, hasPermission: true }), null);
  assert.equal(serverSkipReason(base), null, '생략하면 권한 있음(예전 호출 모양)');
  assert.equal(serverSkipReason({ ...base, admin: {}, hasPermission: false }), 'off');
  assert.equal(serverSkipReason({ ...base, session: { name: 'u' }, hasPermission: false }), 'session');
  assert.equal(serverSkipReason({ ...base, commonId: 'restaurant', hasPermission: false }), 'interest');
  assert.equal(serverSkipReason({ ...base, sentenceRecords: [{ vote: 'down' }], hasPermission: false }), 'feedback');
  assert.equal(serverSkipReason({ ...base, providerKind: 'demo', hasPermission: false }), 'demo');
});

test('serverOriginPattern(T-141): 서버 주소 → 권한 요청용 출처 패턴, 틀린 주소는 null', () => {
  assert.equal(serverOriginPattern('http://127.0.0.1:8000/'), 'http://127.0.0.1:8000/*');
  assert.equal(serverOriginPattern('https://api.example.com/base/path'), 'https://api.example.com/*');
  assert.equal(serverOriginPattern(''), null);
  assert.equal(serverOriginPattern(undefined), null);
  assert.equal(serverOriginPattern('주소 아님'), null);
  assert.equal(serverOriginPattern('ftp://example.com/'), null, 'http(s)만');
});

test('shouldCacheLocal(T-141): 서버 실패로 만든 로컬 결과는 캐시하지 않고, 의도적 건너뜀은 캐시', () => {
  assert.equal(shouldCacheLocal(null), true, '서버 모드 꺼짐(serverInfo 없음)');
  for (const reason of ['off', 'session', 'interest', 'feedback', 'demo', 'no-permission', 'reported']) {
    assert.equal(shouldCacheLocal({ used: false, reason }), true, reason);
  }
  for (const reason of ['network', 'timeout', 'http-500', 'http-503', 'http-429', 'bad-json', 'bad-shape', '모르는 이유']) {
    assert.equal(shouldCacheLocal({ used: false, reason }), false, reason);
  }
});

/* ───────── 서버 실패 뒤 쿨다운(T-159) ───────── */
const NOW = 1_000_000;

test('nextServerCooldown(T-159): 첫 실패는 1분, 연속 실패면 두 배씩, 10분에서 멈춘다', () => {
  let st = null;
  const seen = [];
  for (let i = 0; i < 7; i++) {
    st = nextServerCooldown(st, 'http-500', NOW, {});
    seen.push(st.until - NOW);
  }
  assert.deepEqual(seen, [60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000]);
  assert.equal(st.failures, 7);
  assert.equal(st.reason, 'http-500');
});

test('nextServerCooldown(T-159): cooldownMs·cooldownMaxMs 설정을 따른다, now 는 주입', () => {
  const cfg = { cooldownMs: 1000, cooldownMaxMs: 3000 };
  const a = nextServerCooldown(null, 'timeout', 5, cfg);
  assert.deepEqual(a, { until: 1005, reason: 'timeout', failures: 1 });
  const b = nextServerCooldown(a, 'network', 10, cfg);
  assert.deepEqual(b, { until: 2010, reason: 'network', failures: 2 });
  const c = nextServerCooldown(b, 'bad-json', 20, cfg);
  assert.deepEqual(c, { until: 3020, reason: 'bad-json', failures: 3 }, '4000 → 상한 3000');
});

test('nextServerCooldown(T-159): http-429 는 Retry-After 를 쓰고 상한은 같다, 없으면 두 배 규칙', () => {
  assert.equal(nextServerCooldown(null, 'http-429', NOW, {}, 30_000).until - NOW, 30_000);
  assert.equal(nextServerCooldown({ until: 0, failures: 3 }, 'http-429', NOW, {}, 5_000).until - NOW, 5_000, '연속 실패여도 Retry-After 그대로');
  assert.equal(nextServerCooldown(null, 'http-429', NOW, {}, 3_600_000).until - NOW, 600_000, '상한');
  assert.equal(nextServerCooldown(null, 'http-429', NOW, {}).until - NOW, 60_000, 'Retry-After 없음');
  assert.equal(nextServerCooldown(null, 'http-500', NOW, {}, 5_000).until - NOW, 60_000, '429 가 아니면 Retry-After 무시');
  assert.equal(nextServerCooldown(null, 'http-429', NOW, {}, 5_000).failures, 1, '429 도 실패 횟수를 센다');
});

test('nextServerCooldown(T-159): 설정 문제(http-4xx)도 같은 규칙', () => {
  for (const reason of ['http-400', 'http-401', 'http-403', 'http-404']) {
    assert.equal(nextServerCooldown(null, reason, NOW, {}).until - NOW, 60_000, reason);
  }
});

test('nextServerCooldown(T-159): 성공(실패 이유 없음)이면 null — 쿨다운 해제, 실패 횟수 0', () => {
  const st = nextServerCooldown(nextServerCooldown(null, 'http-500', NOW, {}), 'http-500', NOW, {});
  assert.equal(nextServerCooldown(st, null, NOW, {}), null);
  const fresh = nextServerCooldown(nextServerCooldown(st, null, NOW, {}), 'http-500', NOW, {});
  assert.equal(fresh.failures, 1, '성공 뒤 실패는 다시 1분부터');
  assert.equal(fresh.until - NOW, 60_000);
});

test('inServerCooldown(T-159): until 이 now 보다 뒤면 쿨다운 중', () => {
  assert.equal(inServerCooldown(null, NOW), false);
  assert.equal(inServerCooldown(undefined, NOW), false);
  assert.equal(inServerCooldown({}, NOW), false);
  assert.equal(inServerCooldown({ until: NOW + 1 }, NOW), true);
  assert.equal(inServerCooldown({ until: NOW }, NOW), false, '끝나는 순간에는 다시 시도');
  assert.equal(inServerCooldown({ until: NOW - 1 }, NOW), false);
});

test('serverSkipReason(T-159): 쿨다운 중이면 cooldown, 다른 건너뜀 이유가 먼저', () => {
  const base = { admin, session: null, sentenceRecords: [], providerKind: 'gemini', hasPermission: true };
  assert.equal(serverSkipReason({ ...base, inCooldown: true }), 'cooldown');
  assert.equal(serverSkipReason({ ...base, inCooldown: false }), null);
  assert.equal(serverSkipReason(base), null, '생략하면 쿨다운 아님(예전 호출 모양)');
  assert.equal(serverSkipReason({ ...base, admin: {}, inCooldown: true }), 'off');
  assert.equal(serverSkipReason({ ...base, session: { name: 'u' }, inCooldown: true }), 'session');
  assert.equal(serverSkipReason({ ...base, hasPermission: false, inCooldown: true }), 'no-permission');
  assert.equal(serverSkipReason({ ...base, providerKind: 'demo', inCooldown: true }), 'demo');
});

test('shouldCacheLocal(T-159): 쿨다운으로 건너뛴 로컬 결과는 의도적 건너뜀이라 캐시', () => {
  assert.equal(shouldCacheLocal({ used: false, reason: 'cooldown', until: NOW }), true);
});

test('parseRetryAfter(T-159): 초·HTTP 날짜를 ms 로, 틀리면 null', () => {
  assert.equal(parseRetryAfter('30', NOW), 30_000);
  assert.equal(parseRetryAfter(' 2 ', NOW), 2_000);
  assert.equal(parseRetryAfter(new Date(NOW + 90_000).toUTCString(), NOW), 90_000);
  assert.equal(parseRetryAfter(new Date(NOW - 90_000).toUTCString(), NOW), null, '지난 날짜');
  assert.equal(parseRetryAfter('0', NOW), null);
  assert.equal(parseRetryAfter('-5', NOW), null);
  assert.equal(parseRetryAfter('', NOW), null);
  assert.equal(parseRetryAfter(null, NOW), null);
  assert.equal(parseRetryAfter('곧', NOW), null);
});

test('callAnalogyServer(T-159): 429 에 Retry-After 가 있으면 retryAfterMs 를 함께 돌려준다', async () => {
  const res = { ...jsonRes({ detail: 'x' }, 429), headers: new Headers({ 'retry-after': '12' }) };
  const r = await callAnalogyServer({ url: 'https://a', token: 't', payload, timeoutMs: 1000, fetchImpl: async () => res });
  assert.deepEqual(r, { ok: false, reason: 'http-429', retryAfterMs: 12_000 });
  const noHeader = { ...jsonRes({ detail: 'x' }, 429), headers: new Headers() };
  const r2 = await callAnalogyServer({ url: 'https://a', token: 't', payload, timeoutMs: 1000, fetchImpl: async () => noHeader });
  assert.deepEqual(r2, { ok: false, reason: 'http-429' });
  const other = { ...jsonRes({ detail: 'x' }, 503), headers: new Headers({ 'retry-after': '12' }) };
  const r3 = await callAnalogyServer({ url: 'https://a', token: 't', payload, timeoutMs: 1000, fetchImpl: async () => other });
  assert.deepEqual(r3, { ok: false, reason: 'http-503' }, '429 만 Retry-After 를 본다');
});

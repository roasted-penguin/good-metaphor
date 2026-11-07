import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankViaServer, rankAllViaServer, gateLine, ServerError, ServerUnavailable } from '../../tools/eval-server.mjs';

// 서버 응답 흉내 (server/app/main.py, pipeline.py)
const res = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: k => headers[k.toLowerCase()] ?? null },
  json: async () => body,
  text: async () => JSON.stringify(body)
});
const ok = ids => res(200, { meaning: '뜻', analogy: '', debug: { candidates: ids.map((id, i) => ({ id, label: id, score: 1 - i / 10 })) } });

// 응답을 순서대로 돌려주고 호출을 기록하는 가짜 fetch
function fakeFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = responses.shift();
    if (!r) throw new Error('응답이 더 없어요');
    return typeof r === 'function' ? r() : r;
  };
  return { fetchImpl, calls };
}
function fakeSleep() {
  const waits = [];
  return { sleep: async ms => { waits.push(ms); }, waits };
}

const base = { url: 'http://srv.test/', token: 'eval-abc', sentence: '대출은 돈을 빌리는 것이다.' };

test('정상: debug.candidates의 id 순서, POST {url}/v1/analogy 본문·토큰 헤더', async () => {
  const { fetchImpl, calls } = fakeFetch([ok(['meso', 'auction', 'starforce'])]);
  const { sleep, waits } = fakeSleep();
  const ids = await rankViaServer({ ...base, fetchImpl, sleep });
  assert.deepEqual(ids, ['meso', 'auction', 'starforce']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://srv.test/v1/analogy');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['X-Install-Token'], 'eval-abc');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(calls[0].body, { sentence: base.sentence, word: '', context: '', pageTitle: '' });
  assert.deepEqual(waits, []);
});

test('429 두 번 뒤 성공: 같은 문장 3번, Retry-After 초만큼 기다림(없으면 5초)', async () => {
  const { fetchImpl, calls } = fakeFetch([
    res(429, { error: '요청이 너무 많아요.' }, { 'retry-after': '7' }),
    res(429, { error: '요청이 너무 많아요.' }),
    ok(['meso'])
  ]);
  const { sleep, waits } = fakeSleep();
  const ids = await rankViaServer({ ...base, fetchImpl, sleep });
  assert.deepEqual(ids, ['meso']);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(c => c.body.sentence === base.sentence));
  assert.deepEqual(waits, [7000, 5000]);
});

test('429 네 번: 재시도 3번을 다 쓰면 ServerError', async () => {
  const r429 = () => res(429, { error: '요청이 너무 많아요.' }, { 'retry-after': '1' });
  const { fetchImpl, calls } = fakeFetch([r429, r429, r429, r429]);
  const { sleep } = fakeSleep();
  await assert.rejects(rankViaServer({ ...base, fetchImpl, sleep }), e => e instanceof ServerError && e.status === 429);
  assert.equal(calls.length, 4);
});

test('502 한 번 뒤 성공, 502 두 번이면 ServerError', async () => {
  {
    const { fetchImpl, calls } = fakeFetch([res(502, { error: '상류 실패' }), ok(['auction'])]);
    const { sleep } = fakeSleep();
    assert.deepEqual(await rankViaServer({ ...base, fetchImpl, sleep }), ['auction']);
    assert.equal(calls.length, 2);
  }
  {
    const { fetchImpl, calls } = fakeFetch([res(502, { error: '상류 실패' }), res(502, { error: '상류 실패' })]);
    const { sleep } = fakeSleep();
    await assert.rejects(rankViaServer({ ...base, fetchImpl, sleep }), e => e instanceof ServerError && e.status === 502);
    assert.equal(calls.length, 2);
  }
});

test('503: 다시 보내지 않고 즉시 ServerUnavailable(한국어 메시지, 서버 이유 포함)', async () => {
  const { fetchImpl, calls } = fakeFetch([res(503, { error: '인덱스가 없어요.' }), ok(['meso'])]);
  const { sleep, waits } = fakeSleep();
  await assert.rejects(rankViaServer({ ...base, fetchImpl, sleep }), e => {
    assert.ok(e instanceof ServerUnavailable);
    assert.match(e.message, /인덱스가 없어요/);
    assert.match(e.message, /관문/);
    return true;
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(waits, []);
});

test('400 등 그 밖의 실패는 ServerError, 토큰 값을 메시지에 넣지 않는다', async () => {
  const { fetchImpl } = fakeFetch([res(400, { error: '설치 토큰(X-Install-Token)이 필요해요.' })]);
  const { sleep } = fakeSleep();
  await assert.rejects(rankViaServer({ ...base, fetchImpl, sleep }), e => {
    assert.ok(e instanceof ServerError && e.status === 400);
    assert.doesNotMatch(e.message, /eval-abc/);
    return true;
  });
});

test('후보 0개·debug 없음 → []', async () => {
  const { fetchImpl } = fakeFetch([ok([]), res(200, { meaning: '뜻' })]);
  const { sleep } = fakeSleep();
  assert.deepEqual(await rankViaServer({ ...base, fetchImpl, sleep }), []);
  assert.deepEqual(await rankViaServer({ ...base, fetchImpl, sleep }), []);
});

test('rankAllViaServer: 문장 순서 유지, 요청 사이 간격 60000/rpm, 진행 콜백', async () => {
  const cases = [{ sentence: 'a' }, { sentence: 'b' }, { sentence: 'c' }];
  const answers = { a: ['meso'], b: ['auction', 'meso'], c: [] };
  const calls = [];
  const fetchImpl = async (url, init) => {
    const { sentence } = JSON.parse(init.body);
    calls.push(sentence);
    return ok(answers[sentence]);
  };
  const { sleep, waits } = fakeSleep();
  const progress = [];
  const out = await rankAllViaServer({ url: 'http://srv.test', token: 't', cases, rpm: 20, fetchImpl, sleep, onProgress: (i, n) => progress.push([i, n]) });
  assert.deepEqual(out, [['meso'], ['auction', 'meso'], []]);
  assert.deepEqual(calls, ['a', 'b', 'c']);
  // 첫 요청 앞에는 기다리지 않고, 그 뒤 요청마다 3000ms
  assert.deepEqual(waits, [3000, 3000]);
  assert.deepEqual(progress, [[1, 3], [2, 3], [3, 3]]);
});

test('rankAllViaServer: 503이면 거기서 멈추고 ServerUnavailable을 올린다', async () => {
  const cases = [{ sentence: 'a' }, { sentence: 'b' }];
  const { fetchImpl, calls } = fakeFetch([res(503, { error: '서버에 LLM 키가 없어요.' })]);
  const { sleep } = fakeSleep();
  await assert.rejects(rankAllViaServer({ url: 'http://srv.test', token: 't', cases, rpm: 20, fetchImpl, sleep }), ServerUnavailable);
  assert.equal(calls.length, 1);
});

test('gateLine: 통과·미달·동률(동률은 통과), 브라우저 없음은 비교 생략', () => {
  assert.equal(gateLine(28, 27, 35), '관문: 서버 hit@1 28/35 vs 브라우저 27/35 → 통과');
  assert.equal(gateLine(20, 27, 35), '관문: 서버 hit@1 20/35 vs 브라우저 27/35 → 미달');
  assert.equal(gateLine(27, 27, 35), '관문: 서버 hit@1 27/35 vs 브라우저 27/35 → 통과');
  assert.equal(gateLine(27, null, 35), '관문: 서버 hit@1 27/35 · 브라우저 비교 생략');
});

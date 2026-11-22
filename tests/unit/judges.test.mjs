// 판정기(T-120): 객관식 JSON 파싱, 확률 정규화, 레지스트리, tags.json에서 만든 선택지, 점수 합치기. 네트워크 없음
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JUDGES, getJudge, judge, judgeFor, parseChoiceJSON, normalizeChoices, tagChoices, TAG_QUESTION, buildChoicePrompt, topChoice } from '../../extension/lib/judges.js';
import { combineTagSim, retrieve } from '../../extension/lib/retrieval.js';
import { retryPolicy } from '../../extension/lib/providers.js';

const tagsFile = JSON.parse(readFileSync(new URL('../../extension/data/common/tags.json', import.meta.url)));
const choices3 = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }];

// --- 파싱 ---
test('parseChoiceJSON: answers 배열을 읽는다', () => {
  assert.deepEqual(parseChoiceJSON('{"answers":[{"id":"a","p":0.7},{"id":"b","p":0.2}]}'), [{ id: 'a', p: 0.7 }, { id: 'b', p: 0.2 }]);
});

test('parseChoiceJSON: 코드블록·앞뒤 설명이 붙어도 읽고, 맨 배열과 {id: p} 객체도 받는다', () => {
  assert.deepEqual(parseChoiceJSON('```json\n{"answers":[{"id":"a","p":1}]}\n```'), [{ id: 'a', p: 1 }]);
  assert.deepEqual(parseChoiceJSON('[{"id":"b","p":0.5}]'), [{ id: 'b', p: 0.5 }]);
  assert.deepEqual(parseChoiceJSON('{"answers":{"a":0.6,"c":0.1}}'), [{ id: 'a', p: 0.6 }, { id: 'c', p: 0.1 }]);
});

test('parseChoiceJSON: 확률이 문자열·퍼센트여도 숫자로, 못 읽으면 null', () => {
  assert.deepEqual(parseChoiceJSON('{"answers":[{"id":"a","p":"80%"},{"id":"b","p":"0.1"}]}'), [{ id: 'a', p: 0.8 }, { id: 'b', p: 0.1 }]);
  assert.equal(parseChoiceJSON('모르겠어요'), null);
  assert.equal(parseChoiceJSON('{"foo":1}'), null);
});

// --- 정규화 ---
test('normalizeChoices: 목록 밖 id는 버리고(규칙 9) 빠진 선택지는 0, 높은 순', () => {
  const out = normalizeChoices([{ id: 'zzz', p: 0.9 }, { id: 'b', p: 0.4 }], choices3, { multi: true });
  assert.deepEqual(out, [{ id: 'b', p: 0.4 }, { id: 'a', p: 0 }, { id: 'c', p: 0 }]);
});

test('normalizeChoices: 다중 선택은 각 확률을 [0,1]로 자르고 합을 맞추지 않는다, 중복 id는 큰 값', () => {
  const out = normalizeChoices([{ id: 'a', p: 1.4 }, { id: 'b', p: -0.2 }, { id: 'c', p: 0.5 }, { id: 'c', p: 0.7 }], choices3, { multi: true });
  assert.deepEqual(out, [{ id: 'a', p: 1 }, { id: 'c', p: 0.7 }, { id: 'b', p: 0 }]);
});

test('normalizeChoices: 단일 선택은 합이 1이 되게 나눈다', () => {
  const out = normalizeChoices([{ id: 'a', p: 3 }, { id: 'b', p: 1 }], choices3, { multi: false });
  assert.deepEqual(out.map(x => x.id), ['a', 'b', 'c']);
  assert.ok(Math.abs(out[0].p - 0.75) < 1e-9 && Math.abs(out[1].p - 0.25) < 1e-9 && out[2].p === 0);
});

test('normalizeChoices: 확률이 모두 0이면 0 그대로(나누지 않는다), 숫자가 아니면 0', () => {
  const out = normalizeChoices([{ id: 'a', p: 'x' }], choices3, { multi: false });
  assert.ok(out.every(x => x.p === 0));
});

test('topChoice: 가장 높은 것, 모두 0이면 null', () => {
  assert.equal(topChoice([{ id: 'b', p: 0.4 }, { id: 'a', p: 0.1 }]), 'b');
  assert.equal(topChoice([{ id: 'a', p: 0 }]), null);
  assert.equal(topChoice([]), null);
});

// --- 선택지 ---
test('tagChoices: tags.json의 태그 순서·개수 그대로(개수를 가정하지 않음), id·label·desc', () => {
  const cs = tagChoices(tagsFile.tags);
  assert.equal(cs.length, tagsFile.tags.length);
  assert.deepEqual(cs.map(c => c.id), tagsFile.tags.map(t => t.id));
  assert.deepEqual(cs[0], { id: tagsFile.tags[0].id, label: tagsFile.tags[0].label, desc: tagsFile.tags[0].desc });
  // 그래프 객체({tags})를 넘겨도 같다
  assert.deepEqual(tagChoices({ tags: tagsFile.tags }), cs);
});

test('buildChoicePrompt: 모든 선택지 id가 들어가고, 다중/단일 안내가 다르다', () => {
  const cs = tagChoices(tagsFile.tags);
  const p = buildChoicePrompt({ text: '문장', question: TAG_QUESTION, choices: cs, multi: true });
  for (const c of cs) assert.ok(p.user.includes(c.id), c.id);
  assert.ok(p.user.includes('문장'));
  const single = buildChoicePrompt({ text: '문장', question: TAG_QUESTION, choices: cs, multi: false });
  assert.notEqual(p.system, single.system);
});

// --- 레지스트리 ---
test('레지스트리: gemini-choice와 jev가 있고 모두 클라우드(규칙 8), 모르는 id는 던진다', () => {
  assert.ok(JUDGES['gemini-choice'] && JUDGES.jev);
  for (const def of Object.values(JUDGES)) assert.equal(def.cloud, true);
  assert.equal(getJudge('gemini-choice'), JUDGES['gemini-choice']);
  assert.throws(() => getJudge('nope'), /알 수 없는 판정기/);
});

test('judgeFor: 환경변수에서 키·모델을 고른다(값은 그대로 넘길 뿐)', () => {
  const j = judgeFor('gemini-choice', { env: { GEMINI_API_KEY: 'k1' }, admin: { defaultModels: { gemini: 'g-x' } } });
  assert.equal(j.apiKey, 'k1');
  assert.equal(j.model, 'g-x');
  const jev = judgeFor('jev', { env: {} });
  assert.equal(jev.apiKey, '');
});

test('jev: 키가 없으면 "키가 필요해요", 키가 있어도 아직 미지원', async () => {
  const input = { text: 't', question: TAG_QUESTION, choices: choices3, multi: true };
  await assert.rejects(judge(judgeFor('jev', { env: {} }), input), /키가 필요해요/);
  await assert.rejects(judge(judgeFor('jev', { env: { JEV_API_KEY: 'x' } }), input), /아직 미지원/);
});

test('gemini-choice: providers.js 호출 경로로 JSON을 받아 정규화한다(가짜 fetch)', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const text = '{"answers":[{"id":"b","p":0.9},{"id":"ghost","p":0.8}]}';
    return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }) };
  });
  const out = await judge(judgeFor('gemini-choice', { env: { GEMINI_API_KEY: 'k' } }), { text: '문장', question: TAG_QUESTION, choices: choices3, multi: true });
  assert.deepEqual(out, [{ id: 'b', p: 0.9 }, { id: 'a', p: 0 }, { id: 'c', p: 0 }]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /generativelanguage/);
  assert.equal(calls[0].body.generationConfig.responseMimeType, 'application/json');
});

test('gemini-choice: 키가 없으면 제공자 오류 그대로, JSON이 아니면 판정 실패', async t => {
  await assert.rejects(judge(judgeFor('gemini-choice', { env: {} }), { text: 't', question: 'q', choices: choices3 }), /API 키가 없어요/);
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: '글로 답함' }] } }] }) }));
  await assert.rejects(judge(judgeFor('gemini-choice', { env: { GEMINI_API_KEY: 'k' } }), { text: 't', question: 'q', choices: choices3 }), /판정 응답을 읽지 못했어요/);
});

test('gemini-choice: 503은 providers.js 재시도를 탄다', async t => {
  const saved = { ...retryPolicy };
  Object.assign(retryPolicy, { delays: [0, 0], maxRetryAfterMs: 0 });
  t.after(() => Object.assign(retryPolicy, saved));
  const seq = [503, 200];
  t.mock.method(globalThis, 'fetch', async () => {
    const status = seq.shift();
    const body = status === 200 ? { candidates: [{ content: { parts: [{ text: '{"answers":[{"id":"a","p":1}]}' }] } }] } : { error: { message: 'high demand' } };
    return { ok: status < 400, status, headers: new Headers(), text: async () => JSON.stringify(body) };
  });
  const out = await judge(judgeFor('gemini-choice', { env: { GEMINI_API_KEY: 'k' } }), { text: 't', question: 'q', choices: choices3, multi: true });
  assert.equal(out[0].id, 'a');
});

// --- 점수 합치기 ---
test('combineTagSim: 기본(판정 없음)은 유사도 − 감점 그대로', () => {
  assert.equal(combineTagSim({ sim: 0.8, penalty: 0.03 }), 0.8 - 0.03);
  assert.equal(combineTagSim({ sim: 0.8, penalty: 0.03, p: 0.9, mode: null }), 0.8 - 0.03);
});

test('combineTagSim: 대신(replace)은 판정 확률만, 감점 없음 / 함께(combine)는 유사도 − 감점 + w·p', () => {
  assert.equal(combineTagSim({ sim: 0.8, penalty: 0.03, p: 0.6, mode: 'replace' }), 0.6);
  assert.equal(combineTagSim({ sim: 0.8, penalty: 0.03, p: undefined, mode: 'replace' }), 0);
  assert.ok(Math.abs(combineTagSim({ sim: 0.8, penalty: 0.03, p: 0.5, mode: 'combine', weight: 0.1 }) - (0.8 - 0.03 + 0.05)) < 1e-12);
  assert.equal(combineTagSim({ sim: 0.8, penalty: 0, p: undefined, mode: 'combine', weight: 0.1 }), 0.8);
});

// 노드 2개·태그 2개짜리 그래프: 임베딩은 t1 쪽, 판정은 t2 쪽
const g = {
  tags: [{ id: 't1', label: 'T1' }, { id: 't2', label: 'T2' }],
  nodes: [{ id: 'n1', label: 'N1', tags: ['t1'], facts: [] }, { id: 'n2', label: 'N2', tags: ['t2'], facts: [] }],
  edges: []
};
const vecs = new Map([['tag:t1', [1, 0]], ['tag:t2', [0.9, 0.436]], ['node:n1', [1, 0]], ['node:n2', [1, 0]]]);
const q = [1, 0];

test('retrieve: tagJudge가 없으면 결과가 이전과 같다', () => {
  const a = retrieve(q, g, vecs, { topK: 2 });
  const b = retrieve(q, g, vecs, { topK: 2, tagJudge: null });
  assert.deepEqual(a, b);
  assert.equal(a[0].id, 'n1');
});

test('retrieve: tagJudge replace는 판정 확률로 순위를 정하고, combine은 가산만 한다', () => {
  const p = { t2: 0.9, t1: 0.1 };
  assert.equal(retrieve(q, g, vecs, { topK: 2, tagJudge: { p, mode: 'replace' } })[0].id, 'n2');
  // 작은 가중치는 임베딩 순서를 못 뒤집고, 큰 가중치는 뒤집는다
  assert.equal(retrieve(q, g, vecs, { topK: 2, tagJudge: { p, mode: 'combine', weight: 0.01 } })[0].id, 'n1');
  assert.equal(retrieve(q, g, vecs, { topK: 2, tagJudge: { p, mode: 'combine', weight: 0.5 } })[0].id, 'n2');
  // 결과의 tag.sim은 임베딩 유사도 그대로
  const r = retrieve(q, g, vecs, { topK: 2, tagJudge: { p, mode: 'replace' } });
  assert.equal(r.find(x => x.id === 'n1').tag.sim, 1);
});

test('retrieve: tagJudge.p는 [{id,p}] 배열도 받는다', () => {
  const p = [{ id: 't2', p: 0.9 }, { id: 't1', p: 0.1 }];
  assert.equal(retrieve(q, g, vecs, { topK: 2, tagJudge: { p, mode: 'replace' } })[0].id, 'n2');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAnalogy, runAbstract } from '../../extension/lib/pipeline.js';
import { REJECTED_TEXT } from '../../extension/lib/analogy-server.js';
import { GROUNDING_REJECTED_TEXT } from '../../extension/lib/grounding.js';
import { demoAnswer, buildAnalogyPrompt, buildAbstractPrompt, rewriteQueryText } from '../../extension/lib/prompt.js';

// 공통 그래프(maplestory.json)의 실제 facts
const WEEKLY_BOSS = [
  '강한 보스 중 상당수는 일주일에 한 번만 보상을 받을 수 있다.',
  '보스를 잡으면 나오는 결정석(강렬한 힘의 결정)을 상점에 팔아 메소를 번다.',
  '한 주에 팔 수 있는 결정석 개수에는 상한이 있다.'
];
const GRAPH = {
  domain: '메이플스토리',
  analogyPrefix: '메이플로 치면',
  theme: 'maple',
  tags: [{ id: 'periodic-limit', label: '주기별 횟수 제한' }]
};
const CANDIDATES = [
  { id: 'weekly-boss', label: '주간 보스', facts: WEEKLY_BOSS, source: 'common', tag: { id: 'periodic-limit', label: '주기별 횟수 제한', sim: 0.8 }, neighbors: [{ id: 'meso', label: '메소' }], score: 0.9, direct: 0.7 },
  { id: 'meso', label: '메소', facts: ['게임 안의 기본 화폐다.'], source: 'common', tag: null, neighbors: [], score: 0.5, direct: 0.5 }
];
const SENTENCE = '이 적금은 한 달에 한 번만 납입할 수 있어요.';
const OK_ANSWER = {
  meaning: '한 달에 한 번만 돈을 넣을 수 있다는 뜻이에요.',
  analogy: '메이플로 치면 주간 보스처럼 정해진 주기마다 한 번만 보상을 받는 것과 같아요.',
  mapping: '납입 ↔ 주간 보스 보상',
  nodeId: 'weekly-boss',
  tagId: 'periodic-limit',
  usedFact: WEEKLY_BOSS[0]
};

// 가짜 ask: 호출을 기록하고, onText 가 있으면 조각으로 흘려 보낸 뒤 전체 문자열을 돌려준다
function fakeAsk(raw) {
  const calls = [];
  const ask = async (system, user, opts) => {
    calls.push({ system, user, opts });
    if (opts?.onText) {
      for (let i = 10; i < raw.length; i += 10) opts.onText(raw.slice(0, i));
      opts.onText(raw);
    }
    return raw;
  };
  return { ask, calls };
}

const base = over => ({
  sentence: SENTENCE, word: '납입', context: '', pageTitle: '적금 안내',
  graph: GRAPH, candidates: CANDIDATES, providerKind: 'gemini', ...over
});

test('정상: 후보 안 nodeId + facts 안 사실이면 chosen·analogy가 남는다', async () => {
  const { ask, calls } = fakeAsk(JSON.stringify(OK_ANSWER));
  const stages = [];
  const r = await runAnalogy(base({ ask, onStage: s => stages.push(s) }));
  assert.deepEqual(stages, ['generate']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.json, true);
  // 프롬프트는 기존 buildAnalogyPrompt 그대로
  const p = buildAnalogyPrompt({ sentence: SENTENCE, context: '', word: '납입', pageTitle: '적금 안내', domain: GRAPH.domain, analogyPrefix: GRAPH.analogyPrefix, candidates: CANDIDATES });
  assert.equal(calls[0].system, p.system);
  assert.equal(calls[0].user, p.user);
  assert.equal(r.chosen.id, 'weekly-boss');
  assert.equal(r.answer.analogy, OK_ANSWER.analogy);
  assert.equal(r.answer.rejected, undefined);
  assert.equal(r.rejected, null);
  assert.deepEqual(r.grounding, { ok: true });
  assert.deepEqual(r.evidence, { nodeId: 'weekly-boss', nodeLabel: '주간 보스', source: 'common', tagLabel: '주기별 횟수 제한' });
});

test('규칙 1: 후보 밖 nodeId면 비유를 지우고 규칙 1 문구', async () => {
  const { ask } = fakeAsk(JSON.stringify({ ...OK_ANSWER, nodeId: 'starforce' }));
  const r = await runAnalogy(base({ ask }));
  assert.equal(r.answer.analogy, '');
  assert.equal(r.answer.rejected, REJECTED_TEXT);
  assert.equal(r.rejected, REJECTED_TEXT);
  assert.equal(r.chosen, null);
  assert.equal(r.grounding, null);
  assert.equal(r.evidence, null);
  assert.equal(r.answer.meaning, OK_ANSWER.meaning); // 뜻은 남는다
});

test('근거 검사: facts 밖 숫자면 비유를 지우고 근거 문구, chosen도 비운다', async () => {
  const { ask } = fakeAsk(JSON.stringify({ ...OK_ANSWER, analogy: '메이플로 치면 주간 보스를 일주일에 7번만 잡는 것과 같아요.' }));
  const r = await runAnalogy(base({ ask }));
  assert.equal(r.answer.analogy, '');
  assert.equal(r.rejected, GROUNDING_REJECTED_TEXT);
  assert.equal(r.chosen, null);
  assert.deepEqual(r.grounding, { ok: false, reason: 'number-outside' });
  assert.equal(r.evidence, null);
});

test('근거 검사: 이웃 label의 숫자는 허용한다', async () => {
  const cands = [{ ...CANDIDATES[0], neighbors: [{ id: 'x', label: '5차 전직' }] }];
  const { ask } = fakeAsk(JSON.stringify({ ...OK_ANSWER, analogy: '메이플로 치면 5차 전직 뒤 주간 보스 보상처럼요.' }));
  const r = await runAnalogy(base({ ask, candidates: cands }));
  assert.deepEqual(r.grounding, { ok: true });
  assert.equal(r.chosen.id, 'weekly-boss');
});

test('데모 제공자: LLM을 부르지 않고 demoAnswer 결과', async () => {
  let called = false;
  const r = await runAnalogy(base({ providerKind: 'demo', ask: async () => { called = true; return ''; } }));
  assert.equal(called, false);
  const expected = demoAnswer({ candidates: CANDIDATES, analogyPrefix: GRAPH.analogyPrefix });
  assert.deepEqual(r.answer, expected);
  assert.equal(r.chosen.id, 'weekly-boss');
  assert.deepEqual(r.grounding, { ok: true });
});

test('JSON이 아니면 지금과 같은 오류', async () => {
  const raw = '죄송해요, 답을 만들 수 없어요.';
  const { ask } = fakeAsk(raw);
  await assert.rejects(runAnalogy(base({ ask })), { message: '모델 응답을 해석하지 못했어요: ' + raw.slice(0, 120) });
});

test('onPartial: 스트리밍 중 뜻이 완성되면 meaning만 한 번 보낸다', async () => {
  const { ask } = fakeAsk(JSON.stringify(OK_ANSWER));
  const partials = [];
  const r = await runAnalogy(base({ ask, onPartial: p => partials.push(p) }));
  assert.deepEqual(partials, [{ meaning: OK_ANSWER.meaning }]);
  assert.equal(r.answer.analogy, OK_ANSWER.analogy);
});

test('onPartial이 없으면 onText도 넘기지 않는다', async () => {
  const { ask, calls } = fakeAsk(JSON.stringify(OK_ANSWER));
  await runAnalogy(base({ ask }));
  assert.ok(!calls[0].opts.onText);
});

test('runAbstract: 추상화 프롬프트로 한 번 부르고 질의 문장을 만든다', async () => {
  const { ask, calls } = fakeAsk('  주기마다 한 번만 허용되는 제한  ');
  const stages = [];
  const r = await runAbstract({ sentence: SENTENCE, word: '납입', pageTitle: '적금 안내', ask, onStage: s => stages.push(s) });
  assert.deepEqual(stages, ['abstract']);
  const p = buildAbstractPrompt({ sentence: SENTENCE, word: '납입', pageTitle: '적금 안내' });
  assert.equal(calls[0].system, p.system);
  assert.equal(calls[0].user, p.user);
  assert.equal(calls[0].opts.json, false);
  assert.equal(r.abstractText, '주기마다 한 번만 허용되는 제한');
  assert.equal(r.queryText, rewriteQueryText('주기마다 한 번만 허용되는 제한', SENTENCE));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildJudgePrompt, parseJudge, summarize, assertDifferentModels, modelKey, evalLogRow } from '../../tools/eval-gen-lib.mjs';

const candidates = [
  { id: 'starforce', label: '스타포스 강화', facts: ['강화에 실패하면 장비가 파괴될 수 있다.', '단계가 오를수록 비용이 커진다.'] },
  { id: 'meso', label: '메소', facts: ['메소는 게임 안의 화폐다.'] }
];

test('buildJudgePrompt: 문장·고른 노드 facts·다른 후보·비유를 모두 넣고 JSON 형식을 요구한다', () => {
  const p = buildJudgePrompt({
    sentence: '레버리지는 이익과 손실을 모두 키운다.',
    candidates,
    chosen: candidates[0],
    analogy: '스타포스 강화처럼 잘되면 크게 오르지만 실패하면 장비가 터져요.'
  });
  assert.equal(typeof p.system, 'string');
  assert.equal(typeof p.user, 'string');
  assert.match(p.user, /레버리지는 이익과 손실을 모두 키운다/);
  assert.match(p.user, /강화에 실패하면 장비가 파괴될 수 있다/);
  assert.match(p.user, /메소는 게임 안의 화폐다/);
  assert.match(p.user, /스타포스 강화처럼/);
  assert.match(p.user, /starforce/);
  for (const k of ['grounded', 'structure', 'natural', 'reason']) assert.match(p.system + p.user, new RegExp(k));
});

test('buildJudgePrompt: 고른 노드가 없으면 그렇다고 적는다', () => {
  const p = buildJudgePrompt({ sentence: '문장', candidates, chosen: null, analogy: '비유' });
  assert.match(p.user, /고른 개념: 없음/);
});

test('parseJudge: 정상 JSON과 코드블록을 읽는다', () => {
  assert.deepEqual(parseJudge('{"grounded": true, "structure": 4, "natural": 5, "reason": "좋음"}'),
    { grounded: true, structure: 4, natural: 5, reason: '좋음' });
  assert.deepEqual(parseJudge('```json\n{"grounded": false, "structure": 2, "natural": 3, "reason": "없는 사실"}\n```'),
    { grounded: false, structure: 2, natural: 3, reason: '없는 사실' });
  // reason 이 없으면 빈 문자열
  assert.deepEqual(parseJudge('{"grounded": true, "structure": 1, "natural": 1}'),
    { grounded: true, structure: 1, natural: 1, reason: '' });
});

test('parseJudge: 범위 밖·형식 틀림은 null', () => {
  assert.equal(parseJudge('{"grounded": true, "structure": 0, "natural": 3}'), null);
  assert.equal(parseJudge('{"grounded": true, "structure": 6, "natural": 3}'), null);
  assert.equal(parseJudge('{"grounded": true, "structure": 3.5, "natural": 3}'), null);
  assert.equal(parseJudge('{"grounded": "yes", "structure": 3, "natural": 3}'), null);
  assert.equal(parseJudge('{"grounded": true, "structure": 3}'), null);
  assert.equal(parseJudge('채점할 수 없어요'), null);
  assert.equal(parseJudge(''), null);
});

const row = (sentence, analogy, judge, extra = {}) => ({ sentence, answer: { meaning: '뜻', analogy, nodeId: 'starforce', usedFact: '' }, judge, ...extra });

test('summarize: 숨김은 채점에서 빼고 따로 세며, 평균·위반·약한 사례를 낸다', () => {
  const rows = [
    row('가', '비유1', { grounded: true, structure: 5, natural: 4, reason: '' }),
    row('나', '비유2', { grounded: false, structure: 4, natural: 4, reason: '없는 사실' }),
    row('다', '비유3', { grounded: true, structure: 2, natural: 3, reason: '구조 다름' }),
    row('라', '', null, { rejected: '근거 밖이라 숨겼어요' }),
    row('마', '', null)
  ];
  const s = summarize(rows);
  assert.equal(s.n, 5);
  assert.equal(s.hidden, 2);
  assert.equal(s.judged, 3);
  assert.equal(s.groundedRate, 2 / 3);
  assert.equal(s.structureAvg, 11 / 3);
  assert.equal(s.naturalAvg, 11 / 3);
  assert.deepEqual(s.violations.map(v => v.sentence), ['나']);
  assert.equal(s.violations[0].reason, '없는 사실');
  assert.deepEqual(s.weak.map(v => v.sentence), ['다']);
});

test('summarize: 생성 실패·채점 실패는 따로 세고 평균에 넣지 않는다', () => {
  const rows = [
    row('가', '비유1', { grounded: true, structure: 4, natural: 4, reason: '' }),
    { sentence: '나', error: '모델 응답을 해석하지 못했어요: x' },
    row('다', '비유3', null, { judgeError: '채점 응답을 해석하지 못했어요' }),
    row('라', '비유4', undefined) // 채점 안 함
  ];
  const s = summarize(rows);
  assert.equal(s.n, 4);
  assert.equal(s.errors, 1);
  assert.equal(s.hidden, 0);
  assert.equal(s.judged, 1);
  assert.equal(s.unjudged, 2);
  assert.equal(s.groundedRate, 1);
  assert.equal(s.structureAvg, 4);
});

test('summarize: 채점한 것이 없으면 지표는 null', () => {
  const s = summarize([row('가', '', null)]);
  assert.equal(s.hidden, 1);
  assert.equal(s.groundedRate, null);
  assert.equal(s.structureAvg, null);
  assert.equal(s.naturalAvg, null);
  assert.deepEqual(s.violations, []);
});

test('assertDifferentModels: 같은 제공자·모델이면 예외, 다르면 통과', () => {
  assert.throws(() => assertDifferentModels({ id: 'gemini', model: 'gemini-3.8-flash' }, { id: 'gemini', model: 'gemini-3.8-flash' }), /채점 모델/);
  assert.throws(() => assertDifferentModels('gemini/gemini-3.8-flash', { provider: 'gemini', model: 'gemini-3.8-flash' }), /채점 모델/);
  assert.doesNotThrow(() => assertDifferentModels({ id: 'gemini', model: 'gemini-3.5-flash-lite' }, { id: 'gemini', model: 'gemini-3.8-flash' }));
  assert.doesNotThrow(() => assertDifferentModels({ id: 'nvidia', model: 'gemini-3.8-flash' }, { id: 'gemini', model: 'gemini-3.8-flash' }));
});

test('modelKey: 객체·문자열을 "제공자/모델"로', () => {
  assert.equal(modelKey({ id: 'groq', model: 'openai/gpt-oss-120b' }), 'groq/openai/gpt-oss-120b');
  assert.equal(modelKey({ provider: 'gemini', model: 'g' }), 'gemini/g');
  assert.equal(modelKey('nvidia/x'), 'nvidia/x');
});

test('evalLogRow: 생성·채점 모델, 문장 수, 세 지표가 든 표 한 줄', () => {
  const s = summarize([
    row('가', '비유1', { grounded: true, structure: 5, natural: 4, reason: '' }),
    row('나', '', null)
  ]);
  const line = evalLogRow(s, { date: '2026-11-08', gen: ['gemini/gemini-3.5-flash-lite'], judge: 'gemini/gemini-3.8-flash' });
  assert.match(line, /^\| 2026-11-08 \|/);
  assert.match(line, /gemini\/gemini-3\.5-flash-lite/);
  assert.match(line, /gemini\/gemini-3\.8-flash/);
  assert.match(line, /근거 준수 1\/1 \(100%\)/);
  assert.match(line, /구조 5\.00/);
  assert.match(line, /자연스러움 4\.00/);
  assert.match(line, /숨김 1/);
  assert.match(line, /\|$/);
});

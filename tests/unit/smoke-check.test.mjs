// 스모크 "비유 생성" 판정(T-188): 무엇을 실패로 세고 무엇을 보고만 하는지
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generationVerdict } from '../../tools/smoke-check.mjs';

const base = { ok: true, answer: { meaning: '뜻이에요.', analogy: '' }, nodeId: null, rule1: true, ending: { ok: true, retried: false, issues: [] } };

test('정상: 비유 없음(nodeId null, analogy 빈 값)은 통과', () => {
  assert.deepEqual(generationVerdict(base), { problem: null, note: null });
});

test('호출 오류·meaning 없음·끝맺음 실패는 실패', () => {
  assert.equal(generationVerdict({ ok: false, error: '503 high demand' }).problem, '503 high demand');
  assert.equal(generationVerdict({ ...base, answer: { meaning: '' } }).problem, 'meaning 없음');
  const ending = { ok: false, retried: true, issues: [{ field: 'meaning', style: 'formal' }] };
  assert.match(generationVerdict({ ...base, ending }).problem, /존댓말 아님: meaning\(formal\)/);
});

test('후보 밖 nodeId(지어낸 id)는 규칙 1 실패', () => {
  const v = generationVerdict({ ...base, nodeId: 'b', rule1: false });
  assert.equal(v.problem, '후보에 없는 nodeId: b');
});

// run 45012155475: Groq가 맞는 후보가 없다고 nodeId null을 냈지만 analogy 글을 남겼다. 규칙 1이 숨겨
// 사용자에게는 "비유 없음"과 똑같이 보인다. 근거 밖 비유가 새지 않았으니 실패가 아니라 보고만 한다
test('nodeId null인데 analogy를 남긴 답은 실패가 아니라 참고(규칙 1이 숨김)', () => {
  const v = generationVerdict({ ...base, nodeId: null, rule1: false });
  assert.equal(v.problem, null);
  assert.match(v.note, /nodeId null/);
});

test('끝맺음 검사는 규칙 1 참고보다 먼저 실패로 센다', () => {
  const ending = { ok: false, retried: true, issues: [{ field: 'meaning', style: 'plain' }] };
  assert.match(generationVerdict({ ...base, rule1: false, ending }).problem, /존댓말 아님/);
});

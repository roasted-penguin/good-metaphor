// 에이전트 루프(T-216, ADR 0017): JSON 액션 ReAct, 단계·호출 상한, 반복 감지, 형식 재시도, 하루 상한, debug.trace
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAction, actionKey, runAgent, takeDailyCall, AGENT_MAX_STEPS, AGENT_MAX_CALLS, LAST_NOTE, REPEAT_NOTE } from '../../extension/lib/agent.js';

// 답 목록을 차례로 돌려주는 가짜 ask. 다 쓰면 마지막 답을 되풀이한다
function scripted(answers) {
  const calls = [];
  const ask = async (system, user, opts) => {
    calls.push({ system, user, opts });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (a instanceof Error) throw a;
    return typeof a === 'string' ? a : JSON.stringify(a);
  };
  return { ask, calls };
}
const echoTools = {
  get_node_facts: { run: async ({ nodeId }) => ({ id: nodeId, facts: [`${nodeId} 사실`] }) },
  boom: { run: async () => { throw new Error('도구 고장'); } }
};

test('parseAction: action·final·코드블록·앞뒤 설명, 형식 밖은 null', () => {
  assert.deepEqual(parseAction('{"action":"get_node_facts","args":{"nodeId":"a"}}'), { type: 'action', name: 'get_node_facts', args: { nodeId: 'a' } });
  assert.deepEqual(parseAction('생각해 볼게요\n```json\n{"final":{"answer":"좋아요"}}\n```'), { type: 'final', final: { answer: '좋아요' } });
  assert.deepEqual(parseAction('{"action":"search_graph"}'), { type: 'action', name: 'search_graph', args: {} }, 'args 없으면 빈 객체');
  assert.equal(parseAction('그냥 글이에요'), null);
  assert.equal(parseAction('{"action":"", "args":{}}'), null, '빈 도구 이름');
  assert.equal(parseAction('{"action":"x","args":[1]}'), null, 'args는 객체');
  assert.equal(parseAction('{"final":3}'), null, 'final은 객체나 글');
  assert.equal(parseAction('{"note":"형식 밖"}'), null);
});

test('parseAction: 제공자마다 실제로 본 변형도 읽는다(T-222)', () => {
  const F = { answer: '같아요.', nodeId: 'cube', usedFact: '사실' };
  // NVIDIA Nemotron: final을 도구처럼
  assert.deepEqual(parseAction(JSON.stringify({ action: 'final', args: { final: F } })), { type: 'final', final: F });
  assert.deepEqual(parseAction(JSON.stringify({ action: 'final', args: F })), { type: 'final', final: F });
  // Groq gpt-oss: final 감싸기 없이
  assert.deepEqual(parseAction(JSON.stringify(F)), { type: 'final', final: F });
  // 고유 함수 호출 모양(failed_generation·tool_calls): name·arguments, arguments가 JSON 글자여도
  assert.deepEqual(parseAction('{"name":"get_node_facts","arguments":{"nodeId":"cube"}}'), { type: 'action', name: 'get_node_facts', args: { nodeId: 'cube' } });
  assert.deepEqual(parseAction(JSON.stringify({ name: 'search_graph', arguments: '{"text":"a"}' })), { type: 'action', name: 'search_graph', args: { text: 'a' } });
  // args 없이 인자를 펼침
  assert.deepEqual(parseAction('{"action":"get_node_facts","nodeId":"cube"}'), { type: 'action', name: 'get_node_facts', args: { nodeId: 'cube' } });
  // 객체 둘을 이어 붙임 → 앞의 것
  assert.deepEqual(parseAction('{"action":"search_graph","args":{"text":"a}"}}\n{"final":{"answer":"b"}}'), { type: 'action', name: 'search_graph', args: { text: 'a}' } });
  // final이 글자뿐이면 개념 없는 답
  assert.deepEqual(parseAction('{"final":"없어요."}'), { type: 'final', final: { answer: '없어요.', nodeId: null, usedFact: '' } });
  assert.equal(parseAction('{"action":"final","args":{"x":1}}'), null, 'final인데 answer 없음');
  assert.equal(parseAction('{"name":"get_node_facts","arguments":"{깨짐"}'), null, '읽히지 않는 arguments');
});

test('actionKey: 인자 키 순서가 달라도 같은 키', () => {
  assert.equal(actionKey('t', { a: 1, b: [2, 3] }), actionKey('t', { b: [2, 3], a: 1 }));
  assert.notEqual(actionKey('t', { a: 1 }), actionKey('t', { a: 2 }));
});

test('runAgent: 도구 → 관찰 → final, 관찰이 다음 요청에 붙고 trace에 도구·인자·지연', async () => {
  const { ask, calls } = scripted([
    { action: 'get_node_facts', args: { nodeId: 'starforce' } },
    { final: { answer: '같은 구조예요.', nodeId: 'starforce' } }
  ]);
  const r = await runAgent({ system: 'S', user: 'U', tools: echoTools, ask });
  assert.deepEqual(r.final, { answer: '같은 구조예요.', nodeId: 'starforce' });
  assert.equal(r.stop, null);
  assert.equal(r.calls, 2);
  assert.equal(calls[0].opts.json, true);
  assert.ok(!calls[0].user.includes('[지금까지]'));
  assert.match(calls[1].user, /\[지금까지\]/);
  assert.match(calls[1].user, /starforce 사실/, '관찰이 다음 요청에');
  assert.equal(r.trace[0].type, 'action');
  assert.equal(r.trace[0].tool, 'get_node_facts');
  assert.match(r.trace[0].args, /starforce/);
  assert.equal(typeof r.trace[0].ms, 'number');
  assert.equal(r.trace.at(-1).type, 'final');
  assert.deepEqual(r.observations, [{ tool: 'get_node_facts', args: { nodeId: 'starforce' }, result: { id: 'starforce', facts: ['starforce 사실'] } }]);
});

test('runAgent: 형식이 틀리면 한 번 다시 묻고(교정 문구), 또 틀리면 format으로 멈춘다', async () => {
  const once = scripted(['글로만 답했어요', { final: { answer: '됐어요' } }]);
  const ok = await runAgent({ system: 'S', user: 'U', tools: echoTools, ask: once.ask });
  assert.deepEqual(ok.final, { answer: '됐어요' });
  assert.match(once.calls[1].user, /형식/);

  const twice = scripted(['글', '또 글', { final: { answer: '안 닿음' } }]);
  const bad = await runAgent({ system: 'S', user: 'U', tools: echoTools, ask: twice.ask });
  assert.equal(bad.final, null);
  assert.equal(bad.stop, 'format');
  assert.equal(twice.calls.length, 2);
});

test('runAgent: 같은 도구·같은 인자를 계속 부르면 두 번째 반복에서 멈춘다(repeat), 도구는 한 번만 돈다', async () => {
  let runs = 0;
  const tools = { get_node_facts: { run: async () => { runs++; return { ok: 1 }; } } };
  const { ask } = scripted([{ action: 'get_node_facts', args: { nodeId: 'a' } }]);
  const r = await runAgent({ system: 'S', user: 'U', tools, ask });
  assert.equal(r.stop, 'repeat');
  assert.equal(runs, 1);
  assert.equal(r.final, null);
});

test('runAgent: 반복 한 번은 [반복] 관찰을 붙여 이어 가고, 그다음 final이면 끝난다(T-222)', async () => {
  let runs = 0;
  const tools = { get_node_facts: { run: async () => { runs++; return { ok: 1 }; } } };
  const { ask, calls } = scripted([
    { action: 'get_node_facts', args: { nodeId: 'a' } },
    { action: 'get_node_facts', args: { nodeId: 'a' } },
    { final: { answer: '끝이에요.' } }
  ]);
  const r = await runAgent({ system: 'S', user: 'U', tools, ask });
  assert.equal(r.stop, null);
  assert.deepEqual(r.final, { answer: '끝이에요.' });
  assert.equal(runs, 1, '반복은 도구를 다시 돌리지 않는다');
  assert.ok(calls[2].user.includes(REPEAT_NOTE));
  assert.deepEqual(r.trace.map(t => t.error || t.type), ['action', '반복', 'final']);
});

test('runAgent: 남은 차례가 하나면 [마지막 차례] 문구, 그 전에는 없음, 제공자에 JSON 객체 모드를 청한다(T-222)', async () => {
  const { ask, calls } = scripted([
    { action: 'get_node_facts', args: { nodeId: 'a' } },
    { action: 'get_node_facts', args: { nodeId: 'b' } },
    { final: { answer: '끝이에요.' } }
  ]);
  const r = await runAgent({ system: 'S', user: 'U', tools: echoTools, ask, maxSteps: 3 });
  assert.equal(r.stop, null);
  assert.ok(!calls[0].user.includes(LAST_NOTE) && !calls[1].user.includes(LAST_NOTE));
  assert.ok(calls[2].user.endsWith(LAST_NOTE));
  assert.equal(calls[0].opts.jsonObject, true);
  // 호출 상한이 먼저 닿는 경우도
  const c2 = scripted([{ action: 'get_node_facts', args: { nodeId: 'a' } }, { final: { answer: '끝' } }]);
  await runAgent({ system: 'S', user: 'U', tools: echoTools, ask: c2.ask, maxCalls: 2 });
  assert.ok(c2.calls[1].user.endsWith(LAST_NOTE));
});

test('runAgent verify: 남은 단계·호출 수를 받는다(T-222)', async () => {
  const seen = [];
  const { ask } = scripted([{ action: 'get_node_facts', args: { nodeId: 'a' } }, { final: { answer: '끝' } }]);
  await runAgent({ system: 'S', user: 'U', tools: echoTools, ask, maxSteps: 4, maxCalls: 3, verify: async (f, left) => { seen.push(left); return { ok: true }; } });
  assert.deepEqual(seen, [{ stepsLeft: 2, callsLeft: 1 }]);
});

test('runAgent: 단계 상한(기본 4) → steps, 호출 상한 → calls', async () => {
  assert.equal(AGENT_MAX_STEPS, 4);
  assert.equal(AGENT_MAX_CALLS, 4);
  let i = 0;
  const tools = { get_node_facts: { run: async () => ({}) } };
  const ask = async () => JSON.stringify({ action: 'get_node_facts', args: { nodeId: 'n' + i++ } });
  const r = await runAgent({ system: 'S', user: 'U', tools, ask, maxCalls: 10 });
  assert.equal(r.stop, 'steps');
  assert.equal(r.steps, 4);

  // 형식 재시도로 호출이 단계보다 빨리 닿는 경우
  let j = 0;
  const ask2 = async () => (j++ % 2 === 0 ? '글' : JSON.stringify({ action: 'get_node_facts', args: { nodeId: 'm' + j } }));
  const r2 = await runAgent({ system: 'S', user: 'U', tools, ask: ask2, maxCalls: 3, maxSteps: 10 });
  assert.equal(r2.stop, 'calls');
  assert.equal(r2.calls, 3);
});

test('runAgent: 모르는 도구·도구 오류는 관찰(error)로 돌려주고 이어 간다', async () => {
  const { ask, calls } = scripted([
    { action: 'delete_everything', args: {} },
    { action: 'boom', args: {} },
    { final: { answer: '끝' } }
  ]);
  const r = await runAgent({ system: 'S', user: 'U', tools: echoTools, ask });
  assert.deepEqual(r.final, { answer: '끝' });
  assert.match(calls[1].user, /모르는 도구/);
  assert.match(calls[2].user, /도구 고장/);
  assert.equal(r.trace[0].error, '모르는 도구');
});

test('runAgent: ask가 던지면(체인 소진) llm-error로 멈추고 지금까지 관찰은 남는다', async () => {
  const { ask } = scripted([{ action: 'get_node_facts', args: { nodeId: 'a' } }, new Error('429 전부')]);
  const r = await runAgent({ system: 'S', user: 'U', tools: echoTools, ask });
  assert.equal(r.stop, 'llm-error');
  assert.match(r.error, /429/);
  assert.equal(r.observations.length, 1);
});

test('runAgent: 하루 상한(budget.take false)이면 LLM을 부르지 않고 daily-cap', async () => {
  const { ask, calls } = scripted([{ action: 'get_node_facts', args: { nodeId: 'a' } }, { final: { answer: '끝' } }]);
  const none = await runAgent({ system: 'S', user: 'U', tools: echoTools, ask, budget: { take: async () => false } });
  assert.equal(none.stop, 'daily-cap');
  assert.equal(calls.length, 0);

  let left = 1;
  const mid = await runAgent({ system: 'S', user: 'U', tools: echoTools, ask, budget: { take: async () => left-- > 0 } });
  assert.equal(mid.stop, 'daily-cap', '중간에 닿으면 멈춤');
  assert.equal(mid.calls, 1);
});

test('takeDailyCall: 같은 날은 늘리고 상한이면 거절, 날이 바뀌면 처음부터, 상한 0은 꺼짐', () => {
  let r = takeDailyCall(null, '2026-11-28', 2);
  assert.deepEqual(r, { ok: true, state: { day: '2026-11-28', count: 1 } });
  r = takeDailyCall(r.state, '2026-11-28', 2);
  assert.equal(r.ok, true);
  assert.equal(r.state.count, 2);
  const full = takeDailyCall(r.state, '2026-11-28', 2);
  assert.equal(full.ok, false);
  assert.equal(full.state.count, 2);
  assert.deepEqual(takeDailyCall(full.state, '2026-11-29', 2), { ok: true, state: { day: '2026-11-29', count: 1 } });
  assert.equal(takeDailyCall(null, '2026-11-28', 0).ok, false);
});

// 검증기 훅(T-220, ADR 0017 에이전트 3: Reflexion식). final이 검증에 지면 실패 이유를 관찰로 붙여 다시 묻는다
test('runAgent verify: 통과하면 final, trace에 verify(ok)', async () => {
  const { ask } = scripted([{ final: { answer: '좋아요' } }]);
  const r = await runAgent({ system: 'S', user: 'U', ask, verify: async f => ({ ok: true, value: { ...f, checked: true } }) });
  assert.equal(r.stop, null);
  assert.deepEqual(r.final, { answer: '좋아요' });
  assert.deepEqual(r.verified.value, { answer: '좋아요', checked: true });
  assert.deepEqual(r.trace.map(t => t.type), ['final', 'verify']);
  assert.equal(r.trace[1].ok, true);
});

test('runAgent verify: 실패 이유가 다음 요청에 붙고, 고친 final이 통과하면 끝', async () => {
  const { ask, calls } = scripted([{ final: { answer: '틀림' } }, { final: { answer: '고침' } }]);
  const verify = async f => (f.answer === '고침' ? { ok: true } : { ok: false, reason: 'rule1', feedback: '후보에 없는 개념이에요.' });
  const r = await runAgent({ system: 'S', user: 'U', ask, verify });
  assert.equal(r.stop, null);
  assert.equal(r.final.answer, '고침');
  assert.equal(r.calls, 2);
  assert.match(calls[1].user, /\[검증 실패\] 후보에 없는 개념이에요\./);
  assert.match(calls[1].user, /틀림/, '실패한 답도 기록에');
  assert.deepEqual(r.trace.filter(t => t.type === 'verify').map(t => [t.ok, t.reason ?? null]), [[false, 'rule1'], [true, null]]);
});

test('runAgent verify: 시도 상한(maxVerifies)이면 verify로 멈추고 마지막 final·검증 결과를 돌려준다', async () => {
  const { ask } = scripted([{ final: { answer: '틀림' } }]);
  const r = await runAgent({ system: 'S', user: 'U', ask, maxVerifies: 2, verify: async () => ({ ok: false, reason: 'grounding', feedback: '근거 밖' }) });
  assert.equal(r.stop, 'verify');
  assert.equal(r.final, null);
  assert.equal(r.calls, 2);
  assert.deepEqual(r.lastFinal, { answer: '틀림' });
  assert.equal(r.verified.reason, 'grounding');
  assert.equal(r.trace.at(-1).reason, 'verify');
});

test('runAgent verify: 검증 실패 재시도도 호출 상한 안', async () => {
  const { ask } = scripted([{ final: { answer: '틀림' } }]);
  const r = await runAgent({ system: 'S', user: 'U', ask, maxCalls: 1, maxVerifies: 3, verify: async () => ({ ok: false, feedback: 'x' }) });
  assert.equal(r.stop, 'calls');
  assert.equal(r.calls, 1);
  assert.deepEqual(r.lastFinal, { answer: '틀림' });
});

// 제품 안 에이전트 루프(T-216, ADR 0017 공통 설계). JSON 액션 ReAct.
// 매 차례 LLM은 {"action": "<도구>", "args": {...}} 또는 {"final": {...}} 하나만 답한다.
// 도구 결과를 관찰로 붙여 다음 차례를 부르고, final이 나오거나 상한에 닿으면 끝난다.
// chrome.* 를 쓰지 않는 순수 모듈이다. LLM 호출(ask)·도구·하루 상한(budget)은 모두 주입받는다(pipeline.js runAnalogy처럼).
// 제공자 고유 function calling을 쓰지 않는다: ask는 providers.js complete()와 fallback 체인(ADR 0008) 그대로다(규칙 7).
import { parseJSONLoose } from './providers.js';

export const AGENT_MAX_STEPS = 4;
export const AGENT_MAX_CALLS = 4;
export const AGENT_STOP_TEXT = '여기까지 했어요.';
export const AGENT_CAP_TEXT = '오늘 이어 묻기를 다 썼어요. 내일 다시 물어봐 주세요.';

// 관찰 하나를 프롬프트에 붙일 때의 글자 상한(긴 검색 결과가 요청을 키우지 않게)
const OBS_MAX = 2500;
// trace에 남길 인자 요약 글자 상한
const ARGS_MAX = 80;

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

// 도구 인자: 객체면 그대로, JSON 글자면 읽는다(고유 함수 호출 모양의 arguments). 그 밖이면 null
function argsOf(v) {
  if (v == null) return {};
  if (typeof v === 'string') { try { v = JSON.parse(v || '{}'); } catch { return null; } }
  return isObj(v) ? v : null;
}
// final 값: 객체는 그대로, 글자만 왔으면 개념 없는 답으로 본다
function finalOf(v) {
  if (isObj(v)) return v;
  if (typeof v === 'string' && v.trim()) return { answer: v, nodeId: null, usedFact: '' };
  return null;
}

/**
 * 답 → { type: 'action', name, args } | { type: 'final', final } | null(형식 밖).
 * 정한 모양 밖에서 제공자마다 실제로 본 변형도 받는다(T-222 스모크·평가 원문):
 * - {"action": "final", "args": {"final": {...}}} 또는 args가 곧 final (NVIDIA Nemotron)
 * - final 감싸기 없는 {"answer", "nodeId", "usedFact"} (Groq gpt-oss)
 * - 고유 함수 호출 모양 {"name", "arguments"} (Groq failed_generation·tool_calls), args 없이 인자를 펼친 {"action", "nodeId"}
 * - JSON 뒤에 다른 객체가 이어 붙은 글(parseJSONLoose가 첫 객체를 고른다)
 */
export function parseAction(text) {
  const j = parseJSONLoose(text);
  if (!isObj(j)) return null;
  if ('final' in j) { const f = finalOf(j.final); return f ? { type: 'final', final: f } : null; }
  const name = typeof j.action === 'string' ? j.action.trim() : typeof j.name === 'string' && !('answer' in j) ? j.name.trim() : '';
  if (name === 'final') {
    const a = argsOf(j.args ?? j.arguments);
    const f = a ? finalOf('final' in a ? a.final : a) : null;
    return f && (typeof f.answer === 'string') ? { type: 'final', final: f } : null;
  }
  if (name) {
    const { action, name: _n, args: rawArgs, arguments: rawArguments, ...rest } = j;
    const given = rawArgs ?? rawArguments;
    const args = given === undefined ? rest : argsOf(given);
    if (!args) return null;
    return { type: 'action', name, args };
  }
  if (typeof j.answer === 'string') return { type: 'final', final: j };
  return null;
}

// 키 순서와 상관없는 직렬화(반복 감지용)
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
export const actionKey = (name, args) => `${name}|${stable(args)}`;

const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

// 하루 호출 상한(사용자 결정 2026-11-28: 호버 체인 한도와 분리). state = { day, count } | null.
// 날이 바뀌면 처음부터 센다. cap이 0 이하면 꺼짐(늘 거절). 돌려주는 state를 부르는 쪽이 저장한다
export function takeDailyCall(state, day, cap) {
  const count = state?.day === day ? state.count || 0 : 0;
  const base = { day, count };
  if (!(cap > 0) || count >= cap) return { ok: false, state: base };
  return { ok: true, state: { day, count: count + 1 } };
}

const FORMAT_NOTE = '\n\n[형식 오류] 앞 답은 정한 JSON이 아니었어요. 함수 호출 기능을 쓰지 말고, {"action": "<도구 이름>", "args": {...}} 또는 {"final": {...}} 객체 하나만 글자로 출력한다.';
// 남은 차례가 하나뿐일 때 붙이는 문구(T-222: 끝까지 도구만 부르다 단계 상한에 닿는 일을 줄인다)
export const LAST_NOTE = '\n\n[마지막 차례] 이번이 마지막이다. 도구를 부르지 말고 지금까지 결과로 {"final": {...}}을 낸다. 맞는 개념이 없으면 nodeId는 null이다.';
// 같은 도구·같은 인자를 처음 되풀이했을 때의 관찰(두 번째면 멈춘다)
export const REPEAT_NOTE = '[반복] 이미 같은 인자로 불렀어요. 위 결과를 다시 보고 다른 도구를 부르거나 final을 낸다.';

/**
 * 루프를 돈다.
 * - system·user: 시작 프롬프트. user 뒤에 [지금까지] 행동·결과를 붙여 다음 차례를 부른다(ask는 문자열 한 쌍만 받는다).
 * - tools: { 이름: { run: async args => 관찰 } }. 모르는 도구·도구 오류는 관찰 { error }로 돌려주고 이어 간다.
 * - ask(system, user, { json: true }) → 응답 문자열. 던지면(체인 소진 등) 'llm-error'로 멈춘다.
 * - budget: { take: async () => bool } (선택). LLM 호출마다 먼저 부르고, false면 'daily-cap'으로 멈춘다.
 * - 형식이 틀리면 한 번 다시 묻고(교정 문구), 또 틀리면 'format'으로 멈춘다. 다시 묻기도 호출 상한에 든다.
 * - 같은 도구를 같은 인자로 다시 부르면 도구는 돌리지 않고 "[반복]" 관찰을 붙여 이어 간다. maxRepeats(기본 1)번을 넘으면 'repeat'으로 멈춘다(T-222).
 * - 남은 단계·호출이 하나뿐인 차례에는 "[마지막 차례]" 문구를 붙여 final을 내게 한다(T-222).
 * - verify(final, { stepsLeft, callsLeft }) (선택, T-220 에이전트 3의 검증기. 남은 단계·호출은 T-222): { ok, reason?, feedback?, value? }를 돌려준다. 지면 실패 답과
 *   "[검증 실패] feedback"을 기록에 붙여 다시 묻는다(Reflexion식). maxVerifies번 지면 'verify'로 멈춘다.
 *   다시 묻기도 단계·호출 상한에 든다.
 * 돌려주는 값: { final, stop, error, trace, calls, steps, observations, verified, lastFinal }
 *   stop: null(final) | 'steps' | 'calls' | 'repeat' | 'format' | 'llm-error' | 'daily-cap' | 'verify'
 *   trace: [{ step, type: 'action'|'final'|'verify'|'format'|'stop', tool?, args?, ok?, reason?, ms, error? }] (debug.trace, 평가 도구가 읽는다)
 *   verified: 마지막 verify 결과(검증기가 없으면 null), lastFinal: 마지막으로 받은 final(검증에 진 것 포함)
 */
export async function runAgent({ system, user, tools = {}, ask, maxSteps = AGENT_MAX_STEPS, maxCalls = AGENT_MAX_CALLS, budget = null, verify = null, maxVerifies = 2, maxRepeats = 1, now = Date.now }) {
  const trace = [];
  const observations = [];
  const history = [];
  const tried = new Set();
  let calls = 0, steps = 0, verifies = 0, repeats = 0;
  let verified = null, lastFinal = null;
  const done = (final, stop, error = null) => {
    if (stop) trace.push({ step: steps, type: 'stop', reason: stop, ms: 0, ...(error ? { error } : {}) });
    return { final, stop, error, trace, calls, steps, observations, verified, lastFinal };
  };
  const prompt = (note = '') => {
    if (!history.length) return user + note;
    const lines = history.map((h, i) => `${i + 1}. 행동: ${h.action}\n   결과: ${h.result}`);
    return `${user}\n\n[지금까지]\n${lines.join('\n')}\n\n다음 차례를 JSON 객체 하나로 답한다.${note}`;
  };
  // 한 번 부르기. null이면 멈춤 이유가 정해진 것
  const call = async note => {
    if (calls >= maxCalls) return { stop: 'calls' };
    if (budget && !(await budget.take())) return { stop: 'daily-cap' };
    calls++;
    // 남은 단계·호출이 이번 하나뿐이면 final을 내라고 알린다
    const last = steps + 1 >= maxSteps || calls >= maxCalls;
    // jsonObject: 제공자가 JSON 객체 모드를 지원하면 켠다(providers.js 등록부 jsonObject, T-222)
    try { return { text: await ask(system, prompt(note + (last ? LAST_NOTE : '')), { json: true, jsonObject: true }) }; }
    catch (e) { return { stop: 'llm-error', error: String(e?.message || e) }; }
  };

  while (steps < maxSteps) {
    const t0 = now();
    let r = await call('');
    if (r.stop) return done(null, r.stop, r.error);
    let act = parseAction(r.text);
    if (!act) {
      trace.push({ step: steps + 1, type: 'format', ms: now() - t0 });
      r = await call(FORMAT_NOTE);
      if (r.stop) return done(null, r.stop, r.error);
      act = parseAction(r.text);
      if (!act) return done(null, 'format');
    }
    steps++;
    if (act.type === 'final') {
      trace.push({ step: steps, type: 'final', ms: now() - t0 });
      lastFinal = act.final;
      if (!verify) return done(act.final, null);
      const t1 = now();
      verified = (await verify(act.final, { stepsLeft: maxSteps - steps, callsLeft: maxCalls - calls })) || { ok: false };
      trace.push({ step: steps, type: 'verify', ok: !!verified.ok, ...(verified.ok ? {} : { reason: verified.reason || null }), ms: now() - t1 });
      if (verified.ok) return done(act.final, null);
      if (++verifies >= maxVerifies) return done(null, 'verify');
      history.push({
        action: clip(JSON.stringify({ final: act.final }), OBS_MAX),
        result: `[검증 실패] ${verified.feedback || '검증을 통과하지 못했어요.'}`
      });
      continue;
    }
    const key = actionKey(act.name, act.args);
    const argsText = clip(JSON.stringify(act.args), ARGS_MAX);
    if (tried.has(key)) {
      trace.push({ step: steps, type: 'action', tool: act.name, args: argsText, ms: now() - t0, error: '반복' });
      // 한 번은 봐준다(T-222: Nemotron이 사실을 읽은 뒤 같은 확인을 한 번 더 부르는 일이 잦다). 도구는 다시 돌리지 않는다
      if (++repeats > maxRepeats) return done(null, 'repeat');
      history.push({ action: JSON.stringify({ action: act.name, args: act.args }), result: REPEAT_NOTE });
      continue;
    }
    tried.add(key);
    let result, error = null;
    const tool = Object.hasOwn(tools, act.name) ? tools[act.name] : null;
    if (!tool) error = '모르는 도구';
    else {
      try { result = await tool.run(act.args); }
      catch (e) { error = String(e?.message || e); }
    }
    const entry = { step: steps, type: 'action', tool: act.name, args: argsText, ms: now() - t0 };
    if (error) entry.error = error;
    trace.push(entry);
    if (!error) observations.push({ tool: act.name, args: act.args, result });
    history.push({
      action: JSON.stringify({ action: act.name, args: act.args }),
      result: clip(JSON.stringify(error ? { error } : result ?? null), OBS_MAX)
    });
  }
  return done(null, 'steps');
}

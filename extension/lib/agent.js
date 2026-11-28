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
const OBS_MAX = 1500;
// trace에 남길 인자 요약 글자 상한
const ARGS_MAX = 80;

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

// 답 → { type: 'action', name, args } | { type: 'final', final } | null(형식 밖)
export function parseAction(text) {
  const j = parseJSONLoose(text);
  if (!isObj(j)) return null;
  if ('final' in j) return isObj(j.final) ? { type: 'final', final: j.final } : null;
  if (typeof j.action === 'string' && j.action.trim()) {
    const args = j.args ?? {};
    if (!isObj(args)) return null;
    return { type: 'action', name: j.action.trim(), args };
  }
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

const FORMAT_NOTE = '\n\n[형식 오류] 앞 답은 정한 JSON이 아니었어요. {"action": "<도구 이름>", "args": {...}} 또는 {"final": {...}} 객체 하나만 출력한다.';

/**
 * 루프를 돈다.
 * - system·user: 시작 프롬프트. user 뒤에 [지금까지] 행동·결과를 붙여 다음 차례를 부른다(ask는 문자열 한 쌍만 받는다).
 * - tools: { 이름: { run: async args => 관찰 } }. 모르는 도구·도구 오류는 관찰 { error }로 돌려주고 이어 간다.
 * - ask(system, user, { json: true }) → 응답 문자열. 던지면(체인 소진 등) 'llm-error'로 멈춘다.
 * - budget: { take: async () => bool } (선택). LLM 호출마다 먼저 부르고, false면 'daily-cap'으로 멈춘다.
 * - 형식이 틀리면 한 번 다시 묻고(교정 문구), 또 틀리면 'format'으로 멈춘다. 다시 묻기도 호출 상한에 든다.
 * - 같은 도구를 같은 인자로 다시 부르면 'repeat'으로 멈춘다(도구는 돌리지 않는다).
 * 돌려주는 값: { final, stop, error, trace, calls, steps, observations }
 *   stop: null(final) | 'steps' | 'calls' | 'repeat' | 'format' | 'llm-error' | 'daily-cap'
 *   trace: [{ step, type: 'action'|'final'|'format'|'stop', tool?, args?, ms, error? }] (debug.trace, 평가 도구가 읽는다)
 */
export async function runAgent({ system, user, tools = {}, ask, maxSteps = AGENT_MAX_STEPS, maxCalls = AGENT_MAX_CALLS, budget = null, now = Date.now }) {
  const trace = [];
  const observations = [];
  const history = [];
  const tried = new Set();
  let calls = 0, steps = 0;
  const done = (final, stop, error = null) => {
    if (stop) trace.push({ step: steps, type: 'stop', reason: stop, ms: 0, ...(error ? { error } : {}) });
    return { final, stop, error, trace, calls, steps, observations };
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
    try { return { text: await ask(system, prompt(note), { json: true }) }; }
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
      return done(act.final, null);
    }
    const key = actionKey(act.name, act.args);
    const argsText = clip(JSON.stringify(act.args), ARGS_MAX);
    if (tried.has(key)) {
      trace.push({ step: steps, type: 'action', tool: act.name, args: argsText, ms: now() - t0, error: '반복' });
      return done(null, 'repeat');
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

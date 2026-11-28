// 이어 묻기 JSON 액션 형식 스모크(T-218, ADR 0017). 고정 질문을 확장과 같은 runFollowup으로 실제 제공자에 보내
// 응답마다 JSON 액션으로 읽히는지, 도구 이름·인자가 맞는지, 최종 답이 나왔는지, 단계·호출·지연을 잰다.
// 형식을 어겨도 확장은 한 번 다시 묻고 "여기까지 했어요"로 멈출 뿐이라 스모크 실패로 세지 않는다(--precise-judge처럼 보고만).
// smoke-providers.mjs가 --agent(또는 AGENT_SMOKE=true)일 때 부른다. 키 값은 다루지 않는다(호출은 부르는 쪽 ask).
// 호버 결과(prev)는 LLM 없이 고정한다: 후보는 대체 임베더 검색 + 근거 개념, 비유 글은 고정 문구.
import { runFollowupCase } from './eval-followup-lib.mjs';
import { withRo } from '../extension/lib/prompt.js';

// prevNodeId: 방금 보인 근거 개념(고정). null이면 "비유 없음"을 본 뒤 묻는 경우
export const AGENT_TASKS = [
  { id: 'why', sentence: '이 약은 한 번 먹으면 다음 복용까지 최소 4시간을 기다려야 한다.', question: '왜 비슷해요?', prevNodeId: 'skill_cooldown', expectTool: true },
  { id: 'other', sentence: '레버리지는 이익과 손실을 모두 키워서 작은 가격 하락에도 원금을 잃을 수 있다.', question: '다른 비유는요?', prevNodeId: 'starforce', expectTool: true },
  { id: 'free', sentence: '중앙은행이 돈을 많이 찍어내면 물가가 오르고 화폐 가치가 떨어진다.', question: '메소 값이 떨어지면 뭐가 문제예요?', prevNodeId: 'meso_inflation', expectTool: true },
  { id: 'none', sentence: '회의는 다음 주 화요일 오후 3층 대회의실에서 열린다.', question: '이걸 메이플로 치면 뭐예요?', prevNodeId: null, expectTool: false }
];

// 고정 prev. 비유 글은 근거 개념 이름만 쓴 고정 문구(LLM 호출 없이)
export function fixedPrev(graph, task) {
  const n = task.prevNodeId ? graph.nodes.find(x => x.id === task.prevNodeId) : null;
  return n
    ? { meaning: '', analogy: `${withRo(graph.domain)} 치면 ${n.label}처럼요.`, evidence: { nodeId: n.id, nodeLabel: n.label } }
    : { meaning: '', analogy: '', evidence: null };
}

/**
 * 과제 하나. ask(system, user, opts) → 문자열(제공자 하나, 체인 없음). searchGraph는 대체 임베더 검색.
 * candidateIds: 그 문장 검색 상위 + 근거 개념(호버 후보에 근거가 늘 들어 있으므로)
 * now: 지연 시계. 부르는 쪽이 분당 한도용 기다림을 빼서 넘기면 ms가 모델 시간만 된다
 * 돌려주는 값: { id, ok, parsed, responses, toolOk, argsOk, final, finalOk, steps, calls, stop, ms, error }
 */
export async function checkAgentTask(ask, task, { graph, searchGraph, blocklist = [], now = Date.now }) {
  const prev = fixedPrev(graph, task);
  const found = (await searchGraph(task.sentence, [])).slice(0, 3).map(c => c.id);
  const candidateIds = [...new Set([task.prevNodeId, ...found].filter(Boolean))].slice(0, 3);
  const row = await runFollowupCase({ item: { id: task.id, sentence: task.sentence, question: task.question, expect: 'any' }, graph, prev, candidateIds, ask, searchGraph, blocklist, now });
  const rs = row.responses || [];
  const acts = rs.filter(x => x.parsed && !x.final);
  const finals = rs.filter(x => x.final);
  const llmError = row.error || (row.stop === 'llm-error' ? (row.trace?.at(-1)?.error || '모델 호출 실패') : null);
  return {
    id: task.id,
    ok: !llmError,
    responses: rs.length,
    parsed: rs.filter(x => x.parsed).length,
    actions: acts.length,
    toolOk: acts.filter(x => x.toolOk).length,
    argsOk: acts.filter(x => x.argsOk).length,
    usedTool: acts.length > 0,
    final: !!row.rawFinal,
    finalOk: finals.length > 0 && finals.at(-1).finalOk === true,
    shown: !!row.answer,
    answer: row.answer || '',
    note: row.rejected || row.stopText || '',
    steps: row.steps ?? 0, calls: row.calls ?? rs.length, stop: row.stop ?? null, ms: row.ms,
    error: llmError ? String(llmError).slice(0, 160) : null,
    samples: rs.filter(x => x.sample != null).map(x => x.sample)
  };
}

const median = xs => { const s = xs.filter(x => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

export function summarizeAgent(rows) {
  const ok = rows.filter(r => r.ok);
  const sum = k => ok.reduce((a, r) => a + r[k], 0);
  return {
    n: rows.length, errors: rows.length - ok.length,
    responses: sum('responses'), parsed: sum('parsed'), actions: sum('actions'), toolOk: sum('toolOk'), argsOk: sum('argsOk'),
    finals: ok.filter(r => r.final && r.finalOk).length, shown: ok.filter(r => r.shown).length,
    stops: ok.filter(r => r.stop).map(r => `${r.id}:${r.stop}`),
    stepsAvg: ok.length ? sum('steps') / ok.length : null,
    callsAvg: ok.length ? sum('calls') / ok.length : null,
    msMedian: median(ok.map(r => r.ms))
  };
}

export function agentRowLine(r) {
  if (!r.ok) return `  ${r.id.padEnd(6)} ✗ 호출 실패 ${r.ms}ms  ${r.error}`;
  const fmt = `JSON ${r.parsed}/${r.responses} · 도구 ${r.toolOk}/${r.actions} · 인자 ${r.argsOk}/${r.actions}`;
  const end = r.final ? (r.finalOk ? '최종 답 ○' : '최종 답 형식 ✗') : `멈춤(${r.stop})`;
  const head = `  ${r.id.padEnd(6)} ${fmt} · ${end} · 단계 ${r.steps} · 호출 ${r.calls} · ${r.ms}ms  ${r.shown ? `→ ${r.answer.slice(0, 60)}` : r.note}`;
  // 형식이 틀린 응답 원문 앞부분(T-222): 제공자마다 어떻게 어기는지 보려고
  return [head, ...(r.samples || []).map(x => `         ↳ 원문: ${x || '(빈 응답)'}`)].join('\n');
}

export function agentSummaryLine(label, s) {
  const f1 = v => (v == null ? '—' : v.toFixed(1));
  return `${label}: 과제 ${s.n}${s.errors ? `(호출 실패 ${s.errors})` : ''} · JSON ${s.parsed}/${s.responses} · 도구 이름 ${s.toolOk}/${s.actions} · 인자 ${s.argsOk}/${s.actions} · 최종 답 ${s.finals}/${s.n - s.errors} · 보임 ${s.shown} · 단계 평균 ${f1(s.stepsAvg)} · 호출 평균 ${f1(s.callsAvg)} · 중앙 ${s.msMedian ?? '—'}ms${s.stops.length ? ` · 멈춤 ${s.stops.join(', ')}` : ''}`;
}

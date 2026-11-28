// 이어 묻기 평가(T-218, ADR 0017 에이전트 1)의 순수 함수. 네트워크·크롬을 쓰지 않는다(LLM·임베딩은 주입).
// 실행은 tools/eval-followup.mjs. 에이전트는 확장과 같은 runFollowup(agent-tools.js)을 그대로 돈다.
import { parseJSONLoose } from '../extension/lib/providers.js';
import { parseAction } from '../extension/lib/agent.js';
import { runFollowup, FOLLOWUP_TOOL_NAMES, FOLLOWUP_PROMPT_VERSION } from '../extension/lib/agent-tools.js';
import { retrieve, retrievalFor } from '../extension/lib/retrieval.js';
import { REJECTED_TEXT } from '../extension/lib/analogy-server.js';
import { GROUNDING_REJECTED_TEXT } from '../extension/lib/grounding.js';
import { impoliteEnding } from '../extension/lib/prompt.js';

export const EXPECTS = ['node', 'none', 'any'];

// 측정셋 검사. 형식이 틀리면 던진다(결과를 보기 전에 커밋한 셋이 깨지지 않았는지)
export function validateFollowupSet(set, graph = null) {
  const items = set?.items;
  if (!Array.isArray(items) || !items.length) throw new Error('items가 비었어요');
  const ids = new Set();
  const nodeIds = graph ? new Set(graph.nodes.map(n => n.id)) : null;
  for (const it of items) {
    if (!it.id || ids.has(it.id)) throw new Error(`id가 없거나 겹쳐요: ${it.id}`);
    ids.add(it.id);
    if (!it.sentence?.trim() || !it.question?.trim()) throw new Error(`${it.id}: 문장·질문이 비었어요`);
    if (!EXPECTS.includes(it.expect)) throw new Error(`${it.id}: expect는 ${EXPECTS.join('·')} 중 하나예요`);
    for (const n of it.expectNodes || []) if (nodeIds && !nodeIds.has(n)) throw new Error(`${it.id}: 그래프에 없는 노드 ${n}`);
  }
  return items;
}

// 확장 background searchGraph와 같은 규칙: 한 문장 임베딩 + retrieve, topK는 뺄 개념 수만큼 늘린다(제보 노드는 평가에 없음)
export function makeSearchGraph({ graph, vecs, embedQuery, retrieval }) {
  return async (text, exclude = []) => {
    const v = await embedQuery(text);
    const topK = (retrieval?.topK ?? 3) + exclude.length;
    return retrieve(v, graph, vecs, { ...retrievalFor(retrieval, graph), topK, aliasText: text }).filter(c => !exclude.includes(c.id));
  };
}

// 호버 결과(runAnalogy) → 이어 묻기에 넘기는 방금 결과·후보 id (content.js가 보내는 모양과 같다)
export function hoverToPrev(r, candidates) {
  const a = r?.answer || {};
  return {
    prev: {
      meaning: a.meaning || '',
      analogy: a.analogy || '',
      evidence: r?.evidence ? { nodeId: r.evidence.nodeId, nodeLabel: r.evidence.nodeLabel } : null
    },
    candidateIds: (candidates || []).map(c => c.id)
  };
}

// found(개념 이름) → 노드 id. 같은 이름이 여럿이면 모두
export function idsFromLabels(graph, labels = []) {
  const want = new Set(labels);
  return graph.nodes.filter(n => want.has(n.label)).map(n => n.id);
}

// 응답 하나의 형식 점검(스모크·평가 공통): JSON 액션으로 읽히는가, 도구 이름·인자가 맞는가
export function checkResponse(text, graph) {
  const act = parseAction(text);
  if (!act) return { parsed: false, final: false, toolOk: null, argsOk: null };
  if (act.type === 'final') {
    const f = act.final;
    const ok = typeof f.answer === 'string' && f.answer.trim() !== '' && (f.nodeId == null || typeof f.nodeId === 'string');
    return { parsed: true, final: true, finalOk: ok, toolOk: null, argsOk: null };
  }
  const toolOk = FOLLOWUP_TOOL_NAMES.includes(act.name);
  const a = act.args || {};
  const exOk = a.exclude == null || (Array.isArray(a.exclude) && a.exclude.every(x => typeof x === 'string'));
  let argsOk = false;
  if (act.name === 'get_node_facts') argsOk = typeof a.nodeId === 'string' && graph.nodes.some(n => n.id === a.nodeId);
  if (act.name === 'search_graph') argsOk = typeof a.text === 'string' && a.text.trim() !== '' && exOk;
  if (act.name === 'search_by_tag') argsOk = typeof a.tagId === 'string' && graph.tags.some(t => t.id === a.tagId) && exOk;
  return { parsed: true, final: false, tool: act.name, toolOk, argsOk };
}

// 첫 final 전에 맞는 도구(셋 모두 facts를 돌려준다)를 불렀는가(T-224: 되묻기에 기대지 않고 스스로 facts를 읽었나).
// responses: checkResponse 결과 배열
export function readFactsFirst(responses = []) {
  const firstFinal = responses.findIndex(x => x.final);
  const before = firstFinal < 0 ? responses : responses.slice(0, firstFinal);
  return before.some(x => x.parsed && !x.final && x.toolOk === true);
}

// 형식이 틀린 응답(JSON으로 안 읽힘·도구 이름·인자 틀림)은 원문 앞부분을 남긴다(T-222, 원인 진단용. 키는 응답에 없다)
export const SAMPLE_MAX = 240;
export function withSample(check, text) {
  const bad = !check.parsed || check.toolOk === false || check.argsOk === false;
  return bad ? { ...check, sample: String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, SAMPLE_MAX) } : check;
}

/**
 * 이어 묻기 한 문항. ask를 감싸 응답 원문을 모두 남긴다(형식 점검, 걸러지기 전 최종 답 채점용).
 * 돌려주는 값: 결과 행 { id, question, prev, candidateIds, answer, evidence, rejected, stopText, rawFinal, foundIds,
 *   responses: [checkResponse], calls, steps, stop, trace, ms, error? }
 */
export async function runFollowupCase({ item, graph, prev, candidateIds, ask, searchGraph, blocklist = [], now = Date.now }) {
  const texts = [];
  const wrapped = async (system, user, opts) => { const t = await ask(system, user, opts); texts.push(t); return t; };
  const t0 = now();
  const base = { id: item.id, sentence: item.sentence, question: item.question, kind: item.kind, expect: item.expect, prev, candidateIds };
  try {
    const r = await runFollowup({
      graph, payload: { sentence: item.sentence, word: item.word || '', context: item.context || '', pageTitle: item.pageTitle || '' },
      question: item.question, prev, candidateIds, ask: wrapped, searchGraph, blocklist
    });
    const lastFinal = [...texts].reverse().map(parseAction).find(a => a?.type === 'final');
    return {
      ...base,
      answer: r.answer, evidence: r.evidence, rejected: r.rejected, stopText: r.stopText,
      rawFinal: r.debug.stop ? null : lastFinal?.final || null,
      foundIds: idsFromLabels(graph, r.found),
      responses: texts.map(t => withSample(checkResponse(t, graph), t)),
      calls: r.debug.calls, steps: r.debug.steps, stop: r.debug.stop, trace: r.debug.trace,
      ...(r.debug.grounding ? { grounding: r.debug.grounding } : {}),
      ms: now() - t0
    };
  } catch (e) {
    return { ...base, error: String(e?.message || e).slice(0, 200), responses: texts.map(t => withSample(checkResponse(t, graph), t)), calls: texts.length, ms: now() - t0 };
  }
}

// ── 채점 ──
// 채점 기준 판(T-222: "없음"·억지 비유 기준 강화). 바꾸면 올린다(캐시 키에 들어간다)
export const JUDGE_VERSION = 'T-222';
const JUDGE_SYSTEM = [
  '너는 비유 앱의 "이어 묻기" 답을 채점하는 심사자다. 사용자가 방금 본 게임 비유에 대해 이어서 물었고, 다른 모델이 답했다. 엄격하게 채점한다.',
  '- grounded: 답에 쓴 게임 사실이 아래 "볼 수 있던 개념의 사실" 안에 있으면 true. 목록에 없는 수치·이름·규칙·설정을 지어냈으면 false. 맞는 개념이 없다고만 답했으면 true.',
  '- forced: 답이 게임 개념에 빗댔는데 문장과의 공통점이 억지면 true. 억지란 공통점이 두루뭉술하거나("정해진 조건을 맞춘다", "과정이다", "특별한 장소", "꾸준히 해야 한다", "일정이 있다") 낱말만 겹치고, 문장의 핵심 구조(무엇이 무엇을 제한·증폭·교환·조건으로 거는지)와 사실이 구체적으로 맞지 않는 것이다. 날짜·장소 안내, 사물·동물의 성질 묘사, 생활 수칙, 단순한 행동 문장에 게임 비유를 붙였으면 거의 항상 억지다. 개념 없이 없다고 답했거나 구조가 구체적으로 맞으면 false.',
  '- helpful (1~5): 질문에 맞게 답했는가. 5 = 질문에 정확히 답해 납득됨, 3 = 관련은 있으나 질문을 비켜 감, 1 = 엉뚱하거나 쓸모없음. forced가 true인 답은 아무리 매끄러워도 1~2. 정말 맞는 개념이 없을 때 없다고 짧게 말한 답은 4~5, 볼 수 있던 개념 중 구조가 구체적으로 맞는 것이 있는데 없다고 한 답은 2.',
  '- haeyo: 모든 문장이 해요체(~요)로 끝나면 true. ~습니다·~다·반말이 있으면 false.',
  '- reason: 이유를 한국어 한두 문장으로. grounded가 false면 지어낸 부분을, forced가 true면 어디가 억지인지 짚는다.',
  '반드시 JSON 하나만 출력한다: {"grounded": true|false, "forced": true|false, "helpful": 1-5, "haeyo": true|false, "reason": "..."}'
].join('\n');

const factLines = facts => (facts || []).map(f => `  - ${f}`).join('\n') || '  (사실 없음)';

// row: runFollowupCase 결과. 볼 수 있던 개념 = 호버 후보 ∪ 도구로 본 노드(확장 규칙 1의 허용 목록과 같다)
export function buildFollowupJudgePrompt(row, graph) {
  const ids = [...new Set([...(row.candidateIds || []), ...(row.foundIds || [])])];
  const nodes = ids.map(id => graph.nodes.find(n => n.id === id)).filter(Boolean);
  const f = row.rawFinal || {};
  const user = [
    `관심사: ${graph.domain}`,
    `문장: ${row.sentence}`,
    `방금 보인 비유: ${row.prev?.analogy || '(없음)'}${row.prev?.evidence ? ` [근거 개념: ${row.prev.evidence.nodeLabel} (${row.prev.evidence.nodeId})]` : ''}`,
    `질문: ${row.question}`,
    '',
    nodes.length ? `볼 수 있던 개념의 사실:\n${nodes.map(n => `- ${n.label} (${n.id})\n${factLines(n.facts)}`).join('\n')}` : '볼 수 있던 개념의 사실: 없음',
    '',
    `채점할 답: ${f.answer || ''}`,
    `답이 댄 근거 개념: ${f.nodeId || '없음'}${f.usedFact ? ` / 인용한 사실: ${f.usedFact}` : ''}`,
    '',
    'JSON {"grounded", "forced", "helpful", "haeyo", "reason"} 하나로 답해 줘.'
  ].join('\n');
  return { system: JUDGE_SYSTEM, user };
}

// 채점 응답 → { grounded, forced, helpful, haeyo, reason } | null. forced는 T-222부터(없으면 null, 예전 캐시와 호환)
export function parseFollowupJudge(text) {
  const j = parseJSONLoose(text);
  if (!j || typeof j !== 'object') return null;
  if (typeof j.grounded !== 'boolean' || typeof j.haeyo !== 'boolean') return null;
  if (!Number.isInteger(j.helpful) || j.helpful < 1 || j.helpful > 5) return null;
  return { grounded: j.grounded, forced: typeof j.forced === 'boolean' ? j.forced : null, helpful: j.helpful, haeyo: j.haeyo, reason: typeof j.reason === 'string' ? j.reason : '' };
}

// ── 코드로 재는 지표(채점 모델 없이) ──
// hidden: 'rule1' | 'grounding' | 'other' | null. expectOk: 문항 기대(expect·notPrev)를 지켰는가(멈춤은 false)
export function scoreRow(row, item = {}) {
  if (row.error) return { final: false, shown: false, hidden: null, rule1: false, expectOk: false, hit: null, notPrevOk: null, haeyoCode: null };
  const final = !!row.rawFinal;
  const shown = !!row.answer;
  const hidden = shown || !final ? null : row.rejected === REJECTED_TEXT ? 'rule1' : row.rejected === GROUNDING_REJECTED_TEXT ? 'grounding' : 'other';
  const nodeId = row.rawFinal?.nodeId || null;
  let expectOk = false;
  if (final) {
    if (item.expect === 'none') expectOk = !nodeId;
    else if (item.expect === 'node') expectOk = shown && !!row.evidence;
    else expectOk = hidden === null; // any: 근거 검사를 지나 보이기만 하면
  }
  const notPrevOk = item.notPrev && shown && row.evidence ? row.evidence.nodeId !== row.prev?.evidence?.nodeId : null;
  if (item.notPrev && notPrevOk === false) expectOk = false;
  const hit = item.expectNodes?.length && shown ? !!row.evidence && item.expectNodes.includes(row.evidence.nodeId) : null;
  return { final, shown, hidden, rule1: hidden === 'rule1', expectOk, hit, notPrevOk, haeyoCode: shown ? impoliteEnding(row.answer) === null : null };
}

const avg = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
export const median = xs => { const s = xs.filter(x => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
export const p90 = xs => { const s = xs.filter(x => x != null).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * 0.9) - 1)] : null; };

// rows: 결과 행(score·judge가 붙은 것). 형식 지표는 모든 응답 원문 기준
export function summarizeFollowup(rows) {
  const ok = rows.filter(r => !r.error);
  const sc = rows.map(r => r.score || {});
  const judged = rows.filter(r => r.judge);
  const responses = rows.flatMap(r => r.responses || []);
  const actions = responses.filter(x => x.parsed && !x.final);
  const stops = {};
  for (const r of ok) if (r.stop) stops[r.stop] = (stops[r.stop] || 0) + 1;
  const by = e => rows.filter(r => r.expect === e);
  const okOf = list => list.filter(r => r.score?.expectOk).length;
  return {
    n: rows.length,
    errors: rows.length - ok.length,
    finals: sc.filter(s => s.final).length,
    shown: sc.filter(s => s.shown).length,
    hiddenRule1: sc.filter(s => s.hidden === 'rule1').length,
    hiddenGrounding: sc.filter(s => s.hidden === 'grounding').length,
    hiddenOther: sc.filter(s => s.hidden === 'other').length,
    stops,
    expect: Object.fromEntries(EXPECTS.map(e => [e, { ok: okOf(by(e)), n: by(e).length }])),
    hit: { ok: sc.filter(s => s.hit === true).length, n: sc.filter(s => s.hit != null).length },
    notPrev: { ok: sc.filter(s => s.notPrevOk === true).length, n: sc.filter(s => s.notPrevOk != null).length },
    haeyoCode: { ok: sc.filter(s => s.haeyoCode === true).length, n: sc.filter(s => s.haeyoCode != null).length },
    // 스스로 facts 읽음(T-224): 개념·아무거나 기대 문항 중 오류 없는 것. 없음 기대는 도구 없이 답해도 맞다
    selfRead: { ok: ok.filter(r => r.expect !== 'none' && readFactsFirst(r.responses)).length, n: ok.filter(r => r.expect !== 'none').length },
    judged: judged.length,
    groundedRate: judged.length ? judged.filter(r => r.judge.grounded).length / judged.length : null,
    helpfulAvg: avg(judged.map(r => r.judge.helpful)),
    // 억지 비유(채점): forced를 준 채점만 센다. 보인 답 기준도 따로(숨긴 답은 사용자가 못 본다)
    forced: { yes: judged.filter(r => r.judge.forced === true).length, n: judged.filter(r => typeof r.judge.forced === 'boolean').length },
    forcedShown: judged.filter(r => r.judge.forced === true && r.score?.shown).length,
    haeyoRate: judged.length ? judged.filter(r => r.judge.haeyo).length / judged.length : null,
    format: {
      responses: responses.length,
      parsed: responses.filter(x => x.parsed).length,
      actions: actions.length,
      toolOk: actions.filter(x => x.toolOk).length,
      argsOk: actions.filter(x => x.argsOk).length
    },
    callsAvg: avg(ok.map(r => r.calls)),
    callsMax: ok.length ? Math.max(...ok.map(r => r.calls)) : null,
    stepsAvg: avg(ok.map(r => r.steps)),
    msMedian: median(ok.map(r => r.ms)),
    msP90: p90(ok.map(r => r.ms)),
    violations: judged.filter(r => !r.judge.grounded).map(r => ({ id: r.id, answer: r.rawFinal?.answer || '', reason: r.judge.reason }))
  };
}

const frac = o => `${o.ok}/${o.n}`;
const f1 = v => (v == null ? '—' : v.toFixed(1));
const f2 = v => (v == null ? '—' : v.toFixed(2));
const pc = v => (v == null ? '—' : `${Math.round(v * 100)}%`);

// 사람이 읽는 요약 줄들
export function summaryLines(s) {
  const stops = Object.entries(s.stops).map(([k, v]) => `${k} ${v}`).join(', ') || '없음';
  return [
    `문항 ${s.n} · 최종 답 ${s.finals} · 보임 ${s.shown} · 숨김(규칙 1 ${s.hiddenRule1}, 근거 ${s.hiddenGrounding}, 기타 ${s.hiddenOther}) · 멈춤 ${stops}${s.errors ? ` · 오류 ${s.errors}` : ''}`,
    `기대 지킴: 개념 ${frac(s.expect.node)} · 없음 ${frac(s.expect.none)} · 아무거나 ${frac(s.expect.any)} · 기대 노드 적중 ${frac(s.hit)} · 다른 비유가 다른 개념 ${frac(s.notPrev)}`,
    `채점 ${s.judged} · 근거 준수 ${pc(s.groundedRate)} · 도움됨 평균 ${f2(s.helpfulAvg)} · 억지 비유 ${s.forced.n ? `${s.forced.yes}/${s.forced.n}(보인 답 ${s.forcedShown})` : '—'} · 해요체(채점) ${pc(s.haeyoRate)} · 해요체(코드, 보인 답) ${frac(s.haeyoCode)}`,
    `형식: 응답 ${s.format.responses} 중 JSON 액션 ${s.format.parsed} · 도구 이름 ${s.format.toolOk}/${s.format.actions} · 인자 ${s.format.argsOk}/${s.format.actions}${s.selfRead ? ` · 스스로 facts 읽음 ${frac(s.selfRead)}` : ''}`,
    `호출 평균 ${f1(s.callsAvg)}(최대 ${s.callsMax ?? '—'}) · 단계 평균 ${f1(s.stepsAvg)} · 지연 중앙 ${s.msMedian ?? '—'}ms · p90 ${s.msP90 ?? '—'}ms`
  ];
}

// EVAL_LOG 표 한 줄(생성 평가 줄과 같은 칸)
export function followupLogRow(s, { date, gen = [], judge = '—', embedder = '—' }) {
  const metrics = `보인 답 ${s.shown}/${s.n} · 근거 준수 ${pc(s.groundedRate)}(${s.judged}) · 도움됨 ${f2(s.helpfulAvg)}${s.forced.n ? ` · 억지 ${s.forced.yes}/${s.forced.n}` : ''} · 해요체 ${pc(s.haeyoRate)} · 기대 지킴 개념 ${frac(s.expect.node)}·없음 ${frac(s.expect.none)}·아무거나 ${frac(s.expect.any)} · 숨김 규칙 1 ${s.hiddenRule1}·근거 ${s.hiddenGrounding}`;
  const memo = `T-218 이어 묻기 평가. 생성 ${gen.join(', ') || '—'} → 채점 ${judge}. 호출 평균 ${f1(s.callsAvg)}·단계 ${f1(s.stepsAvg)}·지연 중앙 ${s.msMedian ?? '—'}ms, 형식 ${s.format.parsed}/${s.format.responses}`;
  return `| ${date} | ${embedder} | 이어 묻기 ${s.n} | admin.retrieval | — | — | — | — | ${metrics}. ${memo} |`;
}

// 캐시 키
export const hoverKey = (gen, embedder, sentence) => `hover|${gen}|${embedder}|${sentence}`;
export const agentKey = (gen, embedder, item) => `agent|${FOLLOWUP_PROMPT_VERSION}|${gen}|${embedder}|${item.id}|${item.sentence}|${item.question}`;
export const judgeKey = (judge, row) => `judge|${JUDGE_VERSION}|${judge}|${row.id}|${JSON.stringify(row.rawFinal)}|${(row.foundIds || []).join(',')}`;

// 채점 모델은 생성과 다른 계열이어야 한다. 계열 = 제공자 id(같은 회사 모델끼리 후하게 채점하는 것을 막는다)
export const familyOf = p => p.id ?? p.provider;
export function withoutFamily(chain, judge) {
  return chain.filter(p => familyOf(p) !== familyOf(judge));
}

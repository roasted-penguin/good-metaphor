// 에이전트 3 "👎 교정 진단"(T-220, ADR 0017). chrome.* 를 쓰지 않는다.
// 👎 뒤 사용자가 "왜 틀렸는지 살펴볼게요"를 누를 때만 돈다(기본 👎 → 빠른 다시 비유는 그대로, ADR 0010).
// 검증기가 붙은 Reflexion식 루프: LLM은 원인 진단과 새 비유(다른 후보·다른 각도)만 내고, 검증은 코드가 한다.
//   검증기 = 👎한 개념 금지 → 규칙 1(후보 ∪ 이번 실행 도구 결과 노드) → 근거 검사(checkGrounding) → 금칙어(applyBlocklist) → 끝맺음(해요체).
//   지면 실패 이유를 다음 차례 입력으로 넣고(agent.js runAgent verify 훅), 상한에 닿으면 "여기까지 했어요".
// 도구는 이어 묻기(T-216)의 읽기 전용 셋을 그대로 쓴다. 이 모듈은 아무것도 쓰지 않는다.
// 쓰기는 사용자가 말풍선 버튼을 눌러야만 background가 한다: 피드백 층 고정(pick, 규칙 3 예외) 또는
// 로그인 + 내 노드 + 내 태그일 때 내 태그 예문(corrections.js 거름). 공통 그래프·tags.json은 어떤 길로도 쓰지 않는다.
// 보내는 글은 호버와 같은 범위(제목·앞 문장·문장·단어)와 원래 결과 기록뿐이다(문단 전송 보류, ADR 0017 열린 결정 1).
import { runAgent, AGENT_STOP_TEXT } from './agent.js';
import { makeFollowupTools, finalizeAnswer, FORMAT_REJECTED_TEXT, STOP_REASON } from './agent-tools.js';
import { REJECTED_TEXT } from './analogy-server.js';
import { endingIssues } from './prompt.js';
import { toExampleCandidates } from './corrections.js';

export const DIAGNOSE_BUTTON_TEXT = '왜 틀렸는지 살펴볼게요';
export const DIAGNOSE_MAX_STEPS = 5;
export const DIAGNOSE_MAX_CALLS = 4;
export const DIAGNOSE_MAX_VERIFIES = 2;
export const DIAGNOSE_CAP_TEXT = '오늘 살펴보기를 다 썼어요. 내일 다시 눌러 주세요.';
export const DIAGNOSE_NONE_TEXT = '더 맞는 개념을 찾지 못했어요. 억지로 만들지 않았어요.';
export const DIAGNOSE_UNKNOWN_TEXT = '원인을 하나로 짚지 못했어요.';
export const EXCLUDED_REJECTED_TEXT = '안 맞는다고 한 개념을 다시 골라서 비유를 숨겼어요.';
export const ENDING_REJECTED_TEXT = '말투가 맞지 않아서 비유를 숨겼어요.';

// 원인 → 말풍선 한 줄(고정 문구라 LLM 글이 진단 줄에 섞이지 않는다)
export const DIAGNOSE_CAUSES = {
  structure: '후보 개념의 구조가 문장과 달랐어요.',
  tag: '추상 태그가 맞지 않거나 약했어요.',
  facts: '근거 사실이 부족했어요.',
  tone: '말투가 어색했어요.',
  number: '근거에 없는 숫자가 들어갔어요.',
  meaning: '문장 뜻을 잘못 읽었어요.',
  none: '그래프에 맞는 개념이 없었어요.'
};
const CAUSE_HELP = {
  structure: '후보 개념의 구조(인과·비용·위험 모양)가 문장과 달랐다',
  tag: '맞은 추상 태그가 문장 구조와 맞지 않거나 약했다',
  facts: '근거 개념 facts에 비유를 받칠 사실이 부족했다',
  tone: '말투가 해요체가 아니거나 어색했다',
  number: '근거에 없는 숫자가 비유에 들어갔다',
  meaning: '문장 뜻 자체를 잘못 읽었다',
  none: '그래프에 맞는 개념이 없다'
};
const REASON_CAUSE = { forced: 'structure', meaning: 'meaning', fact: 'facts', none: 'none' };
const REASON_TEXT = { forced: '비유가 억지예요', meaning: '뜻이 틀렸어요', fact: '사실이 틀렸어요', none: '맞는 개념이 없어요' };
const TAG_WEAK = 0.5;      // 근거 개념의 태그 유사도가 이보다 낮으면 "태그가 약함" 단서
const MARGIN_SMALL = 0.01; // 1·2위 점수 차가 이보다 작으면 "구조가 애매함" 단서

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const idList = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);
const num = v => (Number.isFinite(v) ? v : null);

// final → { cause, label }. diagnosis는 { cause } 객체나 원인 문자열
export function parseDiagnosis(final) {
  const d = final?.diagnosis;
  const cause = typeof d === 'string' ? d : isObj(d) && typeof d.cause === 'string' ? d.cause : '';
  const k = cause.trim();
  return Object.hasOwn(DIAGNOSE_CAUSES, k) ? { cause: k, label: DIAGNOSE_CAUSES[k] } : { cause: 'unknown', label: DIAGNOSE_UNKNOWN_TEXT };
}

/**
 * 원래 결과(👎한 결과)의 기록에서 코드가 먼저 본 단서. LLM 진단의 입력이 된다(결정은 LLM이, 증거는 코드가).
 * orig: { evidence, candidates: [{ id, score, tagSim }], grounding: { ok, reason }, ending: { ok }, reason(이유 칩) }
 * @returns {Array<{ cause, text }>}
 */
export function diagnoseHints(orig = {}) {
  const out = [];
  const g = orig.grounding;
  if (g && g.ok === false) {
    if (g.reason === 'number-outside') out.push({ cause: 'number', text: '원래 비유에 근거·원문에 없는 숫자가 있었어요.' });
    else out.push({ cause: 'facts', text: '원래 비유가 고른 개념의 사실과 맞지 않았어요.' });
  }
  if (orig.ending && orig.ending.ok === false) out.push({ cause: 'tone', text: '원래 답이 해요체로 끝나지 않았어요.' });
  const cands = Array.isArray(orig.candidates) ? orig.candidates : [];
  const ev = cands.find(c => c?.id === orig.evidence?.nodeId);
  const tagSim = num(ev?.tagSim);
  if (tagSim !== null && tagSim < TAG_WEAK) out.push({ cause: 'tag', text: `근거 개념의 태그 유사도가 ${tagSim.toFixed(2)}로 낮았어요.` });
  const scores = cands.map(c => num(c?.score)).filter(v => v !== null).sort((a, b) => b - a);
  if (scores.length >= 2 && scores[0] - scores[1] < MARGIN_SMALL) out.push({ cause: 'structure', text: `1·2위 후보 점수 차이가 ${(scores[0] - scores[1]).toFixed(3)}로 작았어요.` });
  if (REASON_CAUSE[orig.reason]) out.push({ cause: REASON_CAUSE[orig.reason], text: `사용자가 고른 이유: ${REASON_TEXT[orig.reason]}` });
  return out;
}

export function buildDiagnosePrompt({ domain, analogyPrefix, payload = {}, orig = {}, rerun = null, excluded = [], candidates = [], hints = [], maxSteps = DIAGNOSE_MAX_STEPS }) {
  const prefix = analogyPrefix || `${domain}로 치면`;
  const system = [
    `너는 사용자가 👎한 "${domain}" 비유가 왜 틀렸는지 진단하고, 다른 개념이나 다른 각도로 더 나은 비유를 다시 만드는 도우미다.`,
    '매 차례 JSON 객체 하나만 출력한다. 둘 중 하나다.',
    '{"action": "<도구 이름>", "args": {...}}',
    '{"final": {"diagnosis": {"cause": "<원인>"}, "answer": string, "nodeId": string|null, "usedFact": string}}',
    '원인(cause)은 다음 중 하나다:',
    ...Object.entries(CAUSE_HELP).map(([k, t]) => `- "${k}": ${t}`),
    '도구:',
    '- get_node_facts {"nodeId": string}: 개념의 사실(facts)·태그·연결',
    '- search_graph {"text": string, "exclude": [nodeId]}: 글과 구조가 비슷한 개념 찾기(exclude는 뺄 개념)',
    '- search_by_tag {"tagId": string, "exclude": [nodeId]}: 그 추상 태그를 가진 개념',
    '규칙:',
    '1. 쓰지 말 개념(사용자가 👎한 개념)은 nodeId로 쓰지 않는다. 후보 개념이나 도구로 찾은 개념만 쓴다.',
    `2. ${domain}에 관한 내용은 도구 결과·후보의 사실(facts)만 쓴다. 근거에 없는 수치, 이름, 규칙을 지어내지 않는다.`,
    '3. nodeId에 쓴 개념의 facts 문장 하나를 usedFact에 글자 그대로 옮긴다.',
    '4. 맞는 개념이 없으면 cause는 "none", answer는 빈 문자열, nodeId는 null이다. 억지 비유는 틀린 설명보다 나쁘다.',
    `5. answer는 "${prefix}"로 시작하는 해요체(~요) 1~2문장, 150자 안쪽. ~습니다·~다로 끝내지 않는다.`,
    `6. 같은 도구를 같은 인자로 두 번 부르지 않는다. 최대 ${maxSteps}차례 안에 final을 낸다.`,
    '7. [검증 실패]가 오면 그 이유를 고쳐 final을 다시 낸다.',
    '8. 커뮤니티 멸칭이나 실존 인물 이름·별명은 쓰지 않는다.'
  ].join('\n');
  const cand = candidates.map(c => `- id=${c.id} | ${c.label}${c.score != null ? ` | 점수 ${c.score}` : ''}${c.tag ? ` | 태그: ${c.tag.label} (id=${c.tag.id})` : ''}`);
  const ex = excluded.map(e => (typeof e === 'string' ? `id=${e}` : `id=${e.id} | ${e.label}`)).join(', ');
  const user = [
    `페이지 제목: ${payload.pageTitle || '(제목 없음)'}`,
    payload.context ? `앞 문장: ${payload.context}` : '',
    `설명할 문장: ${payload.sentence}`,
    payload.word ? `커서가 가리킨 단어: ${payload.word}` : '',
    '',
    '[👎한 결과]',
    orig.meaning ? `쉬운 뜻: ${orig.meaning}` : '',
    `👎한 비유: ${orig.analogy || '(없음)'}`,
    orig.evidence?.nodeId ? `근거 개념: id=${orig.evidence.nodeId} | ${orig.evidence.nodeLabel || ''}` : '',
    ex ? `쓰지 말 개념: ${ex}` : '',
    rerun?.analogy ? `다시 만든 비유: ${rerun.analogy}${rerun.evidence?.nodeId ? ` (id=${rerun.evidence.nodeId})` : ''}` : '',
    cand.length ? '후보 개념:' : '',
    ...cand,
    hints.length ? '[코드가 본 단서]' : '',
    ...hints.map(h => `- ${h.text} (원인 후보: ${h.cause})`),
    '',
    '원인을 하나 고르고, 다른 개념이나 다른 각도로 더 맞는 비유를 만든다.'
  ].filter(s => s !== '').join('\n');
  return { system, user };
}

/**
 * 검증기. allowed = 후보 ∪ 이번 실행에서 도구로 본 노드, excluded = 👎한 개념.
 * 돌려주는 값: { ok, reason?, feedback?, rejected?, grounding?, blocked?, value? }
 *   value(통과): { diagnosis, analogy, evidence, grounding }
 *   feedback: 다음 차례에 붙일 실패 이유(LLM용), rejected: 말풍선에 보일 숨김 문구(기존 문구)
 */
export function verifyDiagnosis({ final, graph, allowed, excluded = new Set(), sentence, context, blocklist = [] }) {
  const diagnosis = parseDiagnosis(final);
  const answer = typeof final?.answer === 'string' ? final.answer.trim() : '';
  const nodeId = typeof final?.nodeId === 'string' && final.nodeId ? final.nodeId : null;
  const fail = (reason, feedback, rejected, extra = {}) => ({ ok: false, reason, feedback, rejected, diagnosis, ...extra });
  if (!nodeId) {
    if (diagnosis.cause === 'none') return { ok: true, value: { diagnosis, analogy: '', evidence: null, grounding: null } };
    return fail('no-node', '새 비유에는 nodeId(후보나 도구로 본 개념)가 있어야 해요. 맞는 개념이 없으면 cause "none", nodeId null로 답한다.', REJECTED_TEXT);
  }
  if (!answer) return fail('format', 'answer가 비었어요. 새 비유를 answer에 쓴다.', FORMAT_REJECTED_TEXT);
  if (excluded.has(nodeId)) return fail('excluded', `사용자가 👎한 개념(id=${nodeId})은 쓰지 않는다. 다른 개념을 고른다.`, EXCLUDED_REJECTED_TEXT);
  const allow = new Set([...allowed].filter(id => !excluded.has(id)));
  const f = finalizeAnswer({ final: { answer, nodeId, usedFact: final.usedFact }, graph, allowed: allow, sentence, context, blocklist });
  if (f.rejected === REJECTED_TEXT) return fail('rule1', '후보나 도구 결과에 없는 개념이에요(규칙 1). 후보 개념이나 도구로 본 개념만 쓴다.', REJECTED_TEXT);
  if (f.grounding && !f.grounding.ok) {
    const fb = f.grounding.reason === 'number-outside'
      ? 'answer에 facts·원문에 없는 숫자가 있어요. 숫자를 빼거나 facts의 숫자만 쓴다.'
      : 'usedFact가 그 개념 facts에 글자 그대로 없어요. facts 문장 하나를 그대로 옮긴다.';
    return fail('grounding', fb, f.rejected, { grounding: f.grounding });
  }
  if (f.blocked) return fail('blocked', '쓰면 안 되는 표현이 섞였어요. 다른 말로 다시 쓴다.', f.rejected, { blocked: f.blocked });
  if (f.rejected) return fail('format', '답을 읽지 못했어요. 정한 형식으로 다시 쓴다.', f.rejected);
  if (endingIssues({ analogy: answer }).length) return fail('ending', 'answer의 모든 문장을 해요체(~요)로 끝낸다. ~습니다·~다로 끝내지 않는다.', ENDING_REJECTED_TEXT);
  return { ok: true, value: { diagnosis, analogy: f.answer, evidence: f.evidence, grounding: f.grounding } };
}

/**
 * 에이전트 3: 👎 교정 진단. 상한 5단계·LLM 4회·검증 2회.
 * - payload: { sentence, word, context, pageTitle } (호버와 같은 범위)
 * - orig: 👎한 결과 { meaning, analogy, evidence, candidates, grounding, ending, reason }
 * - rerun: 👎 직후 빠른 다시 비유 결과 { analogy, evidence } (선택)
 * - downNodeIds: 👎한 개념 id(쓰지 말 개념)
 * - ask·searchGraph·budget 주입(이어 묻기와 같은 하루 상한을 함께 센다)
 * 돌려주는 값: { diagnosis, analogy, evidence, rejected, note, stopText, capped, found, debug }
 */
export async function runDiagnose({ graph, payload, orig = {}, rerun = null, downNodeIds = [], ask, searchGraph, blocklist = [], budget = null, maxSteps = DIAGNOSE_MAX_STEPS, maxCalls = DIAGNOSE_MAX_CALLS, maxVerifies = DIAGNOSE_MAX_VERIFIES }) {
  const inGraph = id => graph.nodes.find(n => n.id === id) || null;
  const excludedIds = new Set(idList(downNodeIds).filter(inGraph));
  const excluded = [...excludedIds].map(id => ({ id, label: inGraph(id).label }));
  const candidates = (Array.isArray(orig.candidates) ? orig.candidates : [])
    .filter(c => typeof c?.id === 'string' && inGraph(c.id) && !excludedIds.has(c.id))
    .map(c => {
      const n = inGraph(c.id);
      const tagId = typeof c.tagId === 'string' && (n.tags || []).includes(c.tagId) ? c.tagId : (n.tags || [])[0];
      const tag = tagId ? graph.tags.find(t => t.id === tagId) : null;
      return { id: n.id, label: n.label, score: num(c.score) !== null ? Math.round(c.score * 1000) / 1000 : null, tag: tag ? { id: tag.id, label: tag.label } : null };
    });
  const hints = diagnoseHints(orig);
  const seen = new Set();
  const tools = makeFollowupTools({ graph, searchGraph, seen });
  const { system, user } = buildDiagnosePrompt({ domain: graph.domain, analogyPrefix: graph.analogyPrefix, payload, orig, rerun, excluded, candidates, hints, maxSteps });
  const verify = async final => verifyDiagnosis({
    final, graph, allowed: new Set([...candidates.map(c => c.id), ...seen]), excluded: excludedIds,
    sentence: payload.sentence, context: payload.context, blocklist
  });
  const run = await runAgent({ system, user, tools, ask, maxSteps, maxCalls, budget, verify, maxVerifies });
  const found = [...seen].map(id => inGraph(id)?.label).filter(Boolean);
  const debug = { trace: run.trace, calls: run.calls, steps: run.steps, stop: run.stop, hints: hints.map(h => h.cause) };
  const v = run.verified;
  if (v?.grounding) debug.grounding = v.grounding;
  if (v?.blocked) debug.blocked = v.blocked;
  if (run.final && v?.ok) {
    const r = v.value;
    return { diagnosis: r.diagnosis, analogy: r.analogy, evidence: r.evidence, rejected: null, note: r.analogy ? null : DIAGNOSE_NONE_TEXT, stopText: null, capped: false, found, debug };
  }
  const capped = run.stop === 'daily-cap';
  const reason = run.stop === 'verify' ? '검증을 통과한 비유를 만들지 못했어요.' : STOP_REASON[run.stop] || '';
  const stopText = capped && run.calls === 0 ? DIAGNOSE_CAP_TEXT : `${AGENT_STOP_TEXT} ${capped ? DIAGNOSE_CAP_TEXT : reason}`.trim();
  if (run.error) debug.error = run.error.slice(0, 200);
  return {
    diagnosis: run.lastFinal ? parseDiagnosis(run.lastFinal) : null,
    analogy: '', evidence: null, rejected: v && !v.ok ? v.rejected || null : null, note: null,
    stopText, capped, found, debug
  };
}

const isUserNode = n => n && (n.source === 'user' || String(n.id).startsWith('u:'));

/**
 * 새 비유 뒤에 보일 쓰기 제안 하나. 쓰기는 사용자가 눌러야만 background가 한다.
 * - { kind: 'pin', nodeId, tagId }: 그 문장을 이 개념으로 고정(피드백 층 pick, 로그아웃이어도 된다, 규칙 3 예외)
 * - { kind: 'example', nodeId, tagId, tagLabel, text }: 로그인 + 내 노드 + 내 태그(공통 태그 id 아님)이고
 *   corrections.js 거름(가림·길이·금칙어·중복)을 지날 때만. text는 가린 문장(넣을 예문 미리보기)
 * - null: 그래프에 없는 노드
 */
export function diagnoseAction({ graph, nodeId, tagId = null, sentence, loggedIn = false, commonTagIds = new Set(), blockTerms = [] }) {
  const node = (graph?.nodes || []).find(n => n.id === nodeId);
  if (!node) return null;
  const tags = node.tags || [];
  const tag = tagId && tags.includes(tagId) ? tagId : tags[0] || null;
  const pin = { kind: 'pin', nodeId: node.id, tagId: tag };
  if (!loggedIn || !isUserNode(node) || !tag || commonTagIds.has(tag)) return pin;
  const t = (graph.tags || []).find(x => x.id === tag);
  if (!t || t.source !== 'user') return pin;
  const { accepted } = toExampleCandidates([{ sentence, tagId: tag, nodeId: node.id, ts: 0 }], { blockTerms, existingExamples: { [tag]: t.examples || [] } });
  if (!accepted.length) return pin;
  return { kind: 'example', nodeId: node.id, tagId: tag, tagLabel: t.label || tag, text: accepted[0].text };
}

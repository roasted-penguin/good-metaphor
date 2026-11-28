// 에이전트 도구와 에이전트 1 "말풍선 이어 묻기"(T-216, ADR 0017). chrome.* 를 쓰지 않는다.
// 도구는 기존 함수를 감싼다: 병합 그래프(mergeGraphs 결과)의 노드 사실, 태그로 찾기, 그래프 검색(embedEach + retrieve는 부르는 쪽이 주입).
// 모든 도구는 읽기 전용이다. 이어 묻기는 쓰기 권한이 없다(피드백 층·내 태그 예문·초안 노드 쓰기는 에이전트 2·3 몫).
// 보내는 글은 호버와 같은 범위(제목·앞 문장·문장·단어)만이다. 문단 전송은 보류(사용자 결정 2026-11-28, ADR 0017 열린 결정 1).
// 최종 답은 규칙 1(본 노드만) → 근거 검사(checkGrounding) → 금칙어(applyBlocklist)를 지난다(규칙 1·11).
import { runAgent, AGENT_MAX_STEPS, AGENT_MAX_CALLS, AGENT_STOP_TEXT, AGENT_CAP_TEXT } from './agent.js';
import { REJECTED_TEXT } from './analogy-server.js';
import { checkGrounding, GROUNDING_REJECTED_TEXT } from './grounding.js';
import { activeTerms, applyBlocklist } from './blocklist.js';
import { impoliteEnding } from './prompt.js';

export const FOLLOWUP_QUESTIONS = { why: '왜 비슷해요?', other: '다른 비유는요?' };
export const FOLLOWUP_TOOL_NAMES = ['get_node_facts', 'search_graph', 'search_by_tag'];
export const QUESTION_MAX = 200;
export const FORMAT_REJECTED_TEXT = '답을 읽지 못했어요.';
// 프롬프트·검사 규칙 판(평가 캐시 키에 넣는다. 프롬프트나 다시 묻기 규칙을 바꾸면 올린다)
export const FOLLOWUP_PROMPT_VERSION = 'T-224.1';
const TAG_LIMIT = 5;
const SEARCH_LIMIT = 3;

// 질문 다듬기: 공백 접기, 2자 미만이면 null, 200자에서 자름
export function cleanQuestion(q) {
  const s = String(q ?? '').replace(/\s+/g, ' ').trim();
  if (s.length < 2) return null;
  return s.slice(0, QUESTION_MAX);
}

const idList = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);

// 노드 사실·태그·이웃. 없는 id면 null
export function nodeFacts(graph, nodeId) {
  const n = graph.nodes.find(x => x.id === nodeId);
  if (!n) return null;
  const tagById = new Map(graph.tags.map(t => [t.id, t]));
  const labelOf = id => graph.nodes.find(x => x.id === id)?.label || id;
  return {
    id: n.id,
    label: n.label,
    facts: [...(n.facts || [])],
    tags: (n.tags || []).map(id => ({ id, label: tagById.get(id)?.label || id })),
    neighbors: graph.edges.filter(e => e.from === n.id || e.to === n.id)
      .map(e => ({ id: e.from === n.id ? e.to : e.from, label: labelOf(e.from === n.id ? e.to : e.from), rel: e.rel }))
  };
}

// 그 태그를 가진 노드(제외 뺀 앞에서 limit개)
export function nodesByTag(graph, tagId, exclude = [], limit = TAG_LIMIT) {
  const ex = new Set(idList(exclude));
  return graph.nodes.filter(n => (n.tags || []).includes(tagId) && !ex.has(n.id)).slice(0, limit)
    .map(n => ({ id: n.id, label: n.label, facts: [...(n.facts || [])] }));
}

/**
 * 이어 묻기 도구 묶음. 결과로 돌려준 노드는 seen(Set)에 넣는다(최종 답 규칙 1의 허용 목록).
 * 결과에 사실(facts)을 실어 보낸 노드는 factsRead(Set, 선택)에도 넣는다(T-222: 사실을 읽지 않고 인용하는 답을 되묻는다).
 * 세 도구 모두 사실을 함께 돌려주므로 지금은 seen과 같지만, 사실 없는 도구가 생기면 갈린다.
 * searchGraph(text, exclude) → [{ id, label, score, tag? }] : 부르는 쪽(background)이 한 문장 임베딩 + retrieve로 만든다.
 * 사실은 검색 결과를 믿지 않고 그래프에서 다시 붙인다
 */
export function makeFollowupTools({ graph, searchGraph, seen, factsRead = new Set() }) {
  const see = list => { for (const n of list) { seen.add(n.id); factsRead.add(n.id); } return list; };
  return {
    get_node_facts: {
      run: async ({ nodeId } = {}) => {
        const f = nodeFacts(graph, nodeId);
        if (!f) throw new Error('없는 개념이에요');
        seen.add(f.id);
        factsRead.add(f.id);
        return f;
      }
    },
    search_graph: {
      run: async ({ text, exclude } = {}) => {
        const t = String(text ?? '').trim().slice(0, QUESTION_MAX);
        if (!t) throw new Error('text가 비었어요');
        const ex = idList(exclude);
        const found = (await searchGraph(t, ex)) || [];
        const nodes = found.filter(c => !ex.includes(c.id)).map(c => ({ c, n: graph.nodes.find(x => x.id === c.id) })).filter(x => x.n)
          .slice(0, SEARCH_LIMIT)
          .map(({ c, n }) => ({ id: n.id, label: n.label, score: c.score, tag: c.tag?.label || null, facts: [...(n.facts || [])] }));
        return see(nodes);
      }
    },
    search_by_tag: {
      run: async ({ tagId, exclude } = {}) => see(nodesByTag(graph, String(tagId ?? ''), exclude))
    }
  };
}

// 사용자 글 끝의 순서 안내(T-224). Groq gpt-oss는 시스템 규칙만으로는 도구를 부르지 않고 후보 이름만 보고 final을 냈다.
// 실제 id로 쓴 첫 행동 예시를 마지막 줄에 둔다. 다음 차례에도 같은 글이 앞에 붙으므로 "지금 몇 번째"라는 말은 쓰지 않는다
function firstStepNote(prev = {}, candidates = []) {
  const id = prev.evidence?.nodeId || candidates[0]?.id || null;
  const example = id ? `{"action": "get_node_facts", "args": {"nodeId": "${id}"}}` : '{"action": "search_graph", "args": {"text": "<문장의 핵심 구조>", "exclude": []}}';
  return [
    '[순서] 1) facts를 읽는 도구 호출 → 2) 그 facts로 final. 개념으로 답하려면 [지금까지]에 그 개념의 facts가 나오기 전에는 final을 내지 않는다.',
    `facts를 아직 읽지 않았다면 이번 답은 이런 모양이다: ${example}`,
    '맞는 개념이 없다고 판단할 때만 도구 없이 바로 final(nodeId null)을 낸다.'
  ].join('\n');
}

// 시스템·사용자 프롬프트. 후보 사실은 싣지 않는다(get_node_facts로 읽는다).
// T-222: 사실 읽기 먼저·usedFact 글자 그대로·"맞는 개념 없음" 기준과 예시를 더했다. 예시는 관심사와 상관없는 구조로 쓴다(식당 관심사도 같은 프롬프트)
export function buildFollowupPrompt({ domain, sentence, word, context, pageTitle, question, prev = {}, candidates = [], maxSteps = AGENT_MAX_STEPS }) {
  const system = [
    `너는 사용자가 방금 본 "${domain}" 비유에 대해 이어서 묻는 질문에 답하는 도우미다.`,
    '매 차례 JSON 객체 하나만 글자로 출력한다. 함수 호출 기능은 쓰지 않는다. 설명·코드블록 없이 둘 중 하나다.',
    '{"action": "<도구 이름>", "args": {...}}',
    '{"final": {"answer": string, "nodeId": string|null, "usedFact": string}}',
    '도구:',
    '- get_node_facts {"nodeId": string}: 개념의 사실(facts)·태그·연결',
    '- search_graph {"text": string, "exclude": [nodeId]}: 글과 구조가 비슷한 개념 찾기(exclude는 뺄 개념). 결과에 facts가 함께 온다',
    '- search_by_tag {"tagId": string, "exclude": [nodeId]}: 그 추상 태그를 가진 개념. 결과에 facts가 함께 온다',
    '근거 규칙:',
    `1. ${domain} 개념으로 답하려면 먼저 그 개념의 facts를 도구로 읽는다. 이번에 facts를 읽지 않은 개념은 nodeId로 쓰지 않는다. 후보 목록의 이름만 보고 답하지 않는다.`,
    '2. usedFact는 도구 결과 facts 배열의 문장 하나를 글자 그대로 복사한다. 줄이거나 바꿔 쓰거나 합치지 않는다. 개념 이름은 사실이 아니다.',
    `3. answer의 ${domain} 내용은 도구 결과 facts에 있는 것만 쓴다. 근거에 없는 수치, 이름, 규칙을 지어내지 않는다. facts에 없는 수치를 물으면 모른다고 답한다.`,
    '"맞는 개념 없음" 기준:',
    '4. 문장의 핵심 구조(무엇이 무엇을 제한하거나, 키우거나, 바꾸거나, 조건으로 거는지)가 개념의 facts와 구체적으로 같을 때만 비유한다. 낱말이 겹치거나 "정해진 조건", "과정", "특별한 장소", "꾸준히 해야 함" 같은 두루뭉술한 공통점은 맞는 개념이 아니다.',
    '   - 없음인 예: 날짜·시간·장소 안내(회의는 화요일 3층에서 열린다), 사물·동물의 성질 묘사(펭귄은 날지 못한다), 생활 수칙(찬물에 손세탁), 단순한 행동(기사가 길을 안내했다).',
    '   - 있음인 예: 다시 하려면 정해진 시간을 기다려야 하는 제한, 실패하면 가진 것을 잃는 위험을 감수하는 시도, 많이 풀릴수록 값이 떨어지는 재화.',
    `   없으면 {"final": {"answer": "이 문장에는 맞는 ${domain} 개념이 없어요. + 문장 뜻을 쉬운 말로 한 줄", "nodeId": null, "usedFact": ""}}로 답한다. 억지 비유는 틀린 설명보다 나쁘다. 방금 보인 비유가 억지였으면 그렇다고 말해도 된다.`,
    '5. "다른 비유"를 물으면 방금 근거 개념을 exclude에 넣고 찾는다. 찾은 개념도 4번 기준에 맞지 않으면 없다고 답한다.',
    '말투와 한도:',
    '6. answer는 해요체(~요) 1~3문장, 200자 안쪽. ~습니다·~다로 끝내지 않는다.',
    `7. 같은 도구를 같은 인자로 두 번 부르지 않는다. 최대 ${maxSteps}차례 안에 final을 낸다. 보통은 facts 읽기 한 번 뒤 바로 final이다.`,
    '8. 커뮤니티 멸칭이나 실존 인물 이름·별명은 쓰지 않는다.'
  ].join('\n');
  const cand = candidates.map(c => `- id=${c.id} | ${c.label}${c.tag ? ` | 태그: ${c.tag.label} (id=${c.tag.id})` : ''}`);
  const user = [
    `페이지 제목: ${pageTitle || '(제목 없음)'}`,
    context ? `앞 문장: ${context}` : '',
    `설명할 문장: ${sentence}`,
    word ? `커서가 가리킨 단어: ${word}` : '',
    '',
    '[방금 보인 결과]',
    prev.meaning ? `쉬운 뜻: ${prev.meaning}` : '',
    prev.analogy ? `비유: ${prev.analogy}` : '비유: (없음)',
    prev.evidence?.nodeId ? `근거 개념: id=${prev.evidence.nodeId} | ${prev.evidence.nodeLabel || ''}` : '',
    cand.length ? '후보 개념:' : '',
    ...cand,
    '',
    `질문: ${question}`,
    '',
    firstStepNote(prev, candidates)
  ].filter(s => s !== '').join('\n');
  return { system, user };
}

/**
 * 최종 답 검사. allowed = 호버 후보 ∪ 이번 실행에서 도구로 본 노드(규칙 1의 "후보").
 * 사실은 그래프 노드에서 가져온다(LLM·콘텐츠 스크립트가 준 사실을 믿지 않는다).
 * 돌려주는 값: { answer, evidence, rejected, grounding, blocked }
 */
export function finalizeAnswer({ final, graph, allowed, sentence, context, blocklist = [] }) {
  const out = { answer: '', evidence: null, rejected: null, grounding: null, blocked: null };
  const text = typeof final?.answer === 'string' ? final.answer.trim() : '';
  if (!text) return { ...out, rejected: FORMAT_REJECTED_TEXT };
  const nodeId = typeof final.nodeId === 'string' && final.nodeId ? final.nodeId : null;
  const usedFact = typeof final.usedFact === 'string' ? final.usedFact : '';
  let node = null;
  if (nodeId) {
    node = allowed.has(nodeId) ? graph.nodes.find(n => n.id === nodeId) || null : null;
    if (!node) return { ...out, rejected: REJECTED_TEXT };
  }
  // 근거 검사(T-123). 노드가 없는 답은 facts가 비어, usedFact를 대면 fact-mismatch, 숫자는 원문·앞 문장에 있어야 한다
  const labels = node ? [node.label, ...graph.edges.filter(e => e.from === node.id || e.to === node.id)
    .map(e => graph.nodes.find(n => n.id === (e.from === node.id ? e.to : e.from))?.label).filter(Boolean)] : [];
  const grounding = checkGrounding({ analogy: text, usedFact, facts: node?.facts || [], sentence, context, labels });
  if (!grounding.ok) return { ...out, grounding, rejected: GROUNDING_REJECTED_TEXT };
  // 금칙어(T-114). 답은 analogy 필드로 검사한다(applyBlocklist가 그 필드를 본다)
  const { answer: checked, blocked } = applyBlocklist({ meaning: '', analogy: text, mapping: '' }, activeTerms(blocklist));
  if (blocked) return { ...out, grounding, blocked, rejected: checked.rejected };
  return {
    answer: text,
    evidence: node ? { nodeId: node.id, nodeLabel: node.label, source: node.source, verifiedAt: node.source === 'common' ? node.verifiedAt || null : null } : null,
    rejected: null,
    grounding,
    blocked: null
  };
}

// 다시 묻기에 실을 사실 목록(글자 그대로 옮기라고 보여 준다)
const factsJSON = node => JSON.stringify(node?.facts || []);

/**
 * 최종 답을 보이기 전에 고칠 수 있는 문제를 찾는다(T-222). 없으면 null, 있으면 { reasons, feedback, read }.
 * finalizeAnswer가 숨길 답(사실 안 읽음·근거 검사·후보 밖·끝맺음)을 한 번 되물어 고칠 기회를 준다.
 * 숨기는 검사(finalizeAnswer: 규칙 1·근거 검사·금칙어)는 그대로이고, 이것은 그 앞의 교정 문구일 뿐이다.
 * - read: 피드백에 사실을 실어 보낸 노드 id(부르는 쪽이 factsRead에 넣는다)
 */
export function followupProblems({ final, graph, allowed, factsRead, sentence, context }) {
  const text = typeof final?.answer === 'string' ? final.answer.trim() : '';
  if (!text) return null; // 형식 문제는 finalizeAnswer 문구로
  const nodeId = typeof final.nodeId === 'string' && final.nodeId ? final.nodeId : null;
  const usedFact = typeof final.usedFact === 'string' ? final.usedFact : '';
  const reasons = [], notes = [], read = [];
  if (nodeId) {
    const node = allowed.has(nodeId) ? graph.nodes.find(n => n.id === nodeId) || null : null;
    if (!node) {
      reasons.push('not-allowed');
      notes.push(`nodeId "${nodeId}"는 이번에 후보나 도구 결과로 본 개념이 아니에요. 본 개념만 쓰고, 맞는 개념이 없으면 nodeId는 null이에요.`);
    } else {
      const labels = [node.label, ...graph.edges.filter(e => e.from === node.id || e.to === node.id)
        .map(e => graph.nodes.find(n => n.id === (e.from === node.id ? e.to : e.from))?.label).filter(Boolean)];
      const g = checkGrounding({ analogy: text, usedFact, facts: node.facts || [], sentence, context, labels });
      const unread = !factsRead.has(nodeId);
      if (unread) reasons.push('unread');
      if (!g.ok) reasons.push(g.reason);
      if (!normalizeUsed(usedFact)) reasons.push('no-fact');
      if (unread || !g.ok || !normalizeUsed(usedFact)) {
        read.push(node.id);
        const why = unread ? `id=${node.id}(${node.label})의 facts를 읽지 않고 답했어요.`
          : g.reason === 'number-outside' ? 'answer에 facts·문장에 없는 숫자가 있어요. 숫자를 빼거나 facts에 있는 숫자만 써요.'
            : g.reason === 'fact-mismatch' ? `usedFact가 id=${node.id}의 facts 문장과 달라요.` : 'usedFact가 비었어요.';
        notes.push(`${why} 이 개념의 facts: ${factsJSON(node)}. usedFact는 이 중 한 문장을 글자 그대로 옮기고, answer는 그 사실로만 써요. 이 facts가 문장 구조와 맞지 않으면 nodeId는 null로 없다고 답해요.`);
      }
    }
  } else {
    if (normalizeUsed(usedFact)) {
      reasons.push('fact-without-node');
      notes.push('nodeId 없이 usedFact를 댔어요. 개념을 쓰면 nodeId에 그 id를, 맞는 개념이 없으면 usedFact는 빈 문자열이에요.');
    }
    const g = checkGrounding({ analogy: text, usedFact: '', facts: [], sentence, context });
    if (!g.ok) { reasons.push(g.reason); notes.push('개념 없이 답하면 숫자는 원문 문장에 있는 것만 써요.'); }
  }
  if (impoliteEnding(text) !== null) { reasons.push('ending'); notes.push('answer의 모든 문장을 해요체(~요)로 끝내요.'); }
  if (!reasons.length) return null;
  return { reasons, read, feedback: `${notes.join(' ')} 고친 {"final": {...}} 하나로 다시 답해요.` };
}
const normalizeUsed = s => String(s ?? '').replace(/\s+/g, '');

// 최종 답 교정 되묻기 횟수 상한(T-222). 단계·호출 상한에도 든다
export const FOLLOWUP_MAX_CORRECTIONS = 1;

export const STOP_REASON = {
  steps: '단계 상한에 닿았어요.',
  calls: '호출 상한에 닿았어요.',
  repeat: '같은 확인을 되풀이해서 멈췄어요.',
  format: '모델 답을 읽지 못했어요.',
  'llm-error': '지금은 모델이 답하지 못해요.'
};

/**
 * 에이전트 1: 말풍선 이어 묻기. 상한 4단계·LLM 4회(ADR 0017).
 * - payload: { sentence, word, context, pageTitle } (호버와 같은 범위)
 * - prev: 방금 보인 결과 { meaning, analogy, evidence }
 * - candidateIds: 호버 후보 id. 그래프에 있는 것만 쓴다
 * - ask·searchGraph·budget은 주입. blocklist는 금칙어 카드 배열
 * 돌려주는 값: { answer, evidence, rejected, stopText, capped, found, debug: { trace, calls, steps, stop, grounding, blocked } }
 *   stopText: 답 없이 멈췄을 때 "여기까지 했어요. …" 또는 하루 상한 문구, 답이 있으면 null
 *   found: 이번 실행에서 본 개념 이름(멈췄을 때 지금까지 얻은 결과로 보인다)
 */
export async function runFollowup({ graph, payload, question, prev = {}, candidateIds = [], ask, searchGraph, blocklist = [], budget = null, maxSteps = AGENT_MAX_STEPS, maxCalls = AGENT_MAX_CALLS }) {
  const candidates = idList(candidateIds).map(id => graph.nodes.find(n => n.id === id)).filter(Boolean)
    .map(n => {
      const tagId = (n.tags || [])[0];
      const tag = tagId ? graph.tags.find(t => t.id === tagId) : null;
      return { id: n.id, label: n.label, tag: tag ? { id: tag.id, label: tag.label } : null };
    });
  const allowed = new Set(candidates.map(c => c.id));
  const seen = new Set();
  const factsRead = new Set();
  const tools = makeFollowupTools({ graph, searchGraph, seen, factsRead });
  const { system, user } = buildFollowupPrompt({ domain: graph.domain, ...payload, question, prev, candidates, maxSteps });
  // 검증기(T-222): 고칠 수 있는 문제가 있으면 한 번만 되묻는다. 두 번째 final은 그대로 finalizeAnswer가 판정한다(숨김 포함)
  let corrections = 0;
  let endingAsked = false;
  const verify = async (final, { stepsLeft = 1, callsLeft = 1 } = {}) => {
    // 되물을 차례가 없으면 그대로 판정한다(되묻다 상한에 닿아 답을 잃지 않게)
    if (corrections >= FOLLOWUP_MAX_CORRECTIONS || stepsLeft < 1 || callsLeft < 1) return { ok: true };
    const p = followupProblems({ final, graph, allowed: new Set([...allowed, ...seen]), factsRead, sentence: payload.sentence, context: payload.context });
    if (!p) return { ok: true };
    corrections++;
    if (p.reasons.includes('ending')) endingAsked = true;
    for (const id of p.read) { factsRead.add(id); seen.add(id); }
    return { ok: false, reason: p.reasons.join(','), feedback: p.feedback };
  };
  const run = await runAgent({ system, user, tools, ask, maxSteps, maxCalls, budget, verify, maxVerifies: FOLLOWUP_MAX_CORRECTIONS + 1 });
  const found = [...seen].map(id => graph.nodes.find(n => n.id === id)?.label).filter(Boolean);
  const debug = { trace: run.trace, calls: run.calls, steps: run.steps, stop: run.stop, corrections };
  if (!run.final) {
    const capped = run.stop === 'daily-cap';
    const stopText = capped && run.calls === 0 ? AGENT_CAP_TEXT
      : `${AGENT_STOP_TEXT} ${capped ? AGENT_CAP_TEXT : STOP_REASON[run.stop] || ''}`.trim();
    if (run.error) debug.error = run.error.slice(0, 200);
    return { answer: '', evidence: null, rejected: null, stopText, capped, found, debug };
  }
  for (const id of seen) allowed.add(id);
  const f = finalizeAnswer({ final: run.final, graph, allowed, sentence: payload.sentence, context: payload.context, blocklist });
  if (f.grounding) debug.grounding = f.grounding;
  if (f.blocked) debug.blocked = f.blocked;
  // 끝맺음(T-224): 되묻기 뒤에도 ~습니다·~다면 호버(T-122)처럼 글은 그대로 보이고 표시만 한다.
  // 끝맺음만 바꾸는 결정적 고치기는 뜻을 바꿀 수 있어 하지 않는다. 모양은 호버 debug.ending과 같다
  if (f.answer) {
    const style = impoliteEnding(f.answer);
    debug.ending = { ok: !style, retried: endingAsked, issues: style ? [{ field: 'answer', style }] : [] };
  }
  return { answer: f.answer, evidence: f.evidence, rejected: f.rejected, stopText: null, capped: false, found, debug };
}

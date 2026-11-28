// 에이전트 도구와 에이전트 1 "말풍선 이어 묻기"(T-216, ADR 0017). chrome.* 를 쓰지 않는다.
// 도구는 기존 함수를 감싼다: 병합 그래프(mergeGraphs 결과)의 노드 사실, 태그로 찾기, 그래프 검색(embedEach + retrieve는 부르는 쪽이 주입).
// 모든 도구는 읽기 전용이다. 이어 묻기는 쓰기 권한이 없다(피드백 층·내 태그 예문·초안 노드 쓰기는 에이전트 2·3 몫).
// 보내는 글은 호버와 같은 범위(제목·앞 문장·문장·단어)만이다. 문단 전송은 보류(사용자 결정 2026-11-28, ADR 0017 열린 결정 1).
// 최종 답은 규칙 1(본 노드만) → 근거 검사(checkGrounding) → 금칙어(applyBlocklist)를 지난다(규칙 1·11).
import { runAgent, AGENT_MAX_STEPS, AGENT_MAX_CALLS, AGENT_STOP_TEXT, AGENT_CAP_TEXT } from './agent.js';
import { REJECTED_TEXT } from './analogy-server.js';
import { checkGrounding, GROUNDING_REJECTED_TEXT } from './grounding.js';
import { activeTerms, applyBlocklist } from './blocklist.js';

export const FOLLOWUP_QUESTIONS = { why: '왜 비슷해요?', other: '다른 비유는요?' };
export const FOLLOWUP_TOOL_NAMES = ['get_node_facts', 'search_graph', 'search_by_tag'];
export const QUESTION_MAX = 200;
export const FORMAT_REJECTED_TEXT = '답을 읽지 못했어요.';
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
 * searchGraph(text, exclude) → [{ id, label, score, tag? }] : 부르는 쪽(background)이 한 문장 임베딩 + retrieve로 만든다.
 * 사실은 검색 결과를 믿지 않고 그래프에서 다시 붙인다
 */
export function makeFollowupTools({ graph, searchGraph, seen }) {
  const see = list => { for (const n of list) seen.add(n.id); return list; };
  return {
    get_node_facts: {
      run: async ({ nodeId } = {}) => {
        const f = nodeFacts(graph, nodeId);
        if (!f) throw new Error('없는 개념이에요');
        seen.add(f.id);
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

// 시스템·사용자 프롬프트. 후보 사실은 싣지 않는다(get_node_facts로 읽는다)
export function buildFollowupPrompt({ domain, sentence, word, context, pageTitle, question, prev = {}, candidates = [], maxSteps = AGENT_MAX_STEPS }) {
  const system = [
    `너는 사용자가 방금 본 "${domain}" 비유에 대해 이어서 묻는 질문에 답하는 도우미다.`,
    '매 차례 JSON 객체 하나만 출력한다. 둘 중 하나다.',
    '{"action": "<도구 이름>", "args": {...}}',
    '{"final": {"answer": string, "nodeId": string|null, "usedFact": string}}',
    '도구:',
    '- get_node_facts {"nodeId": string}: 개념의 사실(facts)·태그·연결',
    '- search_graph {"text": string, "exclude": [nodeId]}: 글과 구조가 비슷한 개념 찾기(exclude는 뺄 개념)',
    '- search_by_tag {"tagId": string, "exclude": [nodeId]}: 그 추상 태그를 가진 개념',
    '규칙:',
    `1. ${domain}에 관한 내용은 도구 결과의 사실(facts)만 쓴다. 근거에 없는 수치, 이름, 규칙을 지어내지 않는다.`,
    `2. answer에 ${domain} 사실을 쓰면 그 개념 id를 nodeId에, 그 개념의 facts 문장 하나를 usedFact에 글자 그대로 옮긴다.`,
    '3. 맞는 개념이 없으면 없다고 짧게 답하고 nodeId는 null, usedFact는 빈 문자열이다. 억지 비유는 틀린 설명보다 나쁘다.',
    '4. answer는 해요체(~요) 1~3문장, 200자 안쪽. ~습니다·~다로 끝내지 않는다.',
    `5. 같은 도구를 같은 인자로 두 번 부르지 않는다. 최대 ${maxSteps}차례 안에 final을 낸다.`,
    '6. 커뮤니티 멸칭이나 실존 인물 이름·별명은 쓰지 않는다.'
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
    `질문: ${question}`
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
  const tools = makeFollowupTools({ graph, searchGraph, seen });
  const { system, user } = buildFollowupPrompt({ domain: graph.domain, ...payload, question, prev, candidates, maxSteps });
  const run = await runAgent({ system, user, tools, ask, maxSteps, maxCalls, budget });
  const found = [...seen].map(id => graph.nodes.find(n => n.id === id)?.label).filter(Boolean);
  const debug = { trace: run.trace, calls: run.calls, steps: run.steps, stop: run.stop };
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
  return { answer: f.answer, evidence: f.evidence, rejected: f.rejected, stopText: null, capped: false, found, debug };
}

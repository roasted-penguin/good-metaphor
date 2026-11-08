// AI 관심사 그래프 초안 + 사용자 검수(T-301). 설정 화면·background·단위 테스트가 같이 쓰는 순수 함수(chrome.* 없음)
// 원칙
//  - LLM 출력은 믿지 않는다: 목록 밖 태그(규칙 9)·금칙어(규칙 11)·길이를 여기서 다시 거른다
//  - 초안 노드는 draft: true + factsReviewed(사실마다 확인 여부). mergeGraphs가 draft 노드를 빼서
//    사용자가 모든 사실을 확인하기 전에는 검색·비유 근거 어디에도 쓰지 않는다(규칙 1)
//  - 오버레이·노드를 직접 바꾸지 않고 새 객체를 돌려준다
import { findBlocked } from './blocklist.js';
import { makeNodeId } from './overlay-form.js';
import { withRo } from './prompt.js';

export const DRAFT_LIMITS = { name: 30, min: 10, max: 20, label: 40, facts: 3, fact: 200, tags: 3 };

const REASON = {
  shape: '노드 모양이 아니에요.',
  label: `이름은 1~${DRAFT_LIMITS.label}자여야 해요.`,
  labelBlocked: '이름에 쓸 수 없는 표현이 있어요.',
  dupLabel: '같은 이름이 이미 있어요.',
  factBlocked: '쓸 수 없는 표현이 든 사실을 뺐어요.',
  factLong: `${DRAFT_LIMITS.fact}자를 넘는 사실을 뺐어요.`,
  factMany: `사실은 ${DRAFT_LIMITS.facts}개까지라 뒤를 뺐어요.`,
  noFacts: '남은 사실이 없어요.',
  noTags: '목록에 있는 태그가 없어요.',
  overMax: `${DRAFT_LIMITS.max}개를 넘어서 뺐어요.`
};
export const NUMBER_WARNING = '숫자가 있어요. 자주 바뀌는 값이면 지워 주세요.';
export const PARSE_ERROR = 'AI 답을 초안으로 읽지 못했어요. 다시 해 보세요.';

// 관심사 이름: 공백을 뺀 1~30자. 아니면 null
export function validDraftName(name) {
  const s = String(name ?? '').trim();
  return s && s.length <= DRAFT_LIMITS.name ? s : null;
}

// 숫자(아라비아 숫자)가 든 사실인가. 사용자 데이터라 규칙 2는 경고만 한다
export const hasNumber = s => /\d/.test(String(s ?? ''));

// 코드블록·앞뒤 설명을 걷어 내고 JSON을 뽑는다. { nodes: [...] } 또는 최상위 배열. 못 읽으면 null
function extractNodes(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const tries = [cleaned];
  for (const [open, close] of [['{', '}'], ['[', ']']]) {
    const a = cleaned.indexOf(open), b = cleaned.lastIndexOf(close);
    if (a >= 0 && b > a) tries.push(cleaned.slice(a, b + 1));
  }
  for (const t of tries) {
    try {
      const v = JSON.parse(t);
      if (Array.isArray(v)) return v;
      if (Array.isArray(v?.nodes)) return v.nodes;
    } catch {}
  }
  return null;
}

const shortLabel = s => (s.length > DRAFT_LIMITS.label ? s.slice(0, DRAFT_LIMITS.label) + '…' : s);

/**
 * LLM 초안 → 검수 대기 노드.
 * @param {string} text  LLM 답
 * @param {{ tags: Array<{id}>, existingIds?: string[], blockTerms?: Array, rand?: () => number }} opts
 *   tags = 공통 태그 사전(목록 밖 id는 버린다), existingIds = 피할 id(내 노드 + 공통 노드), blockTerms = 금칙어 카드
 * @returns {{ nodes, dropped: Array<{label, reason}>, warnings: Array<{nodeId, factIndex, reason}>, error? }}
 *   버린 항목에는 금칙어 자체를 담지 않는다(이름에 있으면 '(가림)')
 */
export function parseDraft(text, { tags = [], existingIds = [], blockTerms = [], rand = Math.random } = {}) {
  const L = DRAFT_LIMITS;
  const raw = extractNodes(text);
  if (!raw) return { nodes: [], dropped: [], warnings: [], error: PARSE_ERROR };
  const tagIds = new Set((tags || []).map(t => t?.id).filter(Boolean));
  const taken = [...existingIds];
  const labels = new Set();
  const nodes = [], dropped = [], warnings = [];
  const drop = (label, reason) => dropped.push({ label, reason });

  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) { drop('', REASON.shape); continue; }
    const label = typeof item.label === 'string' ? item.label.trim() : '';
    if (!label || label.length > L.label) { drop(shortLabel(label), REASON.label); continue; }
    if (findBlocked(label, blockTerms)) { drop('(가림)', REASON.labelBlocked); continue; }
    if (labels.has(label)) { drop(label, REASON.dupLabel); continue; }

    const facts = [];
    for (const f of Array.isArray(item.facts) ? item.facts : []) {
      if (typeof f !== 'string' || !f.trim()) continue;
      const fact = f.trim();
      if (fact.length > L.fact) { drop(label, REASON.factLong); continue; }
      if (findBlocked(fact, blockTerms)) { drop(label, REASON.factBlocked); continue; }
      facts.push(fact);
    }
    if (facts.length > L.facts) { drop(label, REASON.factMany); facts.length = L.facts; }
    if (!facts.length) { drop(label, REASON.noFacts); continue; }

    const nodeTags = [...new Set(Array.isArray(item.tags) ? item.tags : [])].filter(id => tagIds.has(id)).slice(0, L.tags);
    if (!nodeTags.length) { drop(label, REASON.noTags); continue; }

    if (nodes.length >= L.max) { drop(label, REASON.overMax); continue; }
    const id = makeNodeId(label, taken, rand);
    taken.push(id);
    labels.add(label);
    facts.forEach((f, i) => { if (hasNumber(f)) warnings.push({ nodeId: id, factIndex: i, reason: NUMBER_WARNING }); });
    nodes.push({ id, label, facts, tags: nodeTags, draft: true, factsReviewed: facts.map(() => false) });
  }
  return { nodes, dropped, warnings };
}

/* ───── 검수 ───── */

// 모든 사실을 확인했으면 draft·factsReviewed를 빼 일반 노드(검색 대상)로. 아니면 그대로
export function settleDraft(node) {
  if (!node?.draft) return node;
  const rv = node.factsReviewed;
  if (!Array.isArray(rv) || rv.length !== node.facts.length || !rv.every(v => v === true)) return node;
  const { draft, factsReviewed, ...plain } = node;
  return plain;
}

const reviewed = node => (Array.isArray(node.factsReviewed) && node.factsReviewed.length === node.facts.length
  ? [...node.factsReviewed] : node.facts.map(() => false));

export function confirmFact(node, i) {
  const rv = reviewed(node);
  if (i >= 0 && i < rv.length) rv[i] = true;
  return settleDraft({ ...node, factsReviewed: rv });
}

export function confirmAllFacts(node) {
  return settleDraft({ ...node, factsReviewed: node.facts.map(() => true) });
}

// 사실 하나를 지운다. 남은 사실이 없으면 null(노드를 지우라는 뜻)
export function removeFact(node, i) {
  const rv = reviewed(node);
  const facts = node.facts.filter((_, k) => k !== i);
  if (!facts.length) return null;
  return settleDraft({ ...node, facts, factsReviewed: rv.filter((_, k) => k !== i) });
}

// T-202 수정 폼으로 초안 노드를 고친 뒤: 그대로 둔 사실(같은 글)은 이전 확인 상태, 고치거나 새로 쓴 사실은 확인된 것으로
export function reviewAfterEdit(prev, node) {
  if (!prev?.draft) return node;
  const before = new Map();
  prev.facts.forEach((f, i) => { if (!before.has(f)) before.set(f, reviewed(prev)[i]); });
  return settleDraft({ ...node, draft: true, factsReviewed: node.facts.map(f => (before.has(f) ? before.get(f) : true)) });
}

/* ───── 오버레이 ───── */

export const draftNodes = ov => (ov?.nodes || []).filter(n => n.draft === true);

export function addDraftNodes(ov, nodes) {
  return { ...ov, nodes: [...(ov.nodes || []), ...nodes] };
}

// 새 관심사로 시작(D-4 b): 공통 그래프를 끄고 이름을 관심사로. 기존 내 노드는 지우지 않는다(더하기만)
export function startNewInterest(ov, name) {
  return { ...ov, useCommon: false, domain: name, analogyPrefix: `${withRo(name)} 치면`, theme: 'neutral' };
}

/* ───── 데모 제공자 ───── */
// 키 없는 사용자·테스트용 고정 초안. 어느 관심사에나 맞는 일반 구조만 쓴다(검수 전이라 근거로는 안 쓰인다)
export function demoDraftText(name) {
  const n = name;
  const nodes = [
    [`${n} 기본기`, '기본기는 매일 조금씩 연습해야 쌓인다.', ['daily_accumulation']],
    [`${n} 실력 단계`, '다음 단계로 가려면 앞 단계를 먼저 익혀야 한다.', ['progression_gate']],
    [`${n} 장비`, '좋은 장비는 원하는 사람이 많아 구하기 어렵다.', ['scarcity_value', 'market_price']],
    [`${n} 연습량`, '처음에는 금방 늘지만 잘할수록 같은 연습으로 느는 폭이 줄어든다.', ['diminishing_returns']],
    [`${n} 휴식`, '무리하면 다시 하기 전에 쉬어야 하는 시간이 생긴다.', ['cooldown']],
    [`${n} 팀워크`, '사람마다 맡는 역할이 달라야 함께할 때 잘 된다.', ['role_division']],
    [`${n} 대회 참가`, '대회에 나가려면 정해진 기준을 넘어야 한다.', ['threshold_req']],
    [`${n} 도전`, '더 어려운 도전은 실패하면 잃는 것도 크다.', ['loss_risk']],
    [`${n} 기록`, '얼마나 잘하는지는 정해진 기록으로 비교한다.', ['efficiency_metric']],
    [`${n} 함께하기`, '여럿이 함께하면 서로에게 도움이 되는 효과가 생긴다.', ['shared_bonus']]
  ];
  return JSON.stringify({ nodes: nodes.map(([label, fact, tags]) => ({ label, facts: [fact], tags })) });
}

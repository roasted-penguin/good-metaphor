// 에이전트 2 "새 관심사 만들기 도우미"(T-225, ADR 0017). chrome.* 를 쓰지 않는 순수 모듈이다.
// Plan-and-Execute + 평가자-개선자 루프. 자율 ReAct가 아니라 코드가 순서를 쥔다(목표·평가가 정해져 있어 호출 수를 통제하기 쉽다).
//   plan     LLM: 아직 못 덮은 통제 어휘 태그(규칙 9)를 채울 개념 목록(그 관심사 팬이면 아는 것), 없는 구조는 skip
//   draft    LLM: 개념마다 노드 초안(구조 먼저, 우리 말, 수치·인물·멸칭 없음, 출처 URL은 있으면) → draft.js parseDraft 거름
//   evaluate 코드: 금칙어·수치·근접 중복(오버레이·초안 안) → LLM: 태그 적합성(노드 파이프라인과 같은 기준)·익숙함·이름
//   optimize LLM: 걸린 노드를 고쳐 쓰거나 포기(drop). 노드당 1회, 고친 노드는 다시 평가
//   (빈 태그가 남고 예산이 남으면 plan으로) → write: 통과한 노드만 검수 대기(draft: true)로 → done
// helperStep 한 번에 LLM은 많아야 한 번이다. 상태는 JSON 하나라 background가 단계마다 chrome.storage.session에 저장하고,
// 서비스 워커가 잠들었다 깨면 그 상태에서 이어 간다. 쓰기는 deps.write 하나뿐이고 초안 노드만 넘긴다(규칙 3, 공통 그래프는 받지도 않는다).
// 사용자 결정(2026-11-28): 사실 근거는 사용자 검수만, 출처 URL은 있으면 남긴다. 하루 상한은 에이전트 공통 agent.dailyCallCap.
import { findBlocked } from './blocklist.js';
import { parseDraft, DRAFT_LIMITS, startNewInterest, addDraftNodes } from './draft.js';
import { changingNumbers, structureFirst, dupIndex, normLabel, DUP_FAIL, TAG_FIT_RULES } from './node-checks.js';
import { parseJSONLoose } from './providers.js';

export const HELPER_LIMITS = {
  maxNodes: DRAFT_LIMITS.max, // 초안 최대 20개(ADR 0017)
  maxCalls: 12,               // LLM 12회(ADR 0017)
  maxSteps: 30,               // 단계(LLM 없는 단계 포함) 안전 상한
  maxRounds: 3,               // 계획 바퀴
  firstPlan: 10,              // 첫 계획 개념 수
  laterPlan: 6,               // 다음 바퀴 개념 수
  batch: 5,                   // 초안·평가·고쳐 쓰기 한 번에 다루는 노드 수
  rewrites: 1,                // 노드당 고쳐 쓰기
  tagFails: 2,                // 같은 태그가 이만큼 실패하면 "이 관심사에 없음"
  notes: 300,                 // 메모 글자
  log: 40                     // 진행 줄
};
// 남은 호출이 이보다 적으면 그 단계를 시작하지 않는다. 쓴 초안은 늘 평가를 거치게(초안 1 + 평가 1)
const NEED = { plan: 3, draft: 2, optimize: 2, evaluate: 1 };

export const HELPER_STATE_VERSION = 1;
// 가짜 LLM(e2e)·평가 도구가 단계를 알아보는 표시어. 시스템 프롬프트 첫 줄에 들어간다
export const HELPER_MARK = {
  plan: '개념 목록을 계획하는 도우미',
  draft: '계획한 개념마다 노드 초안을 쓰는 도우미',
  evaluate: '초안 노드를 검사하는 도우미',
  rewrite: '검사에 걸린 노드를 고쳐 쓰는 도우미'
};

export const HELPER_TEXT = {
  cap: '오늘 AI 도우미를 다 썼어요. 내일 다시 해 주세요.',
  calls: '호출 상한에 닿아 여기까지 했어요.',
  steps: '단계 상한에 닿아 여기까지 했어요.',
  llm: '지금은 AI를 부를 수 없어서 여기까지 했어요.',
  format: 'AI 답을 읽지 못해서 여기까지 했어요.',
  loggedOut: '로그인이 필요해요.',
  writeFail: '초안을 저장하지 못했어요.',
  running: '이미 만들고 있어요. 끝나면 다시 해 주세요.',
  notesBlocked: '메모에 쓸 수 없는 표현이 있어요.',
  demo: '데모 모드에서는 도우미를 쓸 수 없어요. "한 번에 만들기"를 써 주세요.'
};
const STOP_TEXT = { 'daily-cap': HELPER_TEXT.cap, calls: HELPER_TEXT.calls, steps: HELPER_TEXT.steps, 'llm-error': HELPER_TEXT.llm, format: HELPER_TEXT.format };

// 걸린 점(평가자·코드) → 사람이 읽는 한 줄. 고쳐 쓰기 프롬프트와 뺀 목록에 같은 문구를 쓴다
export const PROBLEM_TEXT = {
  number: '자주 바뀌는 수치가 있어요.',
  structure: '사실이 정의에 가까워요. 무엇이 무엇에 따라 어떻게 바뀌는지가 드러나야 해요.',
  tag: '태그와 사실의 구조가 맞지 않아요.',
  unfamiliar: '이 관심사를 즐기는 사람에게 익숙하지 않아요.',
  named: '실존 인물이나 상표 이름이 있어요.',
  dup: '비슷한 노드가 이미 있어요.',
  blocked: '쓸 수 없는 표현이 있어요.',
  noDraft: '초안을 받지 못했어요.',
  giveUp: '이 관심사에 맞는 구조가 없어요.',
  unchecked: '검사를 마치지 못해서 넣지 않았어요.',
  overMax: `${DRAFT_LIMITS.max}개를 넘어서 뺐어요.`
};
// 고쳐 쓰면 나아질 수 있는 것. 그 밖(중복·금칙어)은 바로 뺀다
const FIXABLE = new Set(['number', 'structure', 'tag', 'unfamiliar', 'named']);
// 고쳐 써도 남으면 받아들이는 약한 것(구조 먼저는 낱말 휴리스틱이라 오탐이 있다. 사용자 검수가 뒤에 있다)
const SOFT = new Set(['structure']);
// 이 이유로 빠지면 목표 태그 실패로 센다(같은 태그 2번이면 이 관심사에 없음)
const TAG_FAULT = new Set(['tag', 'giveUp', 'noDraft']);

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const clip = (s, n) => String(s ?? '').slice(0, n);
const httpUrl = u => { try { const x = new URL(u); return (x.protocol === 'https:' || x.protocol === 'http:') && u.length <= 300; } catch { return false; } };

// 메모: 앞뒤 공백을 빼고 300자. 금칙어가 있으면 null(관심사 이름처럼 막는다, 규칙 11)
export function cleanNotes(notes, blockTerms = []) {
  const s = String(notes ?? '').trim().slice(0, HELPER_LIMITS.notes);
  if (s && findBlocked(s, blockTerms)) return null;
  return s;
}

export function newHelperState({ name, notes = '', mode = 'add', now = Date.now() } = {}) {
  return {
    v: HELPER_STATE_VERSION, status: 'running', phase: 'plan',
    name, notes, mode: mode === 'new' ? 'new' : 'add', startedAt: now, updatedAt: now,
    calls: 0, steps: 0, round: 0,
    pending: [], queue: [], fix: [], accepted: [], dropped: [],
    tagFails: {}, absentTags: [], log: [],
    stop: null, error: null, written: 0
  };
}

/* ───── 프롬프트 ───── */

const tagLine = t => `- ${t.id} | ${t.label} — ${t.desc || ''}${t.examples?.[0] ? ` (예: ${t.examples[0]})` : ''}`;
const COMMON_RULES = [
  '자주 바뀌는 수치(가격·확률·날짜·최대 단계·시간·인원)는 쓰지 않는다. 숫자 대신 구조와 규칙을 쓴다.',
  '실존 인물의 이름·별명, 특정 상표·회사 이름, 커뮤니티 멸칭은 쓰지 않는다.',
  '사실을 지어내지 않는다. 널리 알려진 확실한 것만 쓰고, 모르면 뺀다.'
];

export function buildPlanPrompt({ name, notes = '', tags, targetTags, avoid = [], n }) {
  const want = new Set(targetTags);
  const system = [
    `너는 사용자의 관심사 "${name}"의 ${HELPER_MARK.plan}다. 이 개념들은 나중에 낯선 문장을 그 관심사에 빗대 설명할 때 근거로 쓰인다.`,
    '규칙:',
    `1. "${name}"을 즐기는 사람이면 누구나 바로 떠올리는 익숙한 개념만 고른다. 전문가만 아는 용어·제도는 고르지 않는다.`,
    '2. 개념마다 [채울 태그] 중 하나(tag)를 정한다. 그 개념이 "무엇이 무엇에 따라 어떻게 바뀌는가"라는 태그의 구조를 실제로 가져야 한다. 서로 다른 태그를 넓게 덮는다.',
    `3. 이 관심사에 그 구조가 정말 없으면 억지로 만들지 말고 그 태그 id를 skip에 넣는다.`,
    `4. [피할 이름]과 같거나 거의 같은 개념은 고르지 않는다. 개념은 많아야 ${n}개.`,
    ...COMMON_RULES.map((r, i) => `${i + 5}. ${r}`),
    `${COMMON_RULES.length + 5}. JSON 객체만 출력한다. 형식: {"concepts": [{"label": "개념 이름(40자 이내)", "tag": "태그 id", "why": "한 줄"}], "skip": ["태그 id"]}`
  ].join('\n');
  const user = [
    `관심사: ${name}`,
    ...(notes ? [`사용자 메모: ${notes}`] : []),
    `개념 수: 많아야 ${n}개`,
    '',
    '[채울 태그]',
    ...tags.filter(t => want.has(t.id)).map(tagLine),
    '',
    '[피할 이름]',
    ...(avoid.length ? avoid.map(a => `- ${a}`) : ['- 없음'])
  ].join('\n');
  return { system, user };
}

export function buildConceptDraftPrompt({ name, notes = '', concepts, tags }) {
  const byId = new Map(tags.map(t => [t.id, t]));
  const system = [
    `너는 사용자의 관심사 "${name}"에서 ${HELPER_MARK.draft}다.`,
    '규칙:',
    `1. [개념]마다 노드 하나: label(그대로), facts(사실 1~${DRAFT_LIMITS.facts}개, 각 ${DRAFT_LIMITS.fact}자 이내), tags(아래 [추상 태그] id 1~${DRAFT_LIMITS.tags}개, 정한 태그를 먼저).`,
    '2. 첫 사실은 구조 먼저: 그 개념이 어떻게 움직이는지(무엇이 무엇에 따라 어떻게 바뀌는가)를 한국어 평서문("~다") 한 문장으로 쓴다. 정의만 쓰지 않는다.',
    '3. 어디서 베끼지 말고 우리 말로 쓴다. 목록 밖 태그는 쓰지 않는다.',
    ...COMMON_RULES.map((r, i) => `${i + 4}. ${r}`),
    `${COMMON_RULES.length + 4}. 확인할 수 있는 공개 출처 주소를 알면 source에 적고, 모르면 source를 빼거나 빈 글자로 둔다(지어내지 않는다).`,
    `${COMMON_RULES.length + 5}. JSON 객체만 출력한다. 형식: {"nodes": [{"label": string, "facts": [string], "tags": [string], "source": string}]}`
  ].join('\n');
  const user = [
    `관심사: ${name}`,
    ...(notes ? [`사용자 메모: ${notes}`] : []),
    '',
    '[개념]',
    ...concepts.map(c => `- ${c.label} | 태그 ${c.tag} — ${byId.get(c.tag)?.desc || ''}`),
    '',
    '[추상 태그]',
    ...tags.map(t => `- ${t.id} | ${t.label} — ${t.desc || ''}`)
  ].join('\n');
  return { system, user };
}

const nodeBlock = (n, byId, extra = []) => [
  `[노드] id=${n.id} | ${n.label}`,
  ...n.facts.map(f => `  - ${f}`),
  ...(n.tags || []).map(id => byId.get(id)).filter(Boolean).map(t => [
    `  태그 ${t.id} | ${t.label} — ${t.desc || ''}`,
    ...(t.examples || []).slice(0, 2).map(e => `    예: ${e}`)
  ].join('\n')),
  ...extra
].join('\n');

export function buildEvalPrompt({ name, nodes, tags }) {
  const byId = new Map(tags.map(t => [t.id, t]));
  const system = [
    `너는 관심사 "${name}"의 ${HELPER_MARK.evaluate}다.`,
    ...TAG_FIT_RULES,
    '노드마다 세 가지를 판단한다.',
    '1. tags: 노드에 단 태그마다 verdict(yes 또는 no)와 이유 한 줄.',
    `2. familiar: "${name}"을 즐기는 보통 사람이 이 개념의 이름과 사실을 읽고 바로 떠올릴 수 있으면 yes. 전문가만 아는 용어·제도·절차면 no.`,
    '3. named: 이름이나 사실에 실존 인물, 특정 상표·회사·가게 이름이 있으면 yes, 없으면 no. 일반 명사는 no.',
    'JSON 객체만 출력한다. 형식: {"nodes": [{"id": "노드 id", "tags": [{"id": "태그 id", "verdict": "yes", "reason": "한국어 한 문장"}], "familiar": "yes", "named": "no", "reason": "한국어 한 문장"}]}'
  ].join('\n');
  const user = [`관심사: ${name}`, '', ...nodes.map(n => nodeBlock(n, byId))].join('\n');
  return { system, user };
}

export function buildRewritePrompt({ name, items, tags }) {
  const byId = new Map(tags.map(t => [t.id, t]));
  const system = [
    `너는 관심사 "${name}"에서 ${HELPER_MARK.rewrite}다.`,
    '규칙:',
    '1. [노드]마다 "걸린 점"을 고친 노드를 같은 id로 다시 쓴다. 태그는 아래 [추상 태그] id만, 사실 구조와 정말 맞는 것만 단다.',
    '2. 첫 사실은 무엇이 무엇에 따라 어떻게 바뀌는지가 드러나는 한국어 평서문("~다")이다.',
    ...COMMON_RULES.map((r, i) => `${i + 3}. ${r}`),
    `${COMMON_RULES.length + 3}. 고쳐도 이 관심사에서 그 구조를 가진 익숙한 개념이 될 수 없으면 억지로 쓰지 말고 {"id": "노드 id", "drop": true, "reason": "한 줄"}로 답한다.`,
    `${COMMON_RULES.length + 4}. JSON 객체만 출력한다. 형식: {"nodes": [{"id": string, "label": string, "facts": [string], "tags": [string], "source": string} 또는 {"id": string, "drop": true, "reason": string}]}`
  ].join('\n');
  const user = [
    `관심사: ${name}`,
    '',
    ...items.map(({ node, problems }) => nodeBlock(node, byId, problems.map(p => `  걸린 점: ${PROBLEM_TEXT[p] || p}`))),
    '',
    '[추상 태그]',
    ...tags.map(t => `- ${t.id} | ${t.label} — ${t.desc || ''}`)
  ].join('\n');
  return { system, user };
}

/* ───── 답 읽기 ───── */

const readObj = text => {
  const j = parseJSONLoose(String(text ?? '').replace(/```(?:json)?/gi, ''));
  return isObj(j) ? j : null;
};

// 계획 답 → { concepts: [{label, tag, why}], skip, dropped } | null. 목록 밖 태그·금칙어 이름·중복·피할 이름은 버린다
export function parsePlan(text, { tagIds, blockTerms = [], avoid = [], n = HELPER_LIMITS.firstPlan } = {}) {
  const j = readObj(text);
  if (!j || !Array.isArray(j.concepts)) return null;
  const seen = new Set(avoid.map(normLabel));
  const concepts = [], dropped = [];
  for (const c of j.concepts) {
    const label = typeof c?.label === 'string' ? c.label.trim() : '';
    if (!label || label.length > DRAFT_LIMITS.label) continue;
    if (findBlocked(label, blockTerms)) { dropped.push({ label: '(가림)', reason: PROBLEM_TEXT.blocked }); continue; }
    if (!tagIds.has(c.tag)) continue;
    const key = normLabel(label);
    if (seen.has(key)) continue;
    seen.add(key);
    if (concepts.length >= n) break;
    concepts.push({ label, tag: c.tag, why: clip(c.why, 120) });
  }
  const skip = [...new Set(Array.isArray(j.skip) ? j.skip : [])].filter(id => tagIds.has(id));
  return { concepts, skip, dropped };
}

// 평가 답 → Map(id → { tags: Map(tagId → {verdict, reason}), familiar, named, reason }) | null
export function parseEval(text) {
  const j = readObj(text);
  const list = Array.isArray(j?.nodes) ? j.nodes : null;
  if (!list) return null;
  const out = new Map();
  for (const x of list) {
    if (!isObj(x) || typeof x.id !== 'string' || out.has(x.id)) continue;
    const tags = new Map();
    for (const t of Array.isArray(x.tags) ? x.tags : []) {
      if (isObj(t) && typeof t.id === 'string' && (t.verdict === 'yes' || t.verdict === 'no')) tags.set(t.id, { verdict: t.verdict, reason: clip(t.reason, 160) });
    }
    out.set(x.id, {
      tags,
      familiar: x.familiar === 'no' ? 'no' : x.familiar === 'yes' ? 'yes' : null,
      named: x.named === 'yes' ? 'yes' : x.named === 'no' ? 'no' : null,
      reason: clip(x.reason, 160)
    });
  }
  return out;
}

// 고쳐 쓰기 답 → Map(id → { drop, reason } | { label, facts, tags, source }) | null
export function parseRewrite(text) {
  const j = readObj(text);
  const list = Array.isArray(j?.nodes) ? j.nodes : null;
  if (!list) return null;
  const out = new Map();
  for (const x of list) {
    if (!isObj(x) || typeof x.id !== 'string' || out.has(x.id)) continue;
    out.set(x.id, x.drop === true ? { drop: true, reason: clip(x.reason, 160) } : x);
  }
  return out;
}

/* ───── 단계 ───── */

const tagIdSet = deps => new Set(deps.tags.map(t => t.id));
const limitsOf = deps => ({ ...HELPER_LIMITS, ...(deps.limits || {}) });
const liveCount = s => s.accepted.length + s.queue.length + s.fix.length;
const takenIds = (s, deps) => [...(deps.reservedIds || []), ...(deps.existing || []).map(n => n.id), ...s.accepted.map(n => n.id), ...s.queue.map(n => n.id), ...s.fix.map(f => f.node.id)];
const covered = s => new Set(s.accepted.flatMap(n => n.tags));

function addLog(s, phase, text) {
  s.log.push({ phase, text });
  if (s.log.length > HELPER_LIMITS.log) s.log.splice(0, s.log.length - HELPER_LIMITS.log);
}

function failTag(s, tag, limits) {
  if (!tag) return;
  s.tagFails[tag] = (s.tagFails[tag] || 0) + 1;
  if (s.tagFails[tag] >= limits.tagFails && !s.absentTags.includes(tag)) s.absentTags.push(tag);
}
function drop(s, node, reason, limits) {
  s.dropped.push({ label: node.label, reason: PROBLEM_TEXT[reason] || reason });
  if (TAG_FAULT.has(reason)) failTag(s, node.target, limits);
}

// LLM 한 번. { text } 또는 { stop }. 호출 상한 → 하루 상한(budget) 순으로 본다
async function callLLM(s, deps, limits, system, user) {
  if (s.calls >= limits.maxCalls) return { stop: 'calls' };
  if (deps.budget && !(await deps.budget.take())) return { stop: 'daily-cap' };
  s.calls++;
  try { return { text: await deps.ask(system, user, { json: true, jsonObject: true, maxTokens: 4000 }) }; }
  catch (e) { return { stop: 'llm-error', error: String(e?.message || e).slice(0, 200) }; }
}

// 멈춤: 평가를 거치지 않은 초안은 넣지 않고(뺀 목록에 이유) 쓰기 단계로
function halt(s, stop, error = null) {
  s.stop = stop;
  if (error) s.error = error;
  s.pending = [];
  for (const n of s.queue) s.dropped.push({ label: n.label, reason: PROBLEM_TEXT.unchecked });
  for (const f of s.fix) s.dropped.push({ label: f.node.label, reason: PROBLEM_TEXT.unchecked });
  s.queue = []; s.fix = [];
  s.phase = 'write';
  addLog(s, 'stop', STOP_TEXT[stop] || HELPER_TEXT.format);
}

// 할 일이 남았는지 보고 다음 단계를 정한다(남은 호출이 모자라면 멈춤)
function next(s, limits, tagIds) {
  const left = limits.maxCalls - s.calls;
  if (s.queue.length) { s.phase = left >= NEED.evaluate ? 'evaluate' : 'halt:calls'; }
  else if (s.fix.length) {
    if (left >= NEED.optimize) s.phase = 'optimize';
    else { for (const f of s.fix) s.dropped.push({ label: f.node.label, reason: PROBLEM_TEXT[f.problems[0]] || PROBLEM_TEXT.unchecked }); s.fix = []; return next(s, limits, tagIds); }
  }
  else if (s.pending.length) s.phase = left >= NEED.draft ? 'draft' : 'halt:calls';
  else {
    const target = targetTags(s, tagIds);
    const room = limits.maxNodes - liveCount(s);
    if (!target.length || room <= 0 || s.round >= limits.maxRounds) s.phase = 'write';
    else s.phase = left >= NEED.plan ? 'plan' : 'halt:calls';
  }
  if (s.phase === 'halt:calls') halt(s, 'calls');
}

const targetTags = (s, tagIds) => { const c = covered(s); return [...tagIds].filter(t => !c.has(t) && !s.absentTags.includes(t)); };

async function stepPlan(s, deps, limits) {
  const tagIds = tagIdSet(deps);
  const target = targetTags(s, tagIds);
  const n = Math.min(s.round === 0 ? limits.firstPlan : limits.laterPlan, limits.maxNodes - liveCount(s));
  const avoid = [...(deps.existing || []).map(x => x.label), ...s.accepted.map(x => x.label), ...s.dropped.map(x => x.label).filter(l => l !== '(가림)')];
  const { system, user } = buildPlanPrompt({ name: s.name, notes: s.notes, tags: deps.tags, targetTags: target, avoid: [...new Set(avoid)], n });
  const r = await callLLM(s, deps, limits, system, user);
  if (r.stop) return halt(s, r.stop, r.error);
  s.round++;
  const p = parsePlan(r.text, { tagIds, blockTerms: deps.blockTerms, avoid, n });
  if (!p) {
    addLog(s, 'plan', '계획 답을 읽지 못했어요.');
    if (s.round === 1) return halt(s, 'format');
    return next(s, limits, tagIds);
  }
  s.dropped.push(...p.dropped);
  for (const t of p.skip) if (target.includes(t) && !s.absentTags.includes(t)) s.absentTags.push(t);
  s.pending = p.concepts;
  addLog(s, 'plan', `${s.round}바퀴 계획: 개념 ${p.concepts.length}개${p.skip.length ? `, 이 관심사에 없는 구조 ${p.skip.length}개` : ''}`);
  // 더 고를 개념이 없다고 하면 바퀴를 더 돌지 않는다(같은 질문을 되풀이해 호출을 쓰지 않게)
  if (!p.concepts.length) { s.phase = 'write'; return; }
  next(s, limits, tagIds);
}

async function stepDraft(s, deps, limits) {
  const tagIds = tagIdSet(deps);
  const batch = s.pending.slice(0, limits.batch);
  const { system, user } = buildConceptDraftPrompt({ name: s.name, notes: s.notes, concepts: batch, tags: deps.tags });
  const r = await callLLM(s, deps, limits, system, user);
  if (r.stop) return halt(s, r.stop, r.error);
  s.pending = s.pending.slice(batch.length);
  const parsed = parseDraft(r.text, { tags: deps.tags, existingIds: takenIds(s, deps), blockTerms: deps.blockTerms, rand: deps.rand });
  const raw = readObj(r.text)?.nodes;
  const sourceOf = label => {
    const it = Array.isArray(raw) ? raw.find(x => isObj(x) && typeof x.label === 'string' && x.label.trim() === label) : null;
    return it && typeof it.source === 'string' && httpUrl(it.source.trim()) ? it.source.trim() : null;
  };
  const byLabel = new Map(batch.map(c => [normLabel(c.label), c]));
  const got = new Set();
  let added = 0;
  for (const nd of parsed.nodes) {
    // 계획한 개념만 받는다(계획 밖 덤 노드는 버린다: 목표 태그가 없고 상한을 흐린다)
    const c = byLabel.get(normLabel(nd.label));
    if (!c || got.has(normLabel(c.label))) continue;
    got.add(normLabel(c.label));
    if (liveCount(s) >= limits.maxNodes) { s.dropped.push({ label: nd.label, reason: PROBLEM_TEXT.overMax }); continue; }
    const src = sourceOf(nd.label);
    s.queue.push({ id: nd.id, label: nd.label, facts: nd.facts, tags: nd.tags, ...(src ? { sources: [src] } : {}), target: c.tag, rewrites: 0, evalTries: 0 });
    added++;
  }
  for (const d of parsed.dropped) s.dropped.push(d);
  for (const c of batch) if (!got.has(normLabel(c.label))) drop(s, { label: c.label, target: c.tag }, 'noDraft', limits);
  addLog(s, 'draft', `초안 ${added}개를 썼어요.`);
  next(s, limits, tagIds);
}

// 코드 검사: 금칙어·수치·구조 먼저. 근접 중복은 따로(색인이 필요)
function codeProblems(node, deps) {
  const out = [];
  if (findBlocked(node.label, deps.blockTerms) || node.facts.some(f => findBlocked(f, deps.blockTerms))) out.push('blocked');
  if (node.facts.some(f => changingNumbers(f).length)) out.push('number');
  if (!structureFirst(node.facts[0])) out.push('structure');
  return out;
}

function dupOf(index, node) {
  const near = index.nearest(node);
  return !!near.same || (near.best && near.best.score >= DUP_FAIL);
}

// 평가 끝난 노드 하나의 갈 곳: 통과(accepted) / 고쳐 쓰기(fix) / 뺌(dropped)
function settle(s, node, problems, limits) {
  const hard = problems.filter(p => !FIXABLE.has(p));
  if (hard.length) return drop(s, node, hard[0], limits);
  const real = problems.filter(p => !SOFT.has(p));
  if (!problems.length || (!real.length && node.rewrites >= limits.rewrites)) {
    if (s.accepted.length >= limits.maxNodes) return drop(s, node, 'overMax', limits);
    if (node.target && !node.tags.includes(node.target)) failTag(s, node.target, limits);
    s.accepted.push(node);
    return;
  }
  if (node.rewrites < limits.rewrites) { s.fix.push({ node, problems }); return; }
  drop(s, node, real[0], limits);
}

async function stepEvaluate(s, deps, limits) {
  const tagIds = tagIdSet(deps);
  const batch = s.queue.slice(0, limits.batch);
  s.queue = s.queue.slice(batch.length);
  // 근접 중복 색인: 오버레이(검수 대기 포함) + 통과 + 고쳐 쓰는 중 + 이번 묶음 앞 노드
  const index = dupIndex([...(deps.existing || []), ...s.accepted, ...s.fix.map(f => f.node)]);
  const toAsk = [], codeOf = new Map();
  for (const node of batch) {
    const probs = codeProblems(node, deps);
    if (dupOf(index, node)) probs.unshift('dup');
    index.add(node);
    codeOf.set(node.id, probs);
    // 코드에서 이미 고쳐 쓸 것(수치·중복·금칙어)이 나오면 LLM에 묻지 않는다(호출 아낌). 구조 먼저만 걸린 것은 묻는다
    if (probs.every(p => SOFT.has(p))) toAsk.push(node);
  }
  let verdicts = new Map(), unread = false;
  if (toAsk.length) {
    const { system, user } = buildEvalPrompt({ name: s.name, nodes: toAsk, tags: deps.tags });
    const r = await callLLM(s, deps, limits, system, user);
    if (r.stop) { s.queue = [...toAsk, ...s.queue]; for (const n of batch.filter(b => !toAsk.includes(b))) settle(s, n, codeOf.get(n.id), limits); return halt(s, r.stop, r.error); }
    const v = parseEval(r.text);
    if (!v) {
      unread = true;
      for (const n of toAsk) {
        n.evalTries = (n.evalTries || 0) + 1;
        if (n.evalTries >= 2) s.dropped.push({ label: n.label, reason: PROBLEM_TEXT.unchecked });
        else s.queue.push(n);
      }
      addLog(s, 'evaluate', '검사 답을 읽지 못했어요.');
    } else verdicts = v;
  }
  const before = { a: s.accepted.length, f: s.fix.length, d: s.dropped.length };
  for (const node of batch) {
    const probs = [...codeOf.get(node.id)];
    if (toAsk.includes(node)) {
      const v = verdicts.get(node.id);
      if (unread) continue; // 위에서 다시 묻기(큐) 또는 뺌으로 정리했다
      if (!v) { s.dropped.push({ label: node.label, reason: PROBLEM_TEXT.unchecked }); continue; }
      const keep = node.tags.filter(t => v.tags.get(t)?.verdict !== 'no');
      node.tags = keep;
      if (!keep.length) probs.push('tag');
      if (v.familiar === 'no') probs.push('unfamiliar');
      if (v.named === 'yes') probs.push('named');
    }
    settle(s, node, probs, limits);
  }
  addLog(s, 'evaluate', `검사: 통과 ${s.accepted.length - before.a} · 고쳐 쓰기 ${s.fix.length - before.f} · 뺌 ${s.dropped.length - before.d}`);
  next(s, limits, tagIds);
}

async function stepOptimize(s, deps, limits) {
  const tagIds = tagIdSet(deps);
  const batch = s.fix.slice(0, limits.batch);
  const { system, user } = buildRewritePrompt({ name: s.name, items: batch, tags: deps.tags });
  const r = await callLLM(s, deps, limits, system, user);
  if (r.stop) return halt(s, r.stop, r.error);
  s.fix = s.fix.slice(batch.length);
  const out = parseRewrite(r.text);
  let rewritten = 0, gaveUp = 0;
  for (const { node, problems } of batch) {
    const x = out?.get(node.id);
    if (!x) { drop(s, node, problems.find(p => !SOFT.has(p)) || problems[0], limits); continue; }
    if (x.drop) { drop(s, node, 'giveUp', limits); gaveUp++; continue; }
    // 고친 노드도 같은 거름(parseDraft: 목록 밖 태그·금칙어·길이)을 지난다. id는 그대로 둔다
    const p = parseDraft(JSON.stringify({ nodes: [{ label: x.label ?? node.label, facts: x.facts, tags: x.tags }] }), { tags: deps.tags, existingIds: [], blockTerms: deps.blockTerms, rand: deps.rand });
    const nd = p.nodes[0];
    if (!nd) { drop(s, node, p.dropped.some(d => /표현/.test(d.reason)) ? 'blocked' : problems[0], limits); continue; }
    const src = typeof x.source === 'string' && httpUrl(x.source.trim()) ? [x.source.trim()] : node.sources;
    s.queue.push({ id: node.id, label: nd.label, facts: nd.facts, tags: nd.tags, ...(src ? { sources: src } : {}), target: node.target, rewrites: node.rewrites + 1, evalTries: 0 });
    rewritten++;
  }
  addLog(s, 'optimize', `고쳐 쓰기 ${rewritten}개${gaveUp ? ` · 포기 ${gaveUp}개` : ''}`);
  next(s, limits, tagIds);
}

async function stepWrite(s, deps) {
  const nodes = helperDraftNodes(s.accepted);
  if (nodes.length) {
    try {
      const r = await deps.write(nodes, s);
      s.written = r?.written ?? nodes.length;
    } catch (e) {
      s.status = 'error';
      s.error = String(e?.message || e).slice(0, 200) || HELPER_TEXT.writeFail;
      s.phase = 'done';
      addLog(s, 'write', s.error);
      return;
    }
    addLog(s, 'write', `검수 대기에 ${s.written}개를 넣었어요.`);
  }
  s.phase = 'done';
  s.status = 'done';
}

/**
 * 한 단계. 입력을 바꾸지 않고 새 상태를 돌려준다(끝난 상태면 그대로 돌려준다).
 * deps: { ask(system, user, opts) → 글, budget?: { take() → bool }, tags, blockTerms, existing(오버레이 노드), reservedIds,
 *         write(nodes, state) → { written }, now?, rand?, limits? }
 */
export async function helperStep(state, deps) {
  if (!state || state.status !== 'running') return state;
  const s = structuredClone(state);
  const limits = limitsOf(deps);
  s.steps++;
  s.updatedAt = (deps.now || Date.now)();
  if (s.steps > limits.maxSteps && s.phase !== 'write' && s.phase !== 'done') { halt(s, 'steps'); return s; }
  switch (s.phase) {
    case 'plan': await stepPlan(s, deps, limits); break;
    case 'draft': await stepDraft(s, deps, limits); break;
    case 'evaluate': await stepEvaluate(s, deps, limits); break;
    case 'optimize': await stepOptimize(s, deps, limits); break;
    case 'write': await stepWrite(s, deps); break;
    default: s.status = 'error'; s.error = `모르는 단계: ${String(s.phase).slice(0, 20)}`; s.phase = 'done';
  }
  return s;
}

// 끝날 때까지 돈다. save(state)를 단계마다 부른다(background: chrome.storage.session)
export async function runHelper(state, deps, { save = async () => {} } = {}) {
  let s = state;
  while (s && s.status === 'running') {
    s = await helperStep(s, deps);
    await save(s);
  }
  return s;
}

/* ───── 쓰기 ───── */

// 내부 필드(target·rewrites·evalTries)를 버리고 검수 대기 노드로: draft: true, factsReviewed 모두 false, u: id만, 출처는 http(s)만
export function helperDraftNodes(nodes) {
  const out = [];
  for (const n of nodes || []) {
    if (!n || typeof n.id !== 'string' || !n.id.startsWith('u:') || !Array.isArray(n.facts) || !n.facts.length) continue;
    const sources = (Array.isArray(n.sources) ? n.sources : []).filter(u => typeof u === 'string' && httpUrl(u));
    out.push({ id: n.id, label: n.label, facts: [...n.facts], tags: [...n.tags], ...(sources.length ? { sources } : {}), draft: true, factsReviewed: n.facts.map(() => false) });
  }
  return out;
}

// 오버레이에 초안을 붙인다. 기존 노드·설정은 그대로(뒤에 붙이기만), id가 겹치면 새 u: id. new면 새 관심사로 시작(startNewInterest)
export function mergeHelperDrafts(ov, nodes, { name, mode = 'add', reservedIds = [], rand = Math.random } = {}) {
  const base = mode === 'new' ? startNewInterest({ ...ov }, name) : { ...ov };
  return addDraftNodes(base, helperDraftNodes(nodes), { reservedIds, rand });
}

/* ───── 화면용 ───── */

// 설정 화면에 보일 요약. 노드 사실은 싣지 않는다(검수 대기에서 본다)
export function helperView(s, tags = []) {
  if (!s) return null;
  const label = new Map(tags.map(t => [t.id, t.label]));
  const stopText = s.status === 'error' ? (s.error || HELPER_TEXT.writeFail) : (s.stop ? STOP_TEXT[s.stop] || '' : '');
  let doneText = '';
  if (s.status === 'done') {
    // 멈춤 이유가 있으면 그것만(상한인데 "이름을 바꿔 보라"고 하지 않는다), 넣은 초안이 있으면 그 뒤에 덧붙인다
    if (s.written) doneText = `초안 ${s.written}개를 검수 대기에 넣었어요. 사실을 하나씩 확인해 주세요.${stopText ? ` ${stopText}` : ''}`;
    else doneText = stopText || '쓸 수 있는 초안이 없어요. 이름을 바꿔 다시 해 보세요.';
  }
  return {
    status: s.status, phase: s.phase, name: s.name, mode: s.mode, round: s.round,
    calls: s.calls, steps: s.steps, accepted: s.accepted.length, waiting: s.pending.length + s.queue.length + s.fix.length,
    written: s.written, log: s.log.map(l => ({ ...l })), dropped: s.dropped.map(d => ({ ...d })),
    absentTags: s.absentTags.map(id => ({ id, label: label.get(id) || id })),
    stop: s.stop, stopText, doneText, updatedAt: s.updatedAt
  };
}

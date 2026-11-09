// 교정 → 예문 후보·평가셋 후보 (T-131, ADR 0010 3단계). 순수 함수만 둔다. chrome.* 를 쓰지 않는다(운영자 Node 도구도 같이 씀).
//
// 교정 = 말풍선 "더 맞는 개념"과 비유 없음 화면의 후보 선택. 둘 다 피드백 기록 { vote: 'pick', pickedNodeId } 모양이다.
// - 내 그래프(사용자 노드 + 내 태그)면 그 태그 examples에 바로 넣는다(로그인 세션만, 규칙 3 — background.js가 부른다).
// - 공통 그래프면 운영자 승인 큐(JSON 내보내기)로만. 공통 그래프·tags.json·공통 태그는 코드가 바꾸지 않는다(규칙 3·9).
// 예문 후보는 항상 가린 문장(maskSentence)이고, 금칙어(규칙 11)·평가 문장 베끼기·중복·길이로 거른다.
import { maskSentence } from './feedback.js';
import { findBlocked } from './blocklist.js';
import { charJaccard } from './grounding.js';
import { feedbackForGraph } from './feedback.js';
import { DEFAULT_INTEREST } from './graph.js';

export const EXAMPLE_CAP = 5;       // 태그당 교정 예문 상한(손으로 적은 예문은 세지 않는다)
export const EVAL_COPY_MIN = 0.5;   // 평가·검증·가드 문장과 이 이상 비슷하면 베끼기
export const DUPLICATE_MIN = 0.8;   // 그 태그 기존 예문과 이 이상 비슷하면 중복
export const MIN_LENGTH = 8;
export const MAX_LENGTH = 200;
export const EXPORT_KIND = 'good-metaphor-corrections';

const isUserNode = n => n && (n.source === 'user' || String(n.id).startsWith('u:'));
const byTs = (a, b) => (a.ts || 0) - (b.ts || 0);
// 길이 판정용 정규화: 앞뒤 공백을 떼고 연속 공백을 하나로
const squash = s => String(s ?? '').replace(/\s+/g, ' ').trim();

// 노드의 태그 중 기록이 고른 태그(그 노드 태그일 때만), 없으면 tags[0]
function tagFor(node, wanted) {
  const tags = node?.tags || [];
  return wanted && tags.includes(wanted) ? wanted : tags[0] || null;
}

/**
 * 피드백 기록 → 교정. pick 기록만, 같은 문장은 가장 최근 하나만.
 * tagId: 기록의 pickedTagId(말풍선이 보낸 고른 개념의 최고 태그)가 그 노드 태그면 그것, 아니면 노드 tags[0].
 * 그래프에 없는 노드(지운 내 노드)는 뺀다. 되돌린 기록은 이미 목록에 없다.
 * @returns {Array<{ sentence, sentenceHash, nodeId, tagId, source: 'pick', ts }>}
 */
export function collectCorrections(records, graph) {
  const nodes = new Map((graph?.nodes || []).map(n => [n.id, n]));
  const latest = new Map(); // sentenceHash -> 기록
  for (const r of [...(records || [])].sort(byTs)) {
    if (r?.vote === 'pick' && r.pickedNodeId) latest.set(r.sentenceHash, r);
  }
  const out = [];
  for (const r of latest.values()) {
    const node = nodes.get(r.pickedNodeId);
    const tagId = tagFor(node, r.pickedTagId);
    if (!node || !tagId) continue;
    out.push({ sentence: r.sentence, sentenceHash: r.sentenceHash, nodeId: node.id, tagId, source: 'pick', ts: r.ts });
  }
  return out;
}

/**
 * 👍 기록 → 회귀 가드 후보. 같은 문장은 가장 최근 👍 하나, 그 뒤에 같은 노드 👎나 pick이 온 문장은 뺀다.
 * @returns {Array<{ sentence, nodeId, tagId, source: 'up' }>}
 */
export function collectPraise(records, graph) {
  const nodes = new Map((graph?.nodes || []).map(n => [n.id, n]));
  const latest = new Map(); // sentenceHash -> 👍 기록
  for (const r of [...(records || [])].sort(byTs)) {
    if (r?.vote === 'up' && r.nodeId) latest.set(r.sentenceHash, r);
    else if (latest.has(r?.sentenceHash)) {
      const up = latest.get(r.sentenceHash);
      if (r.vote === 'pick' || (r.vote === 'down' && r.nodeId === up.nodeId)) latest.delete(r.sentenceHash);
    }
  }
  const out = [];
  for (const r of latest.values()) {
    const node = nodes.get(r.nodeId);
    const tagId = tagFor(node, r.tagId);
    if (!node || !tagId) continue;
    out.push({ sentence: r.sentence, nodeId: node.id, tagId, source: 'up' });
  }
  return out;
}

// 평가셋·검증셋·가드 문장 중 하나와 글자 3-gram 자카드가 EVAL_COPY_MIN 이상이면 true
export function copiesEval(text, evalSentences = [], min = EVAL_COPY_MIN) {
  return (evalSentences || []).some(s => charJaccard(text, s) >= min);
}

// 가린 문장 하나의 거름 이유(통과면 null). 순서: 길이 → 금칙어 → 평가 베끼기
function rejectReason(text, { blockTerms, evalSentences }) {
  const len = [...squash(text)].length;
  if (len < MIN_LENGTH) return 'too-short';
  if (len > MAX_LENGTH) return 'too-long';
  if (findBlocked(text, blockTerms || [])) return 'blocked';
  if (copiesEval(text, evalSentences)) return 'copies-eval';
  return null;
}

/**
 * 교정 → 예문 후보. 문장은 maskSentence를 먼저 적용한다.
 * 거름: too-short·too-long(정규화 후 글자 수), blocked(금칙어), copies-eval(평가 문장 베끼기), duplicate(그 태그 기존 예문 또는 먼저 통과한 후보와 자카드 ≥ 0.8).
 * 같은 태그·완전히 같은 텍스트(가린 뒤)는 하나로 합치고 count를 올린다.
 * existingExamples: { [tagId]: string[] }. 확장 안에서는 evalSentences를 넘기지 않는다(평가 베끼기는 운영자 도구가 본다).
 * @returns {{ accepted: Array<{ tagId, text, nodeId, count, ts }>, rejected: Array<{ tagId, nodeId, text, reason }> }}
 */
export function toExampleCandidates(corrections, { blockTerms = [], evalSentences = [], existingExamples = {} } = {}) {
  const accepted = [], rejected = [];
  for (const c of corrections || []) {
    const text = squash(maskSentence(c.sentence ?? ''));
    let reason = rejectReason(text, { blockTerms, evalSentences });
    if (!reason) {
      const same = accepted.find(a => a.tagId === c.tagId && a.text === text);
      if (same) { same.count += 1; same.ts = Math.max(same.ts, c.ts || 0); continue; }
      const pool = [...(existingExamples[c.tagId] || []), ...accepted.filter(a => a.tagId === c.tagId).map(a => a.text)];
      if (pool.some(e => charJaccard(text, e) >= DUPLICATE_MIN)) reason = 'duplicate';
    }
    if (reason) rejected.push({ tagId: c.tagId, nodeId: c.nodeId, text, reason });
    else accepted.push({ tagId: c.tagId, text, nodeId: c.nodeId, count: 1, ts: c.ts || 0 });
  }
  return { accepted, rejected };
}

/**
 * 내 오버레이 태그 examples를 지금 피드백 기록에 맞춘다(되돌리기·전부 지우기·500건 상한에도 같은 결과).
 * 대상: 교정 노드가 사용자 노드이고 tagId가 오버레이 태그이면서 공통 태그 id가 아닐 때만(공통 태그는 승인 큐로만, 규칙 3·9).
 * 교정으로 넣은 예문은 overlay.correctionExamples[tagId]에 따로 적어 두고, 태그당 EXAMPLE_CAP개(최근 것)만 남긴다.
 * 손으로 적은 예문은 지우지 않고 중복 판정의 기준으로만 쓴다.
 * 호출하는 쪽이 로그인 세션인지 확인한다(로그아웃이면 부르지 않는다).
 * @returns {{ overlay: object, changed: boolean }} 바뀐 것이 없으면 받은 overlay 그대로
 */
export function syncCorrectionExamples(overlay, records, graph, { blockTerms = [], commonTagIds = new Set(), cap = EXAMPLE_CAP } = {}) {
  const ov = overlay || {};
  const prev = ov.correctionExamples || {};
  const ovTagIds = new Set((ov.tags || []).map(t => t.id).filter(id => !commonTagIds.has(id)));
  const nodes = new Map((graph?.nodes || []).map(n => [n.id, n]));
  const mine = collectCorrections(records, graph).filter(c => isUserNode(nodes.get(c.nodeId)) && ovTagIds.has(c.tagId));

  // 손으로 적은 예문 = 지금 examples에서 지난번 교정 예문을 뺀 것
  const base = {};
  for (const t of ov.tags || []) {
    const old = new Set(prev[t.id] || []);
    base[t.id] = (t.examples || []).filter(e => !old.has(e));
  }
  const { accepted } = toExampleCandidates(mine, { blockTerms, existingExamples: base });
  const next = {};
  for (const a of [...accepted].sort(byTs)) (next[a.tagId] ||= []).push(a.text);
  for (const id of Object.keys(next)) next[id] = next[id].slice(-cap);

  let changed = false;
  const tags = (ov.tags || []).map(t => {
    if (!prev[t.id] && !next[t.id]) return t;
    const examples = [...base[t.id], ...(next[t.id] || [])];
    if (JSON.stringify(examples) === JSON.stringify(t.examples || [])) return t;
    changed = true;
    return { ...t, examples };
  });
  // 오버레이에 없는 태그의 기록이 남았으면 정리한다
  if (Object.keys(prev).some(id => !next[id] || JSON.stringify(prev[id]) !== JSON.stringify(next[id]))) changed = true;
  if (Object.keys(next).some(id => !prev[id])) changed = true;
  if (!changed) return { overlay: ov, changed: false };
  const out = { ...ov, tags };
  if (Object.keys(next).length) out.correctionExamples = next;
  else delete out.correctionExamples;
  return { overlay: out, changed: true };
}

// 평가·가드 후보 문장 거름(길이·금칙어). 통과하면 가린 문장, 아니면 null
function evalSentence(sentence, blockTerms) {
  const text = squash(maskSentence(sentence ?? ''));
  const len = [...text].length;
  if (len < MIN_LENGTH || len > MAX_LENGTH || findBlocked(text, blockTerms || [])) return null;
  return text;
}

// (tagId, reason)별 개수. 텍스트는 담지 않는다
function countRejected(list) {
  const m = new Map();
  for (const r of list) {
    const k = `${r.tagId}\u0000${r.reason}`;
    m.set(k, { tagId: r.tagId, reason: r.reason, count: (m.get(k)?.count || 0) + (r.count || 1) });
  }
  return [...m.values()];
}

/**
 * 운영자 승인 큐 JSON(설정 "운영자용 교정 내보내기"). 서버로 보내지 않고 로컬 파일로만 받는다.
 * 공통 노드 + 공통 태그 대상만(사용자 노드는 이미 내 그래프에 반영). 문장은 모두 가린 것, rejected는 이유·개수만.
 * 평가 문장 베끼기(copies-eval)는 여기서 보지 않는다 — 확장은 tools/의 평가셋을 못 읽는다. 운영자가 tools/check-corrections.mjs로 거른다.
 * 관심사 하나만 대상으로 만든다(T-157): graph는 그 관심사 공통 그래프, interest는 그 id(최상위 필드).
 * 기록은 먼저 그 그래프 노드만 가리키는 것으로 거른다(feedbackForGraph) — 다른 관심사 기록이 섞이거나,
 * 같은 문장의 다른 관심사 pick이 "가장 최근 하나"를 가로채지 않게.
 */
export function buildCorrectionsExport(records, graph, { interest = DEFAULT_INTEREST, blockTerms = [], commonTagIds = new Set(), generatedAt, commonGraphVersion = null, tagsVersion = null } = {}) {
  records = feedbackForGraph(records, graph);
  const nodes = new Map((graph?.nodes || []).map(n => [n.id, n]));
  const isCommonTarget = c => { const n = nodes.get(c.nodeId); return n && !isUserNode(n) && commonTagIds.has(c.tagId); };
  const corrections = collectCorrections(records, graph).filter(isCommonTarget);
  // 공통 태그의 지금 예문(tags.json)과 거의 같은 후보는 duplicate
  const existingExamples = Object.fromEntries((graph?.tags || []).filter(t => commonTagIds.has(t.id)).map(t => [t.id, t.examples || []]));
  const { accepted, rejected } = toExampleCandidates(corrections, { blockTerms, existingExamples });

  const evalCandidates = [], seenEval = new Set();
  for (const c of corrections) {
    const sentence = evalSentence(c.sentence, blockTerms);
    if (!sentence || seenEval.has(sentence)) continue;
    seenEval.add(sentence);
    evalCandidates.push({ sentence, expectNodes: [c.nodeId], expectTag: c.tagId, source: 'pick' });
  }
  const guardCandidates = [], seenGuard = new Set();
  for (const p of collectPraise(records, graph).filter(isCommonTarget)) {
    const sentence = evalSentence(p.sentence, blockTerms);
    if (!sentence || seenGuard.has(sentence) || seenEval.has(sentence)) continue;
    seenGuard.add(sentence);
    guardCandidates.push({ sentence, expectNodes: [p.nodeId], source: 'up' });
  }
  const exampleCandidates = accepted.map(({ tagId, text, nodeId, count }) => ({ tagId, text, nodeId, count }));
  return {
    kind: EXPORT_KIND,
    version: 1,
    interest,
    generatedAt: generatedAt || new Date().toISOString(),
    commonGraphVersion,
    tagsVersion,
    exampleCandidates,
    rejected: countRejected(rejected),
    evalCandidates: markAlsoExample(evalCandidates, exampleCandidates),
    guardCandidates: markAlsoExample(guardCandidates, exampleCandidates)
  };
}

// 한 문장은 예문이나 평가 문장 중 한 곳에만 쓴다(같은 문장이 두 곳에 있으면 평가가 무의미해진다).
// 예문 후보와 자카드 ≥ 0.5인 평가·가드 후보에 alsoExampleCandidate: true를 붙이고, 아니면 표시를 뗀다
function markAlsoExample(list, exampleCandidates) {
  const texts = (exampleCandidates || []).map(c => c.text);
  return (list || []).map(c => {
    const { alsoExampleCandidate, ...rest } = c;
    return copiesEval(c.sentence, texts) ? { ...rest, alsoExampleCandidate: true } : rest;
  });
}

/**
 * 운영자 도구용: 내보낸 JSON에서 평가셋·검증셋·가드 문장을 베낀 예문 후보를 rejected(copies-eval)로 옮기고,
 * 이미 평가 문장과 거의 같은(자카드 ≥ 0.8) 평가·가드 후보는 뺀다. blockTerms를 주면 금칙어도 다시 거른다.
 * commonExamples(지금 tags.json 공통 예문)와 자카드 ≥ 0.5인 평가·가드 후보도 뺀다(이미 예문인 문장을 평가에 쓰지 않게).
 * 남은 예문 후보 기준으로 alsoExampleCandidate 표시를 다시 계산한다. 받은 객체는 바꾸지 않는다.
 */
export function filterEvalCopies(exported, evalSentences = [], { blockTerms = [], commonExamples = [] } = {}) {
  const keep = [], dropped = [];
  for (const c of exported.exampleCandidates || []) {
    // 내보낸 뒤 금칙어 목록이 늘었을 수 있어 운영자 쪽에서 한 번 더 본다
    if (findBlocked(c.text, blockTerms)) dropped.push({ ...c, reason: 'blocked' });
    else if (copiesEval(c.text, evalSentences)) dropped.push({ ...c, reason: 'copies-eval' });
    else keep.push(c);
  }
  const fresh = list => markAlsoExample((list || []).filter(c => !findBlocked(c.sentence, blockTerms)
    && !copiesEval(c.sentence, evalSentences, DUPLICATE_MIN) && !copiesEval(c.sentence, commonExamples)), keep);
  return {
    ...exported,
    exampleCandidates: keep,
    rejected: countRejected([...(exported.rejected || []), ...dropped.map(c => ({ tagId: c.tagId, reason: c.reason, count: c.count || 1 }))]),
    evalCandidates: fresh(exported.evalCandidates),
    guardCandidates: fresh(exported.guardCandidates)
  };
}

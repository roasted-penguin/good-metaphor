// 노드 파이프라인(T-194) 회귀 관문: 후보 노드를 그래프 사본에 넣어 검색 평가가 나빠지지 않는 것만 채택한다.
// 사용자 원칙(2026-10-18, 2026-11-22): 1,000개로 늘리되 정확도를 해치지 않는다 = 1위 회귀 0·여유 악화 0.
//
// 채점은 eval.mjs·fallback-baseline.mjs와 같은 재료로 한다(mergeGraphs → embedItems → retrieve(혼합 기본값, mixedSetting)
// → baselineRow·marginOf). 다른 점은 그래프를 파일이 아니라 사본 객체로 받는 것뿐이다(npm run eval:fallback은 실제
// 그래프 파일만 읽어서 후보마다 돌릴 수 없다). 임베더는 주입한다:
//   - fallback(대체 n-그램, Node, 결정적·공짜) = 앞 단계 거름
//   - browser(실제 확장 크롬, openBrowserEmbedder) = 최종 판정(ADR 0011: 실제 수치는 크롬 안에서)
// 질의·기존 노드·태그 벡터는 한 번만 임베딩하고(메모), 후보마다 새 노드 텍스트만 더 임베딩한다.
//
// 판정(문장 단위, 기준 = 후보 없는 그래프):
//   rank1   기준에서 1위가 맞던 문장이 틀림
//   negative 음성 문장(forbidNodes)이 통과하다 실패
//   margin  1위가 맞는 채로 여유(1위 − 기대 밖 최고)가 줄어서 얇은 여유(threshold, 기본 0.005 = eval --margin 기본)보다
//           작아지면(새로 얇아짐 또는 이미 얇던 것이 더 얇아짐). eval --margin-guard(T-150·T-188)의 "새로 얇아졌거나 바닥보다
//           더 얇아짐"과 같은 뜻을 가드뿐 아니라 모든 문장에 적용한다.
//           strictGuard(--strict-margin)면 가드 문장은 조금이라도 줄면 실패. 같은 태그를 쓰는 새 노드는 거의 늘 경쟁자로
//           들어와 여유를 조금 줄여서, 시연 묶음(메이플 6개)이 대체 임베더에서 전부 걸렸다(2026-11-22). 그래서 기본은 끔
//   noMatch 비유 없음 문장(expectNodes [], 음성 문장 포함)의 1위를 후보가 차지함(T-195, 메인 판정 2026-11-22
//           "음성 문장(맞는 비유 없음)에 노드가 붙으면 그대로 회귀". 전에는 정보로만 봤다)
//   alt     대안 정답 후보(회귀 아님, 막지 않음): 맞던 문장의 1위를 후보가 가져갔지만 그 후보 태그에 문장의 expectTag가 있다.
//           사용자 판정(2026-11-22) "한 문장에 대해 비유가 다양하게 나올 수도 있잖아". 이유 칸(altReason, 휴리스틱 또는 LLM)을
//           붙여 따로 표로 내고, 메인이 한 줄씩 확인하면 accept-alt가 expectNodes에 더한다. expectTag가 없는 후보가 1위를
//           가져가면 그대로 rank1 회귀다. 여유 규칙은 그대로(대안 후보가 경쟁자로 여유를 얇게 만들면 margin)
// 범인: 그 문장의 지금 순위에서 기대 노드를 밀어낸 후보(rank1·negative·noMatch·alt = 1위, margin = 기대 밖 최고 경쟁자).
// 절차: ① 후보 하나씩 넣어 걸리는 후보를 뺀다 ② 남은 후보를 함께 넣어 다시 재고, 걸리면 범인만 빼고 다시 잰다(반복).
//       alt는 거르는 사유가 아니다. 마지막(깨끗한) 함께 평가에서 남은 alt를 대안 정답 후보 표로 낸다.
import { readFileSync, existsSync } from 'node:fs';
import { mergeGraphs, embedItems, resolveCommonGraph } from '../../extension/lib/graph.js';
import { retrieve, cosine } from '../../extension/lib/retrieval.js';
import { mixedSetting, marginOf, interestEvalFiles } from '../eval-lib.mjs';
import { hashEmbed } from '../../extension/lib/fallback-embed.js';

export const MARGIN_EPS = 1e-9;

const toolsUrl = new URL('../', import.meta.url);
const readTool = f => JSON.parse(readFileSync(new URL(f, toolsUrl), 'utf8'));

/**
 * 관심사의 평가 문장 전부(평가셋·검증셋·홀드아웃) + 가드 표시. 같은 문장은 한 번(셋 이름을 모은다)
 * @returns {Array<{ sentence, expectNodes, forbidNodes?, sets: string[], guarded: boolean }>}
 */
export function loadGateCases(interestId, { read = readTool, exists = f => existsSync(new URL(f, toolsUrl)) } = {}) {
  // read·exists는 tools/ 기준 파일 이름을 받는다(--cases-dir 사본은 cli가 바꿔 넣는다)
  const f = interestEvalFiles({ id: interestId });
  const setFiles = interestId === 'maplestory'
    ? [['eval', f.evalSet], ['validation', 'eval-holdout.json'], ['holdout', f.holdout]]
    : [['eval', f.evalSet], ['holdout', f.holdout]];
  const guard = new Set(exists(f.guard) ? read(f.guard) : []);
  // 여유 가드의 아는 얇은 문장(메이플만, T-188)도 가드로 친다
  if (interestId === 'maplestory' && exists('eval-margin-known.json')) for (const k of read('eval-margin-known.json').sentences || []) guard.add(k.sentence);
  return mergeCases(setFiles.filter(([, file]) => exists(file)).map(([name, file]) => [name, read(file)]), guard);
}

// [[셋 이름, 문장들]] + 가드 문장 → 합친 목록
export function mergeCases(sets, guard = new Set()) {
  const by = new Map();
  for (const [name, cases] of sets) {
    for (const c of cases) {
      const hit = by.get(c.sentence);
      if (hit) { hit.sets.push(name); continue; }
      by.set(c.sentence, { sentence: c.sentence, expectNodes: c.expectNodes || [], ...(c.expectTag ? { expectTag: c.expectTag } : {}), ...(c.forbidNodes ? { forbidNodes: c.forbidNodes } : {}), sets: [name], guarded: guard.has(c.sentence) });
    }
  }
  return [...by.values()];
}

// 임베더 메모: 같은 (종류, 글)은 한 번만. embed(texts, kind) → 벡터 배열 (browser-embedder·hashEmbed 래퍼 모두 이 꼴)
export function memoEmbedder(embed) {
  const memo = new Map();
  let calls = 0, texts = 0;
  return {
    async vectors(list, kind) {
      const need = [...new Set(list.filter(t => !memo.has(kind + '\u0000' + t)))];
      if (need.length) {
        calls++; texts += need.length;
        const vs = await embed(need, kind);
        need.forEach((t, i) => memo.set(kind + '\u0000' + t, vs[i]));
      }
      return list.map(t => memo.get(kind + '\u0000' + t));
    },
    stats: () => ({ calls, texts })
  };
}

/**
 * 그래프 사본 하나를 채점한다.
 * @param {object} rawGraph  관심사 그래프 원본(tags 없음, 파일 꼴)
 * @param {{ tagsFile, cases, admin, embedder }} ctx  embedder = memoEmbedder(...)
 * @returns {Promise<Map<string, { kind, top1, top3, hit1?, margin, rival }>>}
 */
export async function scoreGraph(rawGraph, { tagsFile, cases, admin, embedder }) {
  const graph = mergeGraphs(resolveCommonGraph(rawGraph, tagsFile), null);
  const items = embedItems(graph, admin.retrieval);
  const iv = await embedder.vectors(items.map(it => it.text), 'passage');
  const vecs = new Map(items.map((it, i) => [it.key, iv[i]]));
  const qv = await embedder.vectors(cases.map(c => c.sentence), 'query');
  const { name, topK, ...opts } = mixedSetting(admin, graph);
  const out = new Map();
  cases.forEach((c, i) => {
    const ranked = retrieve(qv[i], graph, vecs, { ...opts, topK: graph.nodes.length, aliasText: c.sentence }).map(x => ({ id: x.id, score: x.score }));
    const top3 = ranked.slice(0, 3).map(x => x.id);
    const top1 = top3[0] ?? null;
    if (c.forbidNodes?.length) { out.set(c.sentence, { kind: 'negative', top1, top3, hit1: !c.forbidNodes.includes(top1), margin: null, rival: null }); return; }
    if (!c.expectNodes.length) { out.set(c.sentence, { kind: 'noMatch', top1, top3, margin: null, rival: null }); return; }
    const hit1 = c.expectNodes.includes(top1);
    const rival = ranked.find(x => !c.expectNodes.includes(x.id))?.id ?? null;
    out.set(c.sentence, { kind: 'hit', top1, top3, hit1, margin: marginOf(ranked, c.expectNodes), rival });
  });
  return out;
}

/**
 * 기준 대비 문제 문장. candidateIds = 이번에 넣은 후보 id(범인 찾기용), candidateTags = 후보 id → 태그(대안 정답 판정용)
 * @returns {Array<{ sentence, kind: 'rank1'|'negative'|'noMatch'|'margin'|'alt', before, after, culprit: string|null, guarded, expectTag? }>}
 *   kind 'alt'는 막는 사유가 아니다(blocking()으로 거른다)
 */
export function compareScores(base, cur, cases, { candidateIds = [], candidateTags = new Map(), threshold = 0.005, strictGuard = false } = {}) {
  const cand = new Set(candidateIds);
  const issues = [];
  for (const c of cases) {
    const b = base.get(c.sentence), a = cur.get(c.sentence);
    if (!b || !a) continue;
    const blame = id => (cand.has(id) ? id : null);
    if (b.kind === 'negative') {
      if (b.hit1 && !a.hit1) issues.push({ sentence: c.sentence, kind: 'negative', before: b.top1, after: a.top1, culprit: blame(a.top1), guarded: c.guarded });
      else if (cand.has(a.top1) && a.top1 !== b.top1) issues.push({ sentence: c.sentence, kind: 'noMatch', before: b.top1, after: a.top1, culprit: a.top1, guarded: c.guarded });
      continue;
    }
    if (b.kind === 'noMatch') {
      if (cand.has(a.top1) && a.top1 !== b.top1) issues.push({ sentence: c.sentence, kind: 'noMatch', before: b.top1, after: a.top1, culprit: a.top1, guarded: c.guarded });
      continue;
    }
    if (b.kind !== 'hit') continue;
    if (b.hit1 && !a.hit1) {
      const tags = candidateTags.get(a.top1) || [];
      const alt = cand.has(a.top1) && c.expectTag && tags.includes(c.expectTag);
      issues.push({ sentence: c.sentence, kind: alt ? 'alt' : 'rank1', before: b.top1, after: a.top1, culprit: blame(a.top1), guarded: c.guarded, ...(c.expectTag ? { expectTag: c.expectTag } : {}) });
      continue;
    }
    if (b.hit1 && a.hit1 && b.margin !== null && a.margin !== null && a.margin < b.margin - MARGIN_EPS) {
      const counts = (c.guarded && strictGuard) || a.margin < threshold;
      if (counts) issues.push({ sentence: c.sentence, kind: 'margin', before: round(b.margin), after: round(a.margin), culprit: blame(a.rival), guarded: c.guarded });
    }
  }
  return issues;
}
export const blocking = issues => issues.filter(i => i.kind !== 'alt');
const round = x => Math.round(x * 10000) / 10000;

const withNodes = (raw, nodes) => ({ ...raw, nodes: [...raw.nodes, ...nodes] });

/**
 * 회귀 관문.
 * @param {{ rawGraph, nodes, evaluate: (raw) => Promise<Map>, cases, threshold?, strictGuard?, maxRounds?, log? }} p
 *   nodes = 후보 노드(패치 꼴), evaluate = 그래프 사본 → scoreGraph 결과(테스트는 가짜)
 * @returns {Promise<{ accepted: string[], rejected: Array<{ id, stage: 'solo'|'joint', issues }>, alternatives: Array, altPending: string[], rounds: number, evaluations: number }>}
 *   alternatives = 마지막 함께 평가에서 채택 후보가 가져간 문장(대안 정답 후보, 회귀 아님). altPending = 그런 문장이 있는 채택 id
 *   (메인이 accept-alt로 expectNodes에 더하기 전까지 apply가 받지 않는다)
 */
export async function gateCandidates({ rawGraph, nodes, evaluate, cases, threshold = 0.005, strictGuard = false, maxRounds = 20, log = () => {} }) {
  let evaluations = 0;
  const ev = async raw => { evaluations++; return evaluate(raw); };
  const candidateTags = new Map(nodes.map(n => [n.id, n.tags || []]));
  const opts = ids => ({ candidateIds: ids, candidateTags, threshold, strictGuard });
  const base = await ev(rawGraph);
  const rejected = [];

  // ① 하나씩: 혼자 넣어도 문제를 내는 후보는 범인이 누구든 그 후보 탓이다(대안 정답은 문제가 아니다)
  let survivors = [];
  for (const n of nodes) {
    const issues = compareScores(base, await ev(withNodes(rawGraph, [n])), cases, opts([n.id]));
    const bad = blocking(issues);
    if (bad.length) { rejected.push({ id: n.id, stage: 'solo', issues: bad }); log(`혼자 넣어 걸림: ${n.id} (${bad.length}문장)`); }
    else survivors.push(n);
  }

  // ② 함께: 혼자서는 괜찮던 후보끼리 겹쳐 생기는 문제(서로 기대 노드를 밀어냄 등). 범인만 빼고 다시 잰다
  let rounds = 0, alternatives = [];
  while (survivors.length && rounds < maxRounds) {
    rounds++;
    const ids = survivors.map(n => n.id);
    const joint = await ev(withNodes(rawGraph, survivors));
    const all = compareScores(base, joint, cases, opts(ids));
    const issues = blocking(all);
    if (!issues.length) { alternatives = all.filter(i => i.kind === 'alt'); break; }
    let culprits = new Set(issues.map(i => i.culprit).filter(Boolean));
    // 범인을 못 짚으면(후보가 기대 노드를 직접 밀어낸 게 아님) 문제 문장 상위 3에 든 후보, 그것도 없으면 전부(보수적으로)
    if (!culprits.size) {
      const top = new Set();
      for (const i of issues) for (const id of joint.get(i.sentence)?.top3 || []) if (ids.includes(id)) top.add(id);
      culprits = top.size ? top : new Set(ids);
    }
    for (const id of culprits) rejected.push({ id, stage: 'joint', issues: issues.filter(i => !i.culprit || i.culprit === id) });
    log(`함께 넣어 걸림(${rounds}회차): ${[...culprits].join(', ')}`);
    survivors = survivors.filter(n => !culprits.has(n.id));
  }
  if (rounds >= maxRounds && survivors.length && !alternatives.length) {
    // 끝내 깨끗해지지 않으면 남은 것도 채택하지 않는다
    for (const n of survivors) rejected.push({ id: n.id, stage: 'joint', issues: [{ kind: 'rounds', sentence: '', culprit: n.id }] });
    survivors = [];
  }
  const accepted = survivors.map(n => n.id);
  alternatives = alternatives.filter(a => accepted.includes(a.culprit));
  return { accepted, rejected, alternatives, altPending: [...new Set(alternatives.map(a => a.culprit))], rounds, evaluations };
}

/* ───── 대안 정답 후보 (T-195) ───── */

/**
 * 대안 정답 후보 한 줄의 이유(휴리스틱). 메인이 확인할 재료: 공유 태그와 그 뜻, 문장과 가장 가까운 사실(대체 임베더 코사인).
 * "새 노드 facts만으로 문장 구조를 설명할 수 있는가"는 사람이(또는 --explain LLM이) 판단한다. needsReview는 항상 true
 * @param {{ sentence, expectTag, node: { facts }, tag?: { label, desc } }} p
 * @returns {{ text, bestFact, sim, needsReview: true, source: 'heuristic' }}
 */
export function altReason({ sentence, expectTag, node, tag }) {
  const qv = hashEmbed(sentence);
  let best = null;
  for (const f of node.facts || []) {
    const sim = cosine(qv, hashEmbed(f));
    if (!best || sim > best.sim) best = { fact: f, sim };
  }
  const sim = best ? Math.round(best.sim * 1000) / 1000 : 0;
  const text = `같은 추상 구조 ${expectTag}${tag ? `(${tag.label}${tag.desc ? ': ' + tag.desc : ''})` : ''}를 공유해요. 문장과 가장 가까운 사실: "${best?.fact || ''}" (글자 유사도 ${sim}). 이 사실만으로 문장 구조가 설명되는지 확인해 주세요.`;
  return { text, bestFact: best?.fact || '', sim, needsReview: true, source: 'heuristic' };
}

/**
 * 관문 결과의 대안 정답 후보 → 표 줄(accept-alt 입력 꼴). approve는 기본 false(메인이 true로 바꾼다)
 * @param {Array} alternatives  gateCandidates 결과
 * @param {{ interest, nodes, cases, tags }} ctx  nodes = 후보 노드, tags = 태그 목록(id·label·desc)
 */
export function altRows(alternatives, { interest, nodes, cases, tags = [] }) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const byS = new Map(cases.map(c => [c.sentence, c]));
  const tagById = new Map(tags.map(t => [t.id, t]));
  return alternatives.map(a => {
    const node = byId.get(a.culprit) || { id: a.culprit, facts: [] };
    const c = byS.get(a.sentence) || {};
    return {
      interest, sentence: a.sentence, sets: c.sets || [], guarded: !!a.guarded,
      oldExpected: c.expectNodes || [], oldTop1: a.before, newNode: a.culprit, newLabel: node.label || '',
      expectTag: a.expectTag, newTags: node.tags || [],
      reason: altReason({ sentence: a.sentence, expectTag: a.expectTag, node, tag: tagById.get(a.expectTag) }),
      approve: false
    };
  });
}

// 대안 정답 이유 LLM 프롬프트(--explain). 답: {"verdict": "yes"|"no", "reason": "한 문장"}
export function buildAltExplainPrompt({ sentence, expectTag, tag, node }) {
  const system = [
    '너는 비유 검색 평가셋을 검토하는 도우미다. 낯선 문장을 관심사 개념에 빗대 설명할 때, 아래 개념의 사실만으로 그 문장의 구조(무엇이 무엇에 따라 어떻게 바뀌는가)를 설명할 수 있는지 판단한다.',
    '규칙: 사실에 없는 내용을 보태지 않는다. 겉으로 같은 낱말이 아니라 구조가 같은지 본다. JSON 객체만 출력한다. 형식: {"verdict": "yes" 또는 "no", "reason": "한국어 한 문장, 80자 이내"}'
  ].join('\n');
  const user = [
    `[문장] ${sentence}`,
    `[기대 추상 구조] ${expectTag}${tag ? ` | ${tag.label} — ${tag.desc || ''}` : ''}`,
    `[개념] ${node.label || node.id}`,
    ...(node.facts || []).map(f => `- ${f}`)
  ].join('\n');
  return { system, user };
}

export function parseAltExplain(text) {
  try {
    const t = String(text || '').replace(/```(?:json)?/gi, '');
    const v = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
    if (v.verdict !== 'yes' && v.verdict !== 'no') return null;
    return { verdict: v.verdict, reason: String(v.reason || '').slice(0, 160) };
  } catch { return null; }
}

/**
 * apply 전 확인: 대안 정답 후보가 남은 채택 노드는, 그 문장들의 expectNodes에 노드가 들어가야(accept-alt 뒤) 받는다
 * @param {{ alternatives?: Array<{sentence, culprit}> }} gateResult
 * @param {Array<{sentence, expectNodes}>} cases  지금 평가 파일(loadGateCases)
 * @returns {Map<string, string[]>} 노드 id → 아직 승인 안 된 문장
 */
export function altPendingRefusals(gateResult, cases) {
  const byS = new Map(cases.map(c => [c.sentence, c]));
  const out = new Map();
  for (const a of gateResult.alternatives || []) {
    const c = byS.get(a.sentence);
    if (c && c.expectNodes.includes(a.culprit)) continue;
    out.set(a.culprit, [...(out.get(a.culprit) || []), a.sentence]);
  }
  return out;
}

/* ───── accept-alt: 승인한 대안 정답을 평가 파일 expectNodes에 더한다 ───── */

// 두 관심사의 expectNodes가 있는 평가 파일 [파일, 관심사] (평가셋·검증셋·홀드아웃). 가드 파일은 문장 문자열 목록이라
// 고칠 것이 없다(가드 문장도 expectNodes는 이 파일들에 있다). 관심사가 다른 파일에는 더하지 않는다
export function altTargetFiles() {
  const m = interestEvalFiles({ id: 'maplestory' }), r = interestEvalFiles({ id: 'restaurant' });
  return [[m.evalSet, 'maplestory'], ['eval-holdout.json', 'maplestory'], [m.holdout, 'maplestory'], [r.evalSet, 'restaurant'], [r.holdout, 'restaurant']];
}

// 평가 파일의 한 줄 꼴: { "sentence": "…", "expectNodes": ["a", "b"], … } (기존 파일과 같은 모양으로 다시 쓴다)
export function inlineJson(v) {
  if (Array.isArray(v)) return '[' + v.map(inlineJson).join(', ') + ']';
  if (v && typeof v === 'object') {
    const e = Object.entries(v);
    return e.length ? '{ ' + e.map(([k, x]) => `${JSON.stringify(k)}: ${inlineJson(x)}`).join(', ') + ' }' : '{}';
  }
  return JSON.stringify(v);
}

/**
 * 파일 글 하나에 승인 줄을 반영한다. 한 줄에 문장 하나인 꼴을 지키고, 고친 줄만 바뀐다
 * @param {string} text  파일 내용
 * @param {Array<{sentence, newNode}>} rows  승인한 줄
 * @returns {{ text, changed: Array<{sentence, node}> }}
 */
export function applyAltToText(text, rows) {
  const want = new Map();
  for (const r of rows) want.set(r.sentence, [...new Set([...(want.get(r.sentence) || []), r.newNode])]);
  const changed = [];
  const lines = text.split('\n').map(line => {
    const m = line.match(/^(\s*)(\{.*\})(,?)\s*$/);
    if (!m) return line;
    let obj;
    try { obj = JSON.parse(m[2]); } catch { return line; }
    const add = want.get(obj?.sentence);
    if (!add || !Array.isArray(obj.expectNodes) || !obj.expectNodes.length) return line; // 비유 없음 문장에는 더하지 않는다
    const extra = add.filter(id => !obj.expectNodes.includes(id));
    if (!extra.length) return line;
    obj.expectNodes = [...obj.expectNodes, ...extra];
    for (const id of extra) changed.push({ sentence: obj.sentence, node: id });
    return m[1] + inlineJson(obj) + m[3];
  });
  const out = lines.join('\n');
  JSON.parse(out); // 깨진 JSON이면 쓰지 않게 던진다
  return { text: out, changed };
}

const escMd = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
export function renderAltTable(rows, { interest, batch, embedderId }) {
  return [
    `# 대안 정답 후보: ${interest} 묶음 ${batch} (${embedderId})`,
    '',
    '새 노드가 기존 문장의 1위를 가져갔지만 그 문장의 expectTag를 가진 경우예요(회귀 아님, 사용자 판정 2026-11-22). 줄마다 "새 노드 사실만으로 문장 구조가 설명되는가"를 확인하고, 맞으면 같은 이름의 .json에서 그 줄 `approve`를 true로 바꾼 뒤 `npm run node-pipeline:accept-alt -- <.json>`.',
    '',
    `| # | 문장 | 셋 | 원래 정답 | 새 노드 | expectTag | 이유(확인 필요) |`,
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((r, i) => `| ${i + 1} | ${escMd(r.sentence)}${r.guarded ? ' (가드)' : ''} | ${r.sets.join('+')} | ${r.oldExpected.join(', ')} | ${r.newNode} ${escMd(r.newLabel)} | ${r.expectTag} | ${escMd(r.reason.text)}${r.llm ? ` / LLM ${r.llm.verdict}: ${escMd(r.llm.reason)}` : ''} |`),
    ''
  ].join('\n');
}

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
//   비유 없음 문장(expectNodes [])은 eval처럼 정보로만 본다
// 범인: 그 문장의 지금 순위에서 기대 노드를 밀어낸 후보(rank1·negative = 1위, margin = 기대 밖 최고 경쟁자).
// 절차: ① 후보 하나씩 넣어 걸리는 후보를 뺀다 ② 남은 후보를 함께 넣어 다시 재고, 걸리면 범인만 빼고 다시 잰다(반복).
import { readFileSync, existsSync } from 'node:fs';
import { mergeGraphs, embedItems, resolveCommonGraph } from '../../extension/lib/graph.js';
import { retrieve } from '../../extension/lib/retrieval.js';
import { mixedSetting, marginOf, interestEvalFiles } from '../eval-lib.mjs';

export const MARGIN_EPS = 1e-9;

const toolsUrl = new URL('../', import.meta.url);
const readTool = f => JSON.parse(readFileSync(new URL(f, toolsUrl), 'utf8'));

/**
 * 관심사의 평가 문장 전부(평가셋·검증셋·홀드아웃) + 가드 표시. 같은 문장은 한 번(셋 이름을 모은다)
 * @returns {Array<{ sentence, expectNodes, forbidNodes?, sets: string[], guarded: boolean }>}
 */
export function loadGateCases(interestId, { read = readTool, exists = f => existsSync(new URL(f, toolsUrl)) } = {}) {
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
      by.set(c.sentence, { sentence: c.sentence, expectNodes: c.expectNodes || [], ...(c.forbidNodes ? { forbidNodes: c.forbidNodes } : {}), sets: [name], guarded: guard.has(c.sentence) });
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
 * 기준 대비 문제 문장. candidateIds = 이번에 넣은 후보 id(범인 찾기용)
 * @returns {Array<{ sentence, kind: 'rank1'|'negative'|'margin', before, after, culprit: string|null, guarded }>}
 */
export function compareScores(base, cur, cases, { candidateIds = [], threshold = 0.005, strictGuard = false } = {}) {
  const cand = new Set(candidateIds);
  const issues = [];
  for (const c of cases) {
    const b = base.get(c.sentence), a = cur.get(c.sentence);
    if (!b || !a) continue;
    const blame = id => (cand.has(id) ? id : null);
    if (b.kind === 'negative') {
      if (b.hit1 && !a.hit1) issues.push({ sentence: c.sentence, kind: 'negative', before: b.top1, after: a.top1, culprit: blame(a.top1), guarded: c.guarded });
      continue;
    }
    if (b.kind !== 'hit') continue;
    if (b.hit1 && !a.hit1) { issues.push({ sentence: c.sentence, kind: 'rank1', before: b.top1, after: a.top1, culprit: blame(a.top1), guarded: c.guarded }); continue; }
    if (b.hit1 && a.hit1 && b.margin !== null && a.margin !== null && a.margin < b.margin - MARGIN_EPS) {
      const counts = (c.guarded && strictGuard) || a.margin < threshold;
      if (counts) issues.push({ sentence: c.sentence, kind: 'margin', before: round(b.margin), after: round(a.margin), culprit: blame(a.rival), guarded: c.guarded });
    }
  }
  return issues;
}
const round = x => Math.round(x * 10000) / 10000;

const withNodes = (raw, nodes) => ({ ...raw, nodes: [...raw.nodes, ...nodes] });

/**
 * 회귀 관문.
 * @param {{ rawGraph, nodes, evaluate: (raw) => Promise<Map>, cases, threshold?, strictGuard?, maxRounds?, log? }} p
 *   nodes = 후보 노드(패치 꼴), evaluate = 그래프 사본 → scoreGraph 결과(테스트는 가짜)
 * @returns {Promise<{ accepted: string[], rejected: Array<{ id, stage: 'solo'|'joint', issues }>, rounds: number, evaluations: number }>}
 */
export async function gateCandidates({ rawGraph, nodes, evaluate, cases, threshold = 0.005, strictGuard = false, maxRounds = 20, log = () => {} }) {
  let evaluations = 0;
  const ev = async raw => { evaluations++; return evaluate(raw); };
  const opts = ids => ({ candidateIds: ids, threshold, strictGuard });
  const base = await ev(rawGraph);
  const rejected = [];

  // ① 하나씩: 혼자 넣어도 문제를 내는 후보는 범인이 누구든 그 후보 탓이다
  let survivors = [];
  for (const n of nodes) {
    const issues = compareScores(base, await ev(withNodes(rawGraph, [n])), cases, opts([n.id]));
    if (issues.length) { rejected.push({ id: n.id, stage: 'solo', issues }); log(`혼자 넣어 걸림: ${n.id} (${issues.length}문장)`); }
    else survivors.push(n);
  }

  // ② 함께: 혼자서는 괜찮던 후보끼리 겹쳐 생기는 문제(서로 기대 노드를 밀어냄 등). 범인만 빼고 다시 잰다
  let rounds = 0;
  while (survivors.length && rounds < maxRounds) {
    rounds++;
    const ids = survivors.map(n => n.id);
    const joint = await ev(withNodes(rawGraph, survivors));
    const issues = compareScores(base, joint, cases, opts(ids));
    if (!issues.length) break;
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
  if (rounds >= maxRounds && survivors.length) {
    // 끝내 깨끗해지지 않으면 남은 것도 채택하지 않는다
    for (const n of survivors) rejected.push({ id: n.id, stage: 'joint', issues: [{ kind: 'rounds', sentence: '', culprit: n.id }] });
    survivors = [];
  }
  return { accepted: survivors.map(n => n.id), rejected, rounds, evaluations };
}

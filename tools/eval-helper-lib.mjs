// 새 관심사 도우미 품질 평가(T-226, ADR 0017 에이전트 2 "재는 방법")의 순수 함수. tools/eval-helper.mjs가 쓰고 단위 테스트가 직접 부른다.
//   - 도우미 단계 기록(trace) → 초안 수·첫 검사 통과율·최종 통과율·뺀 이유·태그 커버리지
//   - T-301 한 번 호출 초안 → 같은 코드 검사(수치·구조 먼저·근접 중복)로 "도우미였다면 걸렸을" 수
//   - 채점(다른 계열 모델): 노드마다 사실 그럴듯함(지어낸 사실 없음)·익숙함(1~5)·태그 적합
//   - 새 그래프에서 expectTag 1위 비율(대체 임베더, 실제 모델 아님)
import { createHash } from 'node:crypto';
import { PROBLEM_TEXT } from '../extension/lib/interest-helper.js';
import { changingNumbers, structureFirst, dupIndex, DUP_FAIL } from '../extension/lib/node-checks.js';
import { parseJSONLoose } from '../extension/lib/providers.js';
import { mergeGraphs, embedItems } from '../extension/lib/graph.js';
import { retrieve, retrievalFor } from '../extension/lib/retrieval.js';

// 팬이면 아는 관심사 다섯(메이플·식당과 겹치지 않게, 스포츠·음료·야외·팬덤·돈)
export const DEFAULT_INTERESTS = ['축구', '커피', '등산', 'K-팝 팬덤', '주식'];

export const sha = s => createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
export const callKey = (model, system, user) => `call:${model}:${sha(system + '\n\u0000\n' + user)}`;

/* ───── 도우미 기록 → 지표 ───── */

// PROBLEM_TEXT 문구 → 키(뺀 이유 집계용). parseDraft 등 다른 문구는 'other:<문구>'
const REASON_KEY = new Map(Object.entries(PROBLEM_TEXT).map(([k, v]) => [v, k]));
export const reasonKey = text => REASON_KEY.get(text) || `other:${String(text).slice(0, 40)}`;

/**
 * 단계마다 저장한 상태 목록 → 지표. states[0]은 시작 상태, 마지막이 끝난 상태.
 * 초안 = 큐에 rewrites 0으로 처음 들어온 노드 id, 고쳐 씀 = rewrites 1로 들어온 id.
 * 첫 통과 = 고쳐 쓰지 않고 통과한 노드(평가자가 처음에 받아 준 것)
 */
export function helperMetrics(states, { tagCount }) {
  const drafted = new Set(), rewritten = new Set();
  for (const s of states) for (const n of s.queue || []) (n.rewrites ? rewritten : drafted).add(n.id);
  const end = states.at(-1);
  const accepted = end.accepted || [];
  const firstPass = accepted.filter(n => !n.rewrites).length;
  const reasons = {};
  for (const d of end.dropped || []) { const k = reasonKey(d.reason); reasons[k] = (reasons[k] || 0) + 1; }
  const covered = [...new Set(accepted.flatMap(n => n.tags))];
  const ratio = (a, b) => (b ? a / b : null);
  return {
    drafted: drafted.size,
    rewritten: rewritten.size,
    accepted: accepted.length,
    firstPass,
    firstPassRate: ratio(firstPass, drafted.size),
    passRate: ratio(accepted.length, drafted.size),
    reasons,
    covered: covered.length,
    coverage: ratio(covered.length, tagCount),
    absent: [...(end.absentTags || [])],
    calls: end.calls,
    steps: end.steps,
    rounds: end.round,
    stop: end.stop || null
  };
}

// T-301 한 번 호출 초안에 도우미 코드 검사를 그대로 대 본다(LLM 평가는 하지 않는다: 같은 호출 수 비교가 아니라 "그냥 받으면 얼마나 걸리나")
export function oneShotMetrics(nodes, { tagCount }) {
  const index = dupIndex([]);
  const flags = { number: 0, structure: 0, dup: 0 };
  for (const n of nodes) {
    if (n.facts.some(f => changingNumbers(f).length)) flags.number++;
    if (!structureFirst(n.facts[0])) flags.structure++;
    const near = index.nearest(n);
    if (near.same || (near.best && near.best.score >= DUP_FAIL)) flags.dup++;
    index.add(n);
  }
  const covered = [...new Set(nodes.flatMap(n => n.tags))];
  return { drafted: nodes.length, accepted: nodes.length, flags, covered: covered.length, coverage: tagCount ? covered.length / tagCount : null, calls: 1 };
}

/* ───── 채점 ───── */

export const JUDGE_BATCH = 10;

export function buildNodeJudgePrompt({ name, nodes, tags }) {
  const byId = new Map(tags.map(t => [t.id, t]));
  const system = [
    `너는 관심사 "${name}"의 개념 노드를 검수하는 엄격한 채점자다. 이 노드는 다른 모델이 만들었고, 나중에 낯선 문장을 "${name}"에 빗대 설명하는 근거로 쓰인다.`,
    '노드마다 아래를 판단한다. 모르면 후하게 주지 말고 낮게 준다.',
    `1. facts: 사실마다 ok(그 분야에서 널리 알려진 맞는 사실), doubt(맞는지 확실하지 않거나 과장·일반화), wrong(틀렸거나 지어낸 것). 사실 i번(0부터)마다 하나.`,
    `2. familiar: "${name}"을 즐기는 보통 사람이 이 개념을 얼마나 바로 아는지 1(전문가만)~5(누구나).`,
    '3. tags: 노드에 단 태그마다 그 태그의 구조("무엇이 무엇에 따라 어떻게 바뀌는가")가 사실에 실제로 드러나면 yes, 억지면 no.',
    'JSON 객체만 출력한다. 형식: {"nodes": [{"id": "노드 id", "facts": ["ok"], "familiar": 4, "tags": [{"id": "태그 id", "fit": "yes"}], "note": "한국어 한 문장"}]}'
  ].join('\n');
  const user = [
    `관심사: ${name}`,
    '',
    ...nodes.map(n => [
      `[노드] id=${n.id} | ${n.label}`,
      ...n.facts.map((f, i) => `  사실 ${i}: ${f}`),
      ...n.tags.map(id => byId.get(id)).filter(Boolean).map(t => `  태그 ${t.id} | ${t.label} — ${t.desc || ''}`)
    ].join('\n'))
  ].join('\n');
  return { system, user };
}

const FACT_V = new Set(['ok', 'doubt', 'wrong']);
// 채점 답 → Map(id → { facts: [ok|doubt|wrong|null], familiar: 1~5|null, tags: Map(id → yes|no), note }) | null
export function parseNodeJudge(text) {
  const j = parseJSONLoose(String(text ?? '').replace(/```(?:json)?/gi, ''));
  if (!j || !Array.isArray(j.nodes)) return null;
  const out = new Map();
  for (const x of j.nodes) {
    if (!x || typeof x.id !== 'string' || out.has(x.id)) continue;
    const fam = Number(x.familiar);
    const tags = new Map();
    for (const t of Array.isArray(x.tags) ? x.tags : []) if (t && typeof t.id === 'string' && (t.fit === 'yes' || t.fit === 'no')) tags.set(t.id, t.fit);
    out.set(x.id, {
      facts: (Array.isArray(x.facts) ? x.facts : []).map(v => (FACT_V.has(v) ? v : null)),
      familiar: Number.isFinite(fam) && fam >= 1 && fam <= 5 ? Math.round(fam) : null,
      tags,
      note: String(x.note ?? '').slice(0, 160)
    });
  }
  return out;
}

/**
 * 채점 모음 → 요약. plausible = 사실이 모두 ok인 노드 비율(지어낸 사실 없음), wrongFacts = wrong 사실 비율,
 * flaggedFacts = doubt+wrong 사실 비율("검수에서 지울 사실" 대리 지표), familiar 평균, tagFit = yes 태그 비율
 */
export function judgeSummary(nodes, verdicts) {
  let judged = 0, plausible = 0, facts = 0, wrong = 0, doubt = 0, famSum = 0, famN = 0, tagYes = 0, tagN = 0;
  for (const n of nodes) {
    const v = verdicts.get(n.id);
    if (!v) continue;
    judged++;
    const fv = n.facts.map((_, i) => v.facts[i] ?? null);
    if (fv.every(x => x === 'ok')) plausible++;
    facts += fv.length;
    wrong += fv.filter(x => x === 'wrong').length;
    doubt += fv.filter(x => x === 'doubt' || x === null).length;
    if (v.familiar) { famSum += v.familiar; famN++; }
    for (const t of n.tags) { const f = v.tags.get(t); if (f) { tagN++; if (f === 'yes') tagYes++; } }
  }
  const r = (a, b) => (b ? a / b : null);
  return {
    judged, plausible: r(plausible, judged), facts, wrongFacts: r(wrong, facts), flaggedFacts: r(wrong + doubt, facts),
    familiar: famN ? famSum / famN : null, tagFit: r(tagYes, tagN)
  };
}

/* ───── expectTag 1위 비율 ───── */

// 평가 문장 모음(여러 파일) → expectTag 있는 문장만, 문장 중복 제거
export function expectTagItems(...lists) {
  const seen = new Set(), out = [];
  for (const list of lists) for (const it of list || []) {
    if (!it?.expectTag || !it.sentence || seen.has(it.sentence)) continue;
    seen.add(it.sentence);
    out.push({ sentence: it.sentence, expectTag: it.expectTag });
  }
  return out;
}

// 초안 노드 → 검수를 모두 마친 것으로 본 새 관심사 그래프(공통 태그 사전만 빌린다)
export function graphFromDrafts(common, name, nodes) {
  const ov = { useCommon: false, domain: name, nodes: nodes.map(n => ({ id: n.id, label: n.label, facts: [...n.facts], tags: [...n.tags] })) };
  return mergeGraphs(common, ov);
}

/**
 * 그래프에서 문장마다 1위 노드가 expectTag를 가졌는지. embed(text) → 벡터(동기, 대체 임베더 hashEmbed).
 * all = 전체 문장 대비, covered = expectTag를 가진 노드가 그래프에 있는 문장만 대비(덮은 태그 안에서의 검색 품질)
 */
export function expectTagRate(graph, items, { embed, retrieval = {} }) {
  if (!graph.nodes.length) return { n: items.length, hit: 0, all: 0, coveredN: 0, coveredHit: 0, covered: null, misses: [] };
  const its = embedItems(graph, retrieval);
  const vecs = new Map(its.map(it => [it.key, embed(it.text)]));
  const opts = { ...retrievalFor(retrieval, graph), topK: 1 };
  const has = new Set(graph.nodes.flatMap(n => n.tags));
  let hit = 0, coveredN = 0, coveredHit = 0;
  const misses = [];
  for (const it of items) {
    const [top] = retrieve(embed(it.sentence), graph, vecs, { ...opts, aliasText: it.sentence });
    const ok = !!top && graph.nodes.find(n => n.id === top.id)?.tags.includes(it.expectTag);
    if (ok) hit++;
    if (has.has(it.expectTag)) { coveredN++; if (ok) coveredHit++; else misses.push({ sentence: it.sentence, expectTag: it.expectTag, got: top?.label }); }
  }
  return { n: items.length, hit, all: hit / items.length, coveredN, coveredHit, covered: coveredN ? coveredHit / coveredN : null, misses };
}

/* ───── 출력 ───── */

const pct = v => (v == null ? '—' : `${Math.round(v * 100)}%`);
const f1 = v => (v == null ? '—' : v.toFixed(1));

export function rowLine(r) {
  const m = r.metrics, j = r.judge, e = r.expect;
  const head = `${r.interest} · ${r.method === 'helper' ? '도우미' : 'T-301 한 번'}`;
  if (r.error) return `${head}: 오류 ${r.error}`;
  const parts = [
    `초안 ${m.drafted} → 남음 ${m.accepted}`,
    ...(r.method === 'helper' ? [`첫 통과 ${pct(m.firstPassRate)}`, `최종 통과 ${pct(m.passRate)}`, `고쳐 씀 ${m.rewritten}`] : [`코드 검사 걸림 수치 ${m.flags.number}·구조 ${m.flags.structure}·중복 ${m.flags.dup}`]),
    `태그 ${m.covered}/${r.tagCount}`,
    `호출 ${m.calls}`
  ];
  if (j) parts.push(`채점 그럴듯 ${pct(j.plausible)} · 지울 사실 ${pct(j.flaggedFacts)}(틀림 ${pct(j.wrongFacts)}) · 익숙 ${f1(j.familiar)} · 태그맞음 ${pct(j.tagFit)}`);
  if (e) parts.push(`expectTag 1위 ${e.hit}/${e.n}(${pct(e.all)}), 덮은 태그 안 ${e.coveredHit}/${e.coveredN}(${pct(e.covered)})`);
  return `${head}: ${parts.join(' · ')}`;
}

// 방법별 합계(관심사 평균이 아니라 노드·문장 합)
export function totals(rows) {
  const out = {};
  for (const method of ['helper', 'oneshot']) {
    const rs = rows.filter(r => r.method === method && !r.error);
    if (!rs.length) continue;
    const sum = f => rs.reduce((a, r) => a + (f(r) || 0), 0);
    const judged = sum(r => r.judge?.judged);
    const w = f => (judged ? sum(r => (r.judge ? f(r.judge) * r.judge.judged : 0)) / judged : null);
    const facts = sum(r => r.judge?.facts);
    out[method] = {
      interests: rs.length,
      drafted: sum(r => r.metrics.drafted), accepted: sum(r => r.metrics.accepted), calls: sum(r => r.metrics.calls),
      firstPass: method === 'helper' ? sum(r => r.metrics.firstPass) : null,
      covered: sum(r => r.metrics.covered) / rs.length,
      plausible: w(j => j.plausible ?? 0),
      flaggedFacts: facts ? sum(r => (r.judge ? (r.judge.flaggedFacts ?? 0) * r.judge.facts : 0)) / facts : null,
      wrongFacts: facts ? sum(r => (r.judge ? (r.judge.wrongFacts ?? 0) * r.judge.facts : 0)) / facts : null,
      familiar: w(j => j.familiar ?? 0),
      tagFit: w(j => j.tagFit ?? 0),
      expectHit: sum(r => r.expect?.hit), expectN: sum(r => r.expect?.n),
      coveredHit: sum(r => r.expect?.coveredHit), coveredN: sum(r => r.expect?.coveredN)
    };
  }
  return out;
}

export function totalLines(t, tagCount) {
  const lines = [];
  for (const [method, x] of Object.entries(t)) {
    const name = method === 'helper' ? '도우미' : 'T-301 한 번';
    lines.push(`${name}(${x.interests}개 관심사): 초안 ${x.drafted} → 남음 ${x.accepted}${x.firstPass != null ? ` · 첫 통과 ${pct(x.drafted ? x.firstPass / x.drafted : null)} · 최종 통과 ${pct(x.drafted ? x.accepted / x.drafted : null)}` : ''} · 평균 태그 ${f1(x.covered)}/${tagCount} · 호출 ${x.calls}`
      + ` · 그럴듯 ${pct(x.plausible)} · 지울 사실 ${pct(x.flaggedFacts)}(틀림 ${pct(x.wrongFacts)}) · 익숙 ${f1(x.familiar)} · 태그맞음 ${pct(x.tagFit)}`
      + ` · expectTag 1위 ${x.expectHit}/${x.expectN}(${pct(x.expectN ? x.expectHit / x.expectN : null)}) · 덮은 태그 안 ${x.coveredHit}/${x.coveredN}(${pct(x.coveredN ? x.coveredHit / x.coveredN : null)})`);
  }
  return lines;
}

// 평가 채점 (순수 함수). eval.mjs와 단위 테스트가 함께 쓴다
import { retrievalFor } from '../extension/lib/retrieval.js';

/**
 * @param {object[]} cases          { sentence, expectNodes, group?, forbidNodes? }. expectNodes가 []면 "맞는 비유가 없어야 하는" 문장.
 *                                  forbidNodes가 있으면 음성 문장(T-149): 1위가 forbidNodes에 없으면 통과. hit@1·noMatch와 따로 센다
 * @param {(c, i) => (string|{id, score})[]} rank 문장별 상위 노드 (앞이 1위). 점수가 있으면 함께 모은다
 */
export function scoreCases(cases, rank) {
  let n = 0, hit1 = 0, hit3 = 0;
  const groups = {}, misses = [], noMatch = [], hitScores = [];
  const negative = { n: 0, pass: 0, fails: [] };
  cases.forEach((c, i) => {
    const top3 = rank(c, i).slice(0, 3);
    const got = top3.map(x => typeof x === 'string' ? x : x.id);
    const score0 = typeof top3[0] === 'object' ? top3[0].score : undefined;
    // 음성 문장(일상어 별칭 오부스트 방지, T-149): 기존 분모를 바꾸지 않게 먼저 따로 센다
    if (c.forbidNodes?.length) {
      negative.n++;
      if (c.forbidNodes.includes(got[0])) negative.fails.push({ sentence: c.sentence, top: got[0], forbid: c.forbidNodes });
      else negative.pass++;
      return;
    }
    // 비유가 없어야 하는 문장: hit 계산에서 빼고 1위 점수만 남긴다 (임계값 근거, T-103)
    if (!c.expectNodes.length) { noMatch.push({ sentence: c.sentence, top: got[0], score: score0 }); return; }
    n++;
    const ok1 = c.expectNodes.includes(got[0]);
    if (ok1) { hit1++; if (score0 !== undefined) hitScores.push(score0); }
    else misses.push({ sentence: c.sentence, got, expect: c.expectNodes });
    if (got.some(id => c.expectNodes.includes(id))) hit3++;
    if (c.group) {
      const g = groups[c.group] ||= { hit1: 0, n: 0 };
      g.n++;
      if (ok1) g.hit1++;
    }
  });
  return { n, hit1, hit3, groups, misses, noMatch, hitScores, negative };
}

// 혼합 설정 = 확장이 실제로 쓰는 admin.json retrieval 그대로. graph를 주면 관심사별 감점을 덮어쓴다(T-156, 확장과 같은 retrievalFor)
export function mixedSetting(admin, graph = null) {
  return { name: '혼합 (현재 기본값)', ...(graph ? retrievalFor(admin.retrieval, graph) : admin.retrieval) };
}

// 회귀: 지켜야 할 문장(tools/eval-guard.json) 중 hit@1을 놓친 문장
export function regressions(guard, result) {
  const missed = new Set(result.misses.map(m => m.sentence));
  return guard.filter(s => missed.has(s));
}

// --- 여유(margin, T-150): 1위와 그다음 경쟁자의 점수 차. 예문 한 줄에 순위가 뒤집힐 만큼 작은지 본다 ---

/**
 * 맞힌 문장: score(1위) − score(기대 노드가 아닌 것 중 최고) (양수).
 * 틀린 문장: score(기대 노드 중 최고) − score(1위) (음수).
 * 비유 없음 문장, 점수가 없는 순위, 비교할 상대가 순위에 없으면 null.
 * @param {{id, score}[]} ranked 점수 내림차순 전체 순위 (상위 3개만 주면 비기대 노드가 안 보일 수 있다)
 * @param {string[]} expectNodes
 */
export function marginOf(ranked, expectNodes) {
  if (!expectNodes?.length || !ranked?.length || typeof ranked[0] !== 'object') return null;
  const isExp = x => expectNodes.includes(x.id);
  if (isExp(ranked[0])) {
    const rival = ranked.find(x => !isExp(x));
    return rival ? ranked[0].score - rival.score : null;
  }
  const best = ranked.find(isExp);
  return best ? best.score - ranked[0].score : null;
}

// 문장별 여유. 비유 없음·음성(forbidNodes) 문장은 빼고 순서를 지킨다
export function marginsOf(cases, rank) {
  const out = [];
  cases.forEach((c, i) => {
    if (c.forbidNodes?.length || !c.expectNodes?.length) return;
    const margin = marginOf(rank(c, i), c.expectNodes);
    if (margin !== null) out.push({ sentence: c.sentence, margin });
  });
  return out;
}

// 맞혔지만 여유가 임계값 미만인 문장(작은 순서). 틀린 문장은 기존 ✗ 줄로 이미 보인다
export function lowMargins(margins, threshold) {
  return margins.filter(m => m.margin >= 0 && m.margin < threshold).sort((a, b) => a.margin - b.margin);
}

// --margin-guard: 가드 문장 중 여유가 임계값 미만(틀린 문장 포함). [{ sentence, margin }] 가드 순서
export function marginGuardFails(guard, margins, threshold) {
  const low = new Map(margins.filter(m => m.margin < threshold).map(m => [m.sentence, m.margin]));
  return guard.filter(s => low.has(s)).map(s => ({ sentence: s, margin: low.get(s) }));
}

// --- 여유 가드 기준선(T-188): tools/eval-margin-known.json 의 "아는 얇은 문장" ---
// 그래프·예문을 바꾸지 않고는 넓힐 수 없는 가드 문장을 바닥(floor)과 함께 적어 두고,
// 새로 얇아진 가드 문장과 아는 문장이 바닥보다 더 얇아진 것만 실패로 친다(래칫).
// known = [{ sentence, floor, task? }]
// 돌려주는 값: fail(실패, 아는 문장이면 floor 포함), held(바닥 이상이라 통과), cleared(목록에 있지만 이제 얇지 않음 → 빼도 됨)
export function judgeMarginGuard(fails, known) {
  const byS = new Map((known || []).map(k => [k.sentence, k]));
  const fail = [], held = [];
  for (const f of fails) {
    const k = byS.get(f.sentence);
    // 틀린 문장(여유 < 0)은 바닥과 상관없이 실패
    if (k && f.margin >= 0 && f.margin >= k.floor) held.push({ ...f, floor: k.floor, ...(k.task ? { task: k.task } : {}) });
    else fail.push(k ? { ...f, floor: k.floor } : { ...f });
  }
  const failed = new Set(fails.map(f => f.sentence));
  const cleared = (known || []).filter(k => !failed.has(k.sentence));
  return { fail, held, cleared };
}

// --write-margin-known: 지금 얇은 가드 문장(맞힌 것만)을 바닥 = 여유 넷째 자리 내림으로. 이전 task 를 이어받는다
export function knownFromFails(fails, prevKnown = []) {
  const prev = new Map(prevKnown.map(k => [k.sentence, k]));
  return fails.filter(f => f.margin >= 0).map(f => {
    const task = prev.get(f.sentence)?.task;
    return { sentence: f.sentence, floor: Math.floor(f.margin * 1e4) / 1e4, ...(task ? { task } : {}) };
  });
}

export function marginGuardLines({ fail, held, cleared }, threshold) {
  return [
    `여유 가드: 실패 ${fail.length} · 아는 얇은 문장 ${held.length} · 목록에서 뺄 수 있음 ${cleared.length} (임계값 ${threshold})`,
    ...fail.map(f => `  ✗ ${fmtMargin(f.margin)} (${f.floor != null ? `바닥 ${fmtMargin(f.floor)}` : '새로 얇아짐'})  ${f.sentence}`),
    ...held.map(h => `  · ${fmtMargin(h.margin)} (바닥 ${fmtMargin(h.floor)}${h.task ? `, ${h.task}` : ''})  ${h.sentence}`),
    ...cleared.map(c => `  - ${c.sentence}`)
  ];
}

export const fmtMargin = m => (m < 0 ? '-' : '+') + Math.abs(m).toFixed(4);

// 요약 끝 경고 줄 (-v와 상관없이)
export function lowMarginLines(lows, threshold) {
  return [`여유 작은 문장(< ${threshold}): ${lows.length}개`, ...lows.map(m => `  ${fmtMargin(m.margin)}  ${m.sentence}`)];
}

// -v의 틀린 문장 줄 (T-150 전과 같은 모양)
export const missLine = m => `  ✗ ${m.sentence.slice(0, 32)}… → ${m.got.join(', ')} (기대: ${m.expect.join('/')})`;

// --margin <값> (기본 0.005)
export function marginThreshold(argv) {
  const i = argv.indexOf('--margin');
  if (i < 0) return 0.005;
  const v = Number(argv[i + 1]);
  if (argv[i + 1] === undefined || !Number.isFinite(v) || v < 0) throw new Error('--margin 뒤에 0 이상의 숫자를 써요 (예: --margin 0.005)');
  return v;
}

// 관심사별 평가 파일 이름(tools/ 아래, T-156). 메이플은 예전 이름 그대로
export function interestEvalFiles(interest) {
  if (!interest || interest.id === 'maplestory') return { evalSet: 'eval-set.json', holdout: 'eval-unseen.json', guard: 'eval-guard.json' };
  const id = interest.id;
  return { evalSet: `eval-set-${id}.json`, holdout: `eval-unseen-${id}.json`, guard: `eval-guard-${id}.json` };
}

// 채점할 문장 묶음. --holdout이면 홀드아웃만(예문 고를 때 보지 않는 문장, 회귀 가드 대상 아님)
// interest = 고른 공통 관심사(graph.js commonInterest). 메이플이 아니면 그 관심사 평가셋 하나(그 관심사 가드 대상, T-156),
// --holdout이면 그 관심사 홀드아웃만
// 메이플 전용 옵션: 여유 가드는 메이플 평가셋 기준이고, 서버(analogy-api)는 메이플 그래프만 안다.
// 다른 관심사와 같이 주면 조용히 무시하지 않고 오류 문구를 돌려준다. 괜찮으면 null
const MAPLE_ONLY_FLAGS = ['--margin-guard', '--write-margin-known', '--server'];
export function interestArgError(argv, interest) {
  if (!interest || interest.id === 'maplestory') return null;
  const bad = MAPLE_ONLY_FLAGS.filter(f => argv.includes(f));
  return bad.length ? `${bad.join(', ')}는 메이플 관심사에서만 써요(지금 --interest ${interest.id}).` : null;
}

export function pickSets(argv, { evalSet, validation, holdout, interestSet, extraSet = null, extraName = '' }, interest = null) {
  // --set <파일>(T-191·T-192): 그 파일 문장만 채점(관심사 무관, 가드 대상 아님). 확장 노드가 실제로 쓰이는지 보는 셋
  if (argv.includes('--set')) return [{ name: `추가 셋 ${extraName}`.trim(), cases: extraSet || [], guarded: false }];
  if (interest && interest.id !== 'maplestory') {
    if (argv.includes('--holdout')) return [{ name: `${interest.label} 홀드아웃`, cases: holdout || [], guarded: false }];
    return [{ name: `${interest.label} 평가셋`, cases: interestSet || [], guarded: true }];
  }
  if (argv.includes('--holdout')) return [{ name: '홀드아웃', cases: holdout, guarded: false }];
  return [
    { name: '평가셋', cases: evalSet, guarded: true },
    // 검증셋: 가중치·텍스트 조정에 쓰지 않는 문장 (T-113). 과적합 확인용
    { name: '검증셋', cases: validation, guarded: true }
  ];
}

// --- 대체 임베더 기준선(T-179): 문장별 1위를 파일(tools/eval-fallback-baseline.json)에 두고 문장 단위로 비교한다 ---
// 대체 임베더는 순수 JS라 Node와 크롬 결과가 같고 결정적이다. 그래서 CI에서 싸게 돌릴 수 있다.

const idOf = x => (typeof x === 'string' ? x : x.id);

/**
 * 문장 하나의 기준선 줄. kind: hit(일반) · noMatch(비유 없음, 맞고 틀림 없음) · negative(음성, hit1 = 1위가 금지 노드 아님)
 * @param {object} c 평가 문장
 * @param {(string|{id})[]} ranked 순위(앞이 1위)
 */
export function baselineRow(c, ranked) {
  const top3 = ranked.slice(0, 3).map(idOf);
  if (c.forbidNodes?.length) return { sentence: c.sentence, kind: 'negative', top3, hit1: !c.forbidNodes.includes(top3[0]) };
  if (!c.expectNodes?.length) return { sentence: c.sentence, kind: 'noMatch', top3 };
  return { sentence: c.sentence, kind: 'hit', top3, hit1: c.expectNodes.includes(top3[0]), hit3: top3.some(id => c.expectNodes.includes(id)) };
}

// 셋 하나의 기준선 줄들. 문장이 비교 열쇠라 같은 문장이 두 번 있으면 던진다
export function baselineRows(cases, rank) {
  const seen = new Set();
  return cases.map((c, i) => {
    if (seen.has(c.sentence)) throw new Error(`같은 문장이 두 번 있어요: ${c.sentence}`);
    seen.add(c.sentence);
    return baselineRow(c, rank(c, i));
  });
}

/**
 * 기준선({셋: 줄[]})과 지금 결과를 셋별로 비교한다.
 * newlyWrong: 기준선에서 1위 맞음(음성은 통과) → 지금 틀림 (실패 대상)
 * newlyRight: 반대. top1Changed: 1위 노드가 바뀐 모든 문장(정보). top3Lost/top3Gained: hit@3 잃음/얻음.
 * added/removed: 셋 파일에 더해지거나 빠진 문장(실패 아님). missingSet: 기준선에만 있는 셋
 */
export function compareBaseline(baseSets, curSets) {
  const out = {};
  for (const name of new Set([...Object.keys(baseSets), ...Object.keys(curSets)])) {
    const d = { newlyWrong: [], newlyRight: [], top1Changed: [], top3Lost: [], top3Gained: [], added: [], removed: [] };
    out[name] = d;
    const base = new Map((baseSets[name] || []).map(r => [r.sentence, r]));
    const cur = curSets[name];
    if (!cur) { d.missingSet = true; d.removed = [...base.keys()]; continue; }
    const curKeys = new Set(cur.map(r => r.sentence));
    for (const r of cur) {
      const b = base.get(r.sentence);
      if (!b) { d.added.push(r.sentence); continue; }
      const ch = { sentence: r.sentence, before: b.top3[0], after: r.top3[0] };
      if (b.top3[0] !== r.top3[0]) d.top1Changed.push(ch);
      if (b.kind !== r.kind || r.kind === 'noMatch') continue; // 기대 노드 종류가 바뀌면 맞고 틀림 비교는 뜻이 없다
      if (b.hit1 && !r.hit1) d.newlyWrong.push(ch);
      if (!b.hit1 && r.hit1) d.newlyRight.push(ch);
      if (r.kind === 'hit') {
        if (b.hit3 && !r.hit3) d.top3Lost.push(ch);
        if (!b.hit3 && r.hit3) d.top3Gained.push(ch);
      }
    }
    for (const s of base.keys()) if (!curKeys.has(s)) d.removed.push(s);
  }
  return out;
}

// 실패 기준: 기준선에서 맞던 문장이 1위에서 틀린 수 (여러 셋 합계)
export function baselineFailCount(cmp) {
  return Object.values(cmp).reduce((n, d) => n + d.newlyWrong.length, 0);
}

// 임베더 id·그래프·태그 판본이 기준선과 다르면 경고 문구 (실패 아님)
export function baselineMetaWarnings(base, cur) {
  const w = [];
  if (base.embedderId !== cur.embedderId) w.push(`임베더 id가 달라요: 기준선 ${base.embedderId} → 지금 ${cur.embedderId}`);
  if (base.tagsVersion !== cur.tagsVersion) w.push(`태그 판본이 달라요: 기준선 ${base.tagsVersion} → 지금 ${cur.tagsVersion}`);
  for (const id of new Set([...Object.keys(base.graphs || {}), ...Object.keys(cur.graphs || {})])) {
    if (base.graphs?.[id] !== cur.graphs?.[id]) w.push(`${id} 그래프 판본이 달라요: 기준선 ${base.graphs?.[id]} → 지금 ${cur.graphs?.[id]}`);
  }
  return w;
}

// 셋별 바뀐 문장 줄
export function baselineReportLines(cmp) {
  const lines = [];
  const labels = [['newlyWrong', '✗ 새로 틀림'], ['newlyRight', '✓ 새로 맞음'], ['top3Lost', '↓ 상위 3 잃음'], ['top3Gained', '↑ 상위 3 얻음'], ['top1Changed', '· 1위 바뀜']];
  for (const [name, d] of Object.entries(cmp)) {
    if (d.missingSet) { lines.push(`[${name}] 지금 결과에 이 셋이 없어요(문장 ${d.removed.length}개)`); continue; }
    const any = labels.some(([k]) => d[k].length) || d.added.length || d.removed.length;
    if (!any) { lines.push(`[${name}] 바뀐 것 없음`); continue; }
    lines.push(`[${name}]`);
    for (const [k, label] of labels) for (const x of d[k]) lines.push(`  ${label}: ${x.sentence} (1위 ${x.before} → ${x.after})`);
    for (const s of d.added) lines.push(`  + 기준선에 없는 문장: ${s}`);
    for (const s of d.removed) lines.push(`  - 셋에서 빠진 문장: ${s}`);
  }
  return lines;
}

// --- 판정기 실험 (T-120) ---

/** 지연 시간(ms) 목록 → { n, median, p90 } (선형 보간). 비면 null */
export function latencyStats(ms) {
  const xs = (ms || []).filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  const q = f => { const i = (xs.length - 1) * f, lo = Math.floor(i), hi = Math.ceil(i); return Math.round(xs[lo] + (xs[hi] - xs[lo]) * (i - lo)); };
  return { n: xs.length, median: q(0.5), p90: q(0.9) };
}

// 1위 회귀: 기준(scoreCases 결과)에서 맞던 문장이 새 결과에서 틀린 것. 비유 없음·음성 문장은 misses에 없어 빠진다
export function rank1Regressions(base, cur) {
  const was = new Set(base.misses.map(m => m.sentence));
  return cur.misses.map(m => m.sentence).filter(s => !was.has(s));
}

// 1위 개선: 기준에서 틀리던 문장이 새 결과에서 맞은 것
export function rank1Gains(base, cur) {
  const now = new Set(cur.misses.map(m => m.sentence));
  return base.misses.map(m => m.sentence).filter(s => !now.has(s));
}

/**
 * 문장별 1위 변화 (T-184). before·after는 문장 순서대로 1위 노드 id.
 * 맞음(ok): 일반 문장은 기대 노드, 음성 문장(forbidNodes)은 금지 노드가 아님, 비유 없음 문장(expectNodes [])은 null(판단 없음).
 * 1위가 바뀐 문장만 돌려준다. regressed = 맞던 것이 틀림, gained = 틀리던 것이 맞음
 * @returns {{sentence, kind:'hit'|'negative'|'noMatch', before, after, beforeOk, afterOk, regressed, gained}[]}
 */
export function rank1Changes(cases, before, after) {
  const okOf = (c, id) => c.forbidNodes?.length ? !c.forbidNodes.includes(id) : c.expectNodes?.length ? c.expectNodes.includes(id) : null;
  const out = [];
  cases.forEach((c, i) => {
    if (before[i] === after[i]) return;
    const kind = c.forbidNodes?.length ? 'negative' : c.expectNodes?.length ? 'hit' : 'noMatch';
    const beforeOk = okOf(c, before[i]), afterOk = okOf(c, after[i]);
    out.push({ sentence: c.sentence, kind, before: before[i], after: after[i], beforeOk, afterOk, regressed: beforeOk === true && afterOk === false, gained: beforeOk === false && afterOk === true });
  });
  return out;
}

// 평가 채점 (순수 함수). eval.mjs와 단위 테스트가 함께 쓴다

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

// 혼합 설정 = 확장이 실제로 쓰는 admin.json retrieval 그대로
export function mixedSetting(admin) {
  return { name: '혼합 (현재 기본값)', ...admin.retrieval };
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

// --margin-guard: 가드 문장 중 여유가 임계값 미만(틀린 문장 포함)
export function marginGuardFails(guard, margins, threshold) {
  const low = new Set(margins.filter(m => m.margin < threshold).map(m => m.sentence));
  return guard.filter(s => low.has(s));
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

// 채점할 문장 묶음. --holdout이면 홀드아웃만(예문 고를 때 보지 않는 문장, 회귀 가드 대상 아님)
export function pickSets(argv, { evalSet, validation, holdout }) {
  if (argv.includes('--holdout')) return [{ name: '홀드아웃', cases: holdout, guarded: false }];
  return [
    { name: '평가셋', cases: evalSet, guarded: true },
    // 검증셋: 가중치·텍스트 조정에 쓰지 않는 문장 (T-113). 과적합 확인용
    { name: '검증셋', cases: validation, guarded: true }
  ];
}

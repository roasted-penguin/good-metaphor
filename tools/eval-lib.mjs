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

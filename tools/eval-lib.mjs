// 평가 채점 (순수 함수). eval.mjs와 단위 테스트가 함께 쓴다

/**
 * @param {object[]} cases          { sentence, expectNodes, group? }
 * @param {(c, i) => string[]} rank 문장별 상위 노드 id (앞이 1위)
 */
export function scoreCases(cases, rank) {
  let hit1 = 0, hit3 = 0;
  const groups = {}, misses = [];
  cases.forEach((c, i) => {
    const got = rank(c, i).slice(0, 3);
    const ok1 = c.expectNodes.includes(got[0]);
    if (ok1) hit1++; else misses.push({ sentence: c.sentence, got, expect: c.expectNodes });
    if (got.some(id => c.expectNodes.includes(id))) hit3++;
    if (c.group) {
      const g = groups[c.group] ||= { hit1: 0, n: 0 };
      g.n++;
      if (ok1) g.hit1++;
    }
  });
  return { n: cases.length, hit1, hit3, groups, misses };
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

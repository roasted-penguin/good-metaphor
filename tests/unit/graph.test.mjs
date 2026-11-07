import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeGraphs, validateGraph, nodeText, tagText } from '../../extension/lib/graph.js';
import { validateOverlay } from '../../extension/lib/stores.js';

const common = JSON.parse(readFileSync('extension/data/common/maplestory.json', 'utf8'));

test('공통 그래프는 스키마 검사를 통과한다', () => {
  assert.deepEqual(validateGraph(common), []);
});

test('공통 그래프의 모든 노드 태그와 엣지가 실제로 존재한다', () => {
  const tagIds = new Set(common.tags.map(t => t.id));
  const nodeIds = new Set(common.nodes.map(n => n.id));
  for (const n of common.nodes) for (const t of n.tags) assert.ok(tagIds.has(t), `${n.id}의 태그 ${t}`);
  for (const e of common.edges) assert.ok(nodeIds.has(e.from) && nodeIds.has(e.to), `${e.from}→${e.to}`);
});

test('로그아웃 상태(오버레이 없음)는 공통 그래프 그대로', () => {
  const g = mergeGraphs(common, null);
  assert.equal(g.domain, '메이플스토리');
  assert.equal(g.theme, 'maple');
  assert.equal(g.nodes.length, common.nodes.length);
  assert.equal(g.sources.userNodes, 0);
});

test('오버레이: 숨김·추가·가중치가 합쳐진다', () => {
  const g = mergeGraphs(common, {
    hiddenNodeIds: ['sol_erda'],
    nodeBoosts: { starforce: 0.1 },
    nodes: [{ id: 'u:mine', label: '내 루틴', facts: ['매일 한다'], tags: ['daily_accumulation', 'no_such_tag'] }]
  });
  assert.ok(!g.nodes.some(n => n.id === 'sol_erda'));
  const mine = g.nodes.find(n => n.id === 'u:mine');
  assert.equal(mine.source, 'user');
  assert.deepEqual(mine.tags, ['daily_accumulation'], '없는 태그는 버린다');
  assert.equal(g.boosts.starforce, 0.1);
  assert.ok(!g.edges.some(e => e.from === 'sol_erda' || e.to === 'sol_erda'), '숨긴 노드의 엣지도 빠진다');
});

test('가중치: 손으로 넣은 nodeBoosts와 피드백 feedbackBoosts를 더하고 -0.2~0.2로 자른다 (T-130)', () => {
  const g = mergeGraphs(common, {
    nodeBoosts: { starforce: 0.1, cube: -0.2, meso: 0.15 },
    feedbackBoosts: { starforce: -0.05, cube: -0.1, auction: -0.05, meso: 0.1 }
  });
  assert.equal(g.boosts.starforce, 0.05);
  assert.equal(g.boosts.cube, -0.2, '하한');
  assert.equal(g.boosts.meso, 0.2, '상한');
  assert.equal(g.boosts.auction, -0.05, '피드백만 있으면 그 값');
  assert.equal(mergeGraphs(common, null).boosts.starforce, undefined);
});

test('관심사 변경(useCommon=false): 공통 노드는 빠지고 공통 태그 사전은 재사용', () => {
  const g = mergeGraphs(common, {
    useCommon: false, domain: '축구', theme: 'neutral',
    nodes: [{ id: 'u:offside', label: '오프사이드', facts: ['반칙이다'], tags: ['threshold_req'] }]
  });
  assert.equal(g.domain, '축구');
  assert.equal(g.analogyPrefix, '축구로 치면');
  assert.equal(g.theme, 'neutral');
  assert.deepEqual(g.nodes.map(n => n.id), ['u:offside']);
  assert.deepEqual(g.tags.map(t => t.id), ['threshold_req'], '쓰이는 태그만 검색 대상');
});

test('오버레이 검증: u: 접두어와 domain 규칙', () => {
  assert.match(validateOverlay({ nodes: [{ id: 'x', label: 'a', facts: ['f'], tags: ['t'] }] }).join(), /u:/);
  assert.match(validateOverlay({ useCommon: false }).join(), /domain/);
  assert.deepEqual(validateOverlay({ nodes: [{ id: 'u:x', label: 'a', facts: ['f'], tags: ['t'] }] }), []);
});

test('노드 임베딩 텍스트에 태그 라벨이 들어간다', () => {
  const tagMap = new Map(common.tags.map(t => [t.id, t]));
  const t = nodeText(common.nodes.find(n => n.id === 'starforce'), tagMap);
  assert.match(t, /확률형 강화/);
});

test('노드 임베딩 텍스트: 태그 설명이 모두 facts보다 앞에 온다 (T-113, 구조 비중 ↑)', () => {
  const tagMap = new Map(common.tags.map(t => [t.id, t]));
  const n = common.nodes.find(n => n.id === 'starforce');
  const t = nodeText(n, tagMap);
  const firstFact = t.indexOf(n.facts[0]);
  assert.ok(firstFact > 0, '사실이 빠졌어요');
  assert.ok(t.includes(n.label));
  for (const id of n.tags) {
    const at = t.indexOf(tagMap.get(id).desc);
    assert.ok(at >= 0 && at < firstFact, `${id} 설명이 사실보다 앞에 있어야 해요`);
  }
});

test('태그 임베딩 텍스트에 예문(examples)이 들어간다 (T-113)', () => {
  const t = tagText({ id: 'x', label: '라벨', desc: '설명', examples: ['첫 예문', '둘째 예문'] });
  assert.match(t, /라벨: 설명/);
  assert.match(t, /첫 예문/);
  assert.match(t, /둘째 예문/);
});

test('태그 examples는 문자열 배열이어야 한다', () => {
  const g = ex => ({ domain: 'd', tags: [{ id: 't', label: 'l', examples: ex }], nodes: [] });
  assert.match(validateGraph(g('x')).join(), /examples/);
  assert.match(validateGraph(g([1])).join(), /examples/);
  assert.deepEqual(validateGraph(g(['문장'])), []);
});

// 글자 3-gram 자카드: 예문이 평가 문장을 베꼈는지 본다
const grams = s => { const t = s.replace(/\s+/g, ' '); const out = new Set(); for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3)); return out; };
const jaccard = (a, b) => { const A = grams(a), B = grams(b); let n = 0; for (const g of A) if (B.has(g)) n++; return n / (A.size + B.size - n); };

test('공통 그래프 태그마다 예문 2개 이상, 평가셋·검증셋 문장을 베끼지 않는다 (누설 검사)', () => {
  const evalSentences = [
    ...JSON.parse(readFileSync('tools/eval-set.json', 'utf8')),
    ...JSON.parse(readFileSync('tools/eval-holdout.json', 'utf8'))
  ].map(c => c.sentence);
  for (const t of common.tags) {
    assert.ok(Array.isArray(t.examples) && t.examples.length >= 2, `${t.id} 예문 부족`);
    for (const ex of t.examples) for (const s of evalSentences) {
      assert.ok(jaccard(ex, s) < 0.3, `${t.id} 예문 "${ex}"이 평가 문장 "${s}"과 너무 비슷해요`);
    }
  }
});

test('태그는 통제 어휘 18개 그대로 (규칙 9)', () => {
  assert.deepEqual(common.tags.map(t => t.id).sort(), [
    'cooldown', 'daily_accumulation', 'diminishing_returns', 'efficiency_metric', 'escalating_cost', 'expected_value',
    'inflation', 'loss_risk', 'market_price', 'periodic_cap', 'prob_upgrade', 'progression_gate', 'random_reroll',
    'role_division', 'scarcity_value', 'shared_bonus', 'temporary_multiplier', 'threshold_req'
  ]);
});

// --- T-114 별칭(aliases): 게임 은어로 쓴 문장도 검색되게 ---

test('노드 aliases 검증: 문자열 배열, 각 1~20자 (T-114)', () => {
  const g = aliases => ({ domain: 'd', tags: [{ id: 't', label: 'l' }], nodes: [{ id: 'n', label: '라벨', facts: ['f'], tags: ['t'], aliases }] });
  assert.deepEqual(validateGraph(g(['재획', '스무 글자까지는 괜찮아요 정말로요요'])), []);
  assert.deepEqual(validateGraph(g([])), []);
  assert.match(validateGraph(g('재획')).join(), /aliases/);
  assert.match(validateGraph(g([1])).join(), /aliases/);
  assert.match(validateGraph(g([''])).join(), /aliases/);
  assert.match(validateGraph(g(['   '])).join(), /aliases/);
  assert.match(validateGraph(g(['가'.repeat(21)])).join(), /aliases/);
  assert.deepEqual(validateGraph(g(['가'.repeat(20)])), []);
});

test('오버레이 노드의 aliases도 같은 규칙으로 검사한다 (T-114)', () => {
  assert.match(validateOverlay({ nodes: [{ id: 'u:x', label: 'a', facts: ['f'], tags: ['t'], aliases: [''] }] }).join(), /aliases/);
  assert.deepEqual(validateOverlay({ nodes: [{ id: 'u:x', label: 'a', facts: ['f'], tags: ['t'], aliases: ['별칭'] }] }), []);
});

test('nodeText: 별칭이 없으면 예전과 바이트 단위로 같은 문자열 (벡터 캐시·검색 불변, T-114)', () => {
  const tagMap = new Map(common.tags.map(t => [t.id, t]));
  // 예전 구현 그대로(T-113)
  const before = n => `${n.tags.map(id => tagMap.get(id)).filter(Boolean).map(tagText).join(' ')} ${n.label}. ${n.facts.join(' ')}`.trim();
  for (const n of common.nodes) {
    const { aliases, ...plain } = n;
    assert.equal(nodeText(plain, tagMap), before(plain), `${n.id}`);
    assert.equal(nodeText({ ...plain, aliases: [] }, tagMap), before(plain), `${n.id} 빈 배열`);
  }
});

test('nodeText: 별칭은 라벨 뒤 괄호에 쉼표로 붙는다 (T-114)', () => {
  const tagMap = new Map([['t', { id: 't', label: '태그', desc: '설명' }]]);
  const n = { id: 'starforce', label: '스타포스 강화', facts: ['사실 하나.', '사실 둘.'], tags: ['t'], aliases: ['펑', '프텍'] };
  assert.equal(nodeText(n, tagMap), '태그: 설명 스타포스 강화(펑, 프텍). 사실 하나. 사실 둘.');
});

test('공통 그래프 aliases: naming-meme.md A 표의 은어가 대응 노드에 있다 (T-114)', () => {
  const byId = Object.fromEntries(common.nodes.map(n => [n.id, n.aliases || []]));
  const expected = {
    hunting: ['재획'], skill_cooldown: ['극딜'], starforce: ['펑', '프텍'], arcane_symbol: ['세금'],
    meso: ['쌀먹'], auction: ['쌀먹'], boss_entry: ['데카', '풀데카', '최소컷'], arcane_force: ['최소컷'],
    cube: ['잡옵'], weekly_boss: ['메요일'], party: ['기사', '버스']
  };
  for (const [id, aliases] of Object.entries(expected)) assert.deepEqual(byId[id], aliases, id);
  assert.equal(common.version, '2026.11.08-1');
});

test('평가셋에 은어 문장 4개, 대응 노드가 그래프에 있다 (T-114)', () => {
  const evalSet = JSON.parse(readFileSync('tools/eval-set.json', 'utf8'));
  const slang = evalSet.filter(c => c.since === 'T-114');
  assert.equal(slang.length, 4);
  const ids = new Set(common.nodes.map(n => n.id));
  for (const c of slang) {
    assert.equal(c.group, 'slang');
    assert.ok(c.expectNodes.length && c.expectNodes.every(id => ids.has(id)), c.sentence);
  }
  const guard = JSON.parse(readFileSync('tools/eval-guard.json', 'utf8'));
  const guardText = JSON.stringify(guard);
  for (const c of slang) assert.ok(!guardText.includes(c.sentence), '은어 문장은 회귀 가드에 넣지 않는다');
});

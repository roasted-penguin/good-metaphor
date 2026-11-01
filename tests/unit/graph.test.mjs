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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeGraphs, validateGraph, nodeText } from '../../extension/lib/graph.js';
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

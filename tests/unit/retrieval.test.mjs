import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cosine, retrieve, topTags, feedbackAdjust } from '../../extension/lib/retrieval.js';

// 3차원 장난감 그래프: 태그 경유 점수가 순위를 뒤집는지 본다
const graph = {
  tags: [{ id: 'A', label: '태그A', desc: '' }, { id: 'B', label: '태그B', desc: '' }],
  nodes: [
    { id: 'n1', label: '노드1', facts: ['f1'], tags: ['A'], source: 'common' },
    { id: 'n2', label: '노드2', facts: ['f2'], tags: ['B'], source: 'common' }
  ],
  edges: [{ from: 'n1', to: 'n2', rel: '연결' }],
  boosts: {}
};
const vecs = new Map([
  ['tag:A', [1, 0, 0]], ['tag:B', [0, 1, 0]],
  ['node:n1', [0, 1, 0.2]], ['node:n2', [0.2, 0, 1]]
]);
const q = [1, 0, 0.3];

test('cosine 기본값', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([0, 0], [1, 0]), 0);
});

test('직접 비교만 쓰면 n2, 태그 경유를 섞으면 n1이 1위', () => {
  assert.equal(retrieve(q, graph, vecs, { directWeight: 1, tagWeight: 0 })[0].id, 'n2');
  assert.equal(retrieve(q, graph, vecs, { directWeight: 0.45, tagWeight: 0.55 })[0].id, 'n1');
});

test('후보에 맞은 태그와 이웃이 붙는다', () => {
  const [top] = retrieve(q, graph, vecs, { topK: 1 });
  assert.equal(top.tag.id, 'A');
  assert.deepEqual(top.neighbors, [{ label: '노드2', rel: '연결', dir: 'out' }]);
});

test('사용자 가중치(boost)가 순위를 바꾼다', () => {
  const g = { ...graph, boosts: { n2: 0.5 } };
  assert.equal(retrieve(q, g, vecs)[0].id, 'n2');
});

test('topTags는 유사도 순', () => {
  assert.deepEqual(topTags(q, graph, vecs, 2).map(t => t.id), ['A', 'B']);
});

// 태그 점수 집계·감점 (T-113): 태그 2개(0.9·0.1) 노드 vs 태그 1개(0.6) 노드
const g2 = {
  tags: [{ id: 'A', label: 'A' }, { id: 'B', label: 'B' }, { id: 'C', label: 'C' }],
  nodes: [
    { id: 'two', label: '둘', facts: ['f'], tags: ['A', 'B'] },
    { id: 'one', label: '하나', facts: ['f'], tags: ['C'] }
  ],
  edges: [], boosts: {}
};
const q2 = [1, 0, 0];
const v2 = new Map([
  ['tag:A', [0.9, Math.sqrt(1 - 0.81), 0]], ['tag:B', [0.1, 0, Math.sqrt(1 - 0.01)]], ['tag:C', [0.6, 0.8, 0]]
]);
const tagOnly = { directWeight: 0, tagWeight: 1 };

test('tagAgg 기본(max)은 가장 높은 태그, top2mean은 상위 2개 평균', () => {
  assert.equal(retrieve(q2, g2, v2, tagOnly)[0].id, 'two');
  const r = retrieve(q2, g2, v2, { ...tagOnly, tagAgg: 'top2mean' });
  assert.equal(r[0].id, 'one');
  assert.equal(r[0].score, 0.6); // 태그 1개면 그 값 그대로
  assert.equal(r[1].score, 0.5);
});

test('tagPenalty는 그 태그 경유 점수를 깎고, 결과 tag.sim은 감점 전 값', () => {
  const r = retrieve(q2, g2, v2, { ...tagOnly, tagPenalty: { A: 0.5 } });
  assert.equal(r[0].id, 'one');
  const two = r.find(x => x.id === 'two');
  assert.equal(two.score, 0.4); // A 0.9-0.5=0.4 > B 0.1
  assert.equal(two.tag.id, 'A');
  assert.equal(two.tag.sim, 0.9);
});

// 비슷한 문장 피드백 (T-130): 질의와 코사인이 임계값 이상인 기록만 그 노드 점수를 가감한다
const near = (c) => [c, Math.sqrt(1 - c * c), 0]; // [1,0,0]과 코사인 c
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('feedbackAdjust: 같은 방향 down은 -max, 직교는 영향 없음', () => {
  const m = feedbackAdjust([1, 0, 0], [
    { vec: [1, 0, 0], nodeId: 'a', vote: 'down' },
    { vec: [0, 1, 0], nodeId: 'b', vote: 'down' }
  ]);
  close(m.get('a'), -0.1);
  close(m.get('b') ?? 0, 0);
});

test('feedbackAdjust: pick은 +max*w, 노드 합은 +max를 넘지 않음', () => {
  const same = { vec: [1, 0, 0], nodeId: 'a', vote: 'pick' };
  close(feedbackAdjust([1, 0, 0], [same]).get('a'), 0.1);
  close(feedbackAdjust([1, 0, 0], [same, same, same]).get('a'), 0.1);
  // w = (0.96 - 0.92) / 0.08 = 0.5
  close(feedbackAdjust([1, 0, 0], [{ vec: near(0.96), nodeId: 'a', vote: 'pick' }]).get('a'), 0.05, 1e-6);
});

test('feedbackAdjust: 경계 sim=0.9에서 코사인 0.9 → 0, 0.95 → -0.05', () => {
  close(feedbackAdjust([1, 0, 0], [{ vec: near(0.9), nodeId: 'a', vote: 'down' }], { sim: 0.9 }).get('a') ?? 0, 0, 1e-6);
  close(feedbackAdjust([1, 0, 0], [{ vec: near(0.95), nodeId: 'a', vote: 'down' }], { sim: 0.9 }).get('a'), -0.05, 1e-6);
});

test('feedbackAdjust: vec 없거나 길이가 다른 기록은 건너뜀', () => {
  const m = feedbackAdjust([1, 0, 0], [
    { nodeId: 'a', vote: 'down' },
    { vec: null, nodeId: 'a', vote: 'down' },
    { vec: [1, 0], nodeId: 'a', vote: 'down' },
    { vec: [1, 0, 0], nodeId: 'b', vote: 'down' }
  ]);
  assert.equal(m.has('a'), false);
  close(m.get('b'), -0.1);
});

// n2에 boost를 줘 n1(0.552)과 n2(0.511)를 가깝게 만든다
const gClose = { ...graph, boosts: { n2: 0.3 } };

test('retrieve: 메모리가 비면 결과가 옵션 없을 때와 완전히 같음(feedback 필드 없음)', () => {
  const base = retrieve(q, gClose, vecs);
  assert.deepEqual(retrieve(q, gClose, vecs, { feedbackMemory: [] }), base);
  assert.deepEqual(retrieve(q, gClose, vecs, { feedbackMemory: [{ vec: [0, 1, 0], nodeId: 'n1', vote: 'down' }] }), base);
  assert.ok(base.every(r => !('feedback' in r)));
});

test('retrieve: 같은 방향 down은 그 노드 점수를 정확히 -0.1, 순위가 내려감', () => {
  const base = retrieve(q, gClose, vecs);
  assert.equal(base[0].id, 'n1');
  const r = retrieve(q, gClose, vecs, { feedbackMemory: [{ vec: [...q], nodeId: 'n1', vote: 'down' }] });
  assert.equal(r[0].id, 'n2');
  const n1 = r.find(x => x.id === 'n1');
  assert.equal(n1.feedback, -0.1);
  close(n1.score, base.find(x => x.id === 'n1').score - 0.1, 2e-4);
  assert.equal('feedback' in r.find(x => x.id === 'n2'), false);
});

test('retrieve: feedbackSim·feedbackMax 옵션과 vec 없는 기록', () => {
  const mem = [{ nodeId: 'n1', vote: 'down' }, { vec: [...q], nodeId: 'n2', vote: 'pick' }];
  const r = retrieve(q, gClose, vecs, { feedbackMemory: mem, feedbackSim: 0.5, feedbackMax: 0.2 });
  assert.equal(r.find(x => x.id === 'n2').feedback, 0.2);
  assert.equal('feedback' in r.find(x => x.id === 'n1'), false);
});

test('feedbackAdjust: 노드 합은 마지막에 한 번만 잘라 순서와 무관', () => {
  const pick = { vec: [1, 0, 0], nodeId: 'a', vote: 'pick' };
  const down = { vec: [1, 0, 0], nodeId: 'a', vote: 'down' };
  close(feedbackAdjust([1, 0, 0], [pick, pick, pick, down]).get('a'), 0.1);
  close(feedbackAdjust([1, 0, 0], [down, pick, pick, pick]).get('a'), 0.1);
});

test('retrieve: feedbackMemory가 null이어도 예외 없이 이전과 같음', () => {
  assert.deepEqual(retrieve(q, gClose, vecs, { feedbackMemory: null }), retrieve(q, gClose, vecs));
});

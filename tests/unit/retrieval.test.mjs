import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cosine, retrieve, topTags } from '../../extension/lib/retrieval.js';

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

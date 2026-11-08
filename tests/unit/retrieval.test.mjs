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

// T-138: 정밀 모드는 검색 벡터(추상 구조 + 원문)와 피드백 기록 벡터(원문)가 달라, 비슷한 문장 판정만 원문 벡터로 한다
const sentenceVec = [0, 0, 1]; // q와 코사인 약 0.29 — 검색 벡터로는 임계값에 못 미친다

test('retrieve: feedbackQuery를 주면 그 벡터로 비슷한 문장 가감(검색 점수는 q 그대로)', () => {
  const mem = [{ vec: [...sentenceVec], nodeId: 'n1', vote: 'down' }];
  const base = retrieve(q, gClose, vecs);
  // q로는 걸리지 않는다
  assert.deepEqual(retrieve(q, gClose, vecs, { feedbackMemory: mem }), base);
  // 원문 벡터로는 같은 방향이라 -0.1
  const r = retrieve(q, gClose, vecs, { feedbackMemory: mem, feedbackQuery: sentenceVec });
  const n1 = r.find(x => x.id === 'n1');
  assert.equal(n1.feedback, -0.1);
  close(n1.score, base.find(x => x.id === 'n1').score - 0.1, 2e-4);
  // 직접·태그 유사도는 q로 계산한 값 그대로
  assert.equal(n1.direct, base.find(x => x.id === 'n1').direct);
  assert.deepEqual(n1.tag, base.find(x => x.id === 'n1').tag);
});

test('retrieve: feedbackQuery 미지정·null이면 결과가 이전과 완전히 같음', () => {
  const mem = [{ vec: [...q], nodeId: 'n1', vote: 'down' }];
  const before = retrieve(q, gClose, vecs, { feedbackMemory: mem });
  assert.deepEqual(retrieve(q, gClose, vecs, { feedbackMemory: mem, feedbackQuery: undefined }), before);
  assert.deepEqual(retrieve(q, gClose, vecs, { feedbackMemory: mem, feedbackQuery: null }), before);
  assert.deepEqual(retrieve(q, gClose, vecs, { feedbackQuery: sentenceVec }), retrieve(q, gClose, vecs));
});

// --- T-114 별칭 어휘 가산(aliasBoost): 은어가 낱말로 있으면 그 노드에 점수를 더한다 ---
import { aliasMatch } from '../../extension/lib/retrieval.js';

test('aliasMatch: 문장 처음·공백·문장부호 뒤에 오면 맞고, 뒤에는 조사가 붙어도 된다', () => {
  assert.equal(aliasMatch('메요일이라 보스 초기화됐다.', ['메요일']), true);
  assert.equal(aliasMatch('22성 도전하다가 또 펑 났다.', ['펑', '프텍']), true);
  assert.equal(aliasMatch('오늘도 재획을 돌렸다', ['재획']), true);
  assert.equal(aliasMatch('또 펑났다', ['펑']), true);
  assert.equal(aliasMatch('결과는 "펑"이었다', ['펑']), true);
  assert.equal(aliasMatch('(재획) 두 시간', ['재획']), true);
});

test('aliasMatch: 없거나 다른 낱말 안에 들어 있으면 맞지 않는다', () => {
  assert.equal(aliasMatch('누진세는 소득 구간이 높아질수록 세율이 커진다.', ['세금']), false);
  assert.equal(aliasMatch('종합세금 신고', ['세금']), false);
  assert.equal(aliasMatch('셔틀버스를 탔다', ['버스']), false);
  assert.equal(aliasMatch('펑펑 울었다', ['펑']) , true, '앞이 경계면 뒤는 무엇이든 된다(조사 규칙의 대가)');
  assert.equal(aliasMatch('', ['재획']), false);
  assert.equal(aliasMatch('재획', []), false);
  assert.equal(aliasMatch('재획', undefined), false);
});

test('aliasMatch: NFKC로 맞춘 뒤 비교한다(전각 문장부호 뒤도 경계)', () => {
  assert.equal(aliasMatch('오늘！재획', ['재획']), true);
  assert.equal(aliasMatch('ＡＢ 재획'.normalize('NFD'), ['재획']), true);
});

const gAlias = {
  ...graph,
  nodes: [graph.nodes[0], { ...graph.nodes[1], aliases: ['펑'] }]
};

test('retrieve: 별칭이 없는 문장은 aliasBoost를 줘도 결과가 완전히 같다', () => {
  const base = retrieve(q, gAlias, vecs);
  assert.deepEqual(retrieve(q, gAlias, vecs, { aliasBoost: 0.08, aliasText: '아무 상관 없는 문장' }), base);
  assert.deepEqual(retrieve(q, gAlias, vecs, { aliasBoost: 0.08 }), base, 'aliasText가 없으면 영향 없음');
  assert.deepEqual(retrieve(q, gAlias, vecs, { aliasText: '또 펑 났다' }), base, 'aliasBoost 기본값 0');
});

test('retrieve: 별칭이 낱말로 있으면 그 노드 점수에 aliasBoost를 정확히 더한다', () => {
  const all = o => Object.fromEntries(retrieve(q, gAlias, vecs, { topK: 2, ...o }).map(r => [r.id, r.score]));
  const base = all({});
  const hit = all({ aliasBoost: 0.08, aliasText: '또 펑 났다' });
  assert.equal(hit.n1, base.n1);
  assert.ok(Math.abs(hit.n2 - base.n2 - 0.08) < 1e-4, `${hit.n2} - ${base.n2}`);
  // 큰 가산이면 순위가 뒤집힌다
  assert.equal(retrieve(q, gAlias, vecs, { aliasBoost: 0.5, aliasText: '또 펑 났다' })[0].id, 'n2');
});

// --- T-149 약한 별칭(weakAliases): 일상어와 겹치는 은어는 메이플 단서가 함께 있을 때만 가산 ---
import { mapleCue, labelCueWords, MAPLE_GENERIC_WORDS } from '../../extension/lib/retrieval.js';
import { mergeGraphs } from '../../extension/lib/graph.js';
import { loadCommonGraphFromDisk } from '../../tools/load-graph.mjs';

const commonMerged = mergeGraphs(loadCommonGraphFromDisk(), null);

test('labelCueWords: 공통 노드 라벨에서 괄호를 빼고, 끝의 과·와를 떼고, 2글자 이상 낱말 중 일반어가 아닌 것', () => {
  const g = { nodes: [
    { id: 'a', label: '잠재능력 재설정(큐브)', source: 'common' },
    { id: 'b', label: '사냥 효율과 재획', source: 'common' },
    { id: 'c', label: '주간 보스와 결정석', source: 'common' },
    { id: 'u:x', label: '내가 만든 노드', source: 'user' }
  ] };
  const words = labelCueWords(g);
  assert.ok(!words.includes('큐브'), '괄호 안은 뺀다');
  assert.ok(words.includes('재획'));
  assert.ok(words.includes('결정석'));
  assert.ok(!words.includes('효율') && !words.includes('효율과'), '일반어');
  assert.ok(!words.includes('보스') && !words.includes('보스와'), '일반어');
  assert.ok(!words.includes('내가') && !words.includes('노드'), '사용자 노드 라벨은 단서가 아니다');
});

test('MAPLE_GENERIC_WORDS: 모든 항목이 지금 공통 라벨 낱말이다(죽은 항목 없음)', () => {
  const raw = new Set(commonMerged.nodes.flatMap(n => n.label.replace(/\([^)]*\)/g, ' ').split(/\s+/))
    .map(w => (w.length >= 3 ? w.replace(/[과와]$/, '') : w)).filter(w => w.length >= 2));
  for (const w of MAPLE_GENERIC_WORDS) assert.ok(raw.has(w), `${w}는 라벨 낱말이 아니에요`);
  const cues = labelCueWords(commonMerged);
  for (const w of cues) assert.ok(!MAPLE_GENERIC_WORDS.includes(w));
  assert.ok(cues.includes('메소') && cues.includes('스타포스') && cues.includes('아케인'));
});

test('mapleCue: 강한 별칭이나 라벨 핵심 낱말이 낱말로 있으면 참', () => {
  assert.equal(mapleCue('이번 주 세금 내고 나니 메소가 바닥났다.', commonMerged), true, '메소');
  assert.equal(mapleCue('오늘도 재획 돌리고 세금 냈다', commonMerged), true, '강한 별칭 재획');
  assert.equal(mapleCue('아케인 지역 세금 냈다', commonMerged), true, '아케인');
  assert.equal(mapleCue('스타포스 하다가 펑', commonMerged), true);
});

test('mapleCue: 일반어만 있거나 아무것도 없으면 거짓', () => {
  assert.equal(mapleCue('연말정산 때 세금 신고를 미리 준비해야 한다.', commonMerged), false);
  assert.equal(mapleCue('22성 도전하다가 또 펑 났다.', commonMerged), false);
  assert.equal(mapleCue('보스가 파티 조건을 강화하고 난이도를 올렸다.', commonMerged), false, '일반어만');
  assert.equal(mapleCue('', commonMerged), false);
});

// T-152: 라벨 단서 낱말 뒤에 한글이 바로 붙으면 조사로 시작할 때만 단서다(메소포타미아·샤이닝스타는 다른 낱말)
test('mapleCue: 라벨 단서 낱말 뒤 한글은 조사로 시작할 때만 단서로 친다', () => {
  assert.equal(mapleCue('메소가 바닥났다', commonMerged), true, '메소가');
  assert.equal(mapleCue('메소포타미아 문명', commonMerged), false, '메소포타미아');
  assert.equal(mapleCue('샤이닝이 다시 개봉했다', commonMerged), true, '샤이닝이');
  assert.equal(mapleCue('샤이닝스타 상을 받았다', commonMerged), false, '샤이닝스타');
  assert.equal(mapleCue('아케인에서 사냥했다', commonMerged), true, '아케인에서');
  assert.equal(mapleCue('아케인으로 갔다', commonMerged), true, '아케인으로');
  assert.equal(mapleCue('스타포스까지 했다', commonMerged), true, '스타포스까지');
  assert.equal(mapleCue('스타포스부터 했다', commonMerged), true, '스타포스부터');
  assert.equal(mapleCue('메소만 날렸다', commonMerged), true, '메소만');
  assert.equal(mapleCue('메소, 펑', commonMerged), true, '뒤가 문장부호');
  assert.equal(mapleCue('메소2억 날렸다', commonMerged), true, '뒤가 숫자(한글 아님)');
  assert.equal(mapleCue('아케인포스가 모자라다', commonMerged), true, '더 긴 단서 낱말(아케인포스)은 그대로');
  assert.equal(mapleCue('에르다의 흐름', commonMerged), true, '에르다의');
  assert.equal(mapleCue('스타포스타워에 올랐다', commonMerged), false, '스타포스타워');
});

// T-152 리뷰: 랑·이랑·하고·처럼·보다, 하/해/했/한/할(동사 붙음) 추가, 조사 뒤에 다른 낱말이 이어지면 단서 아님
test('mapleCue: 랑·처럼·보다·하고와 동사 붙음(하다/했다)도 단서, 조사 뒤에 낱말이 이어지면 아님', () => {
  assert.equal(mapleCue('스타포스하다가 또', commonMerged), true, '스타포스하다가');
  assert.equal(mapleCue('스타포스했다', commonMerged), true, '스타포스했다');
  assert.equal(mapleCue('스타포스해서 날렸다', commonMerged), true, '스타포스해서');
  assert.equal(mapleCue('메소랑 바꿨다', commonMerged), true, '메소랑');
  assert.equal(mapleCue('메소이랑 바꿨다', commonMerged), true, '메소이랑');
  assert.equal(mapleCue('메소하고 바꿨다', commonMerged), true, '메소하고');
  assert.equal(mapleCue('메소처럼 쓴다', commonMerged), true, '메소처럼');
  assert.equal(mapleCue('메소보다 비싸다', commonMerged), true, '메소보다');
  assert.equal(mapleCue('메소에서는 달랐다', commonMerged), true, '조사 두 개(에서+는)');
  assert.equal(mapleCue('메소보다도 비싸다', commonMerged), true, '조사 두 개(보다+도)');
  assert.equal(mapleCue('메소포타미아', commonMerged), false, '메소포타미아');
  assert.equal(mapleCue('아케인과학 연구소', commonMerged), false, '아케인과학(과 뒤에 낱말)');
  assert.equal(mapleCue('메소도시 문명', commonMerged), false, '메소도시(도 뒤에 낱말)');
});

test('mapleCue: 강한 별칭은 aliasMatch 그대로(조사가 아닌 활용도 붙는다)', () => {
  assert.equal(mapleCue('재획하고 왔다', commonMerged), true, '재획하고');
});

const gWeak = {
  ...graph,
  nodes: [
    { ...graph.nodes[0], label: '메소' },
    { ...graph.nodes[1], weakAliases: ['펑'] }
  ]
};

test('retrieve: 약한 별칭은 단서가 없으면 가산하지 않는다(결과가 완전히 같다)', () => {
  const base = retrieve(q, gWeak, vecs, { topK: 2 });
  assert.deepEqual(retrieve(q, gWeak, vecs, { topK: 2, aliasBoost: 0.08, aliasText: '타이어가 펑 터졌다' }), base);
});

test('retrieve: 약한 별칭은 단서(라벨 낱말)가 있으면 aliasBoost를 정확히 더한다', () => {
  const all = o => Object.fromEntries(retrieve(q, gWeak, vecs, { topK: 2, ...o }).map(r => [r.id, r.score]));
  const base = all({});
  const hit = all({ aliasBoost: 0.08, aliasText: '메소 날리고 또 펑 났다' });
  assert.equal(hit.n1, base.n1);
  assert.ok(Math.abs(hit.n2 - base.n2 - 0.08) < 1e-4, `${hit.n2} - ${base.n2}`);
});

test('retrieve: 강한 별칭과 약한 별칭이 함께 맞아도 가산은 한 번', () => {
  const g = { ...gWeak, nodes: [gWeak.nodes[0], { ...gWeak.nodes[1], aliases: ['프텍'] }] };
  const all = o => Object.fromEntries(retrieve(q, g, vecs, { topK: 2, ...o }).map(r => [r.id, r.score]));
  const base = all({});
  const hit = all({ aliasBoost: 0.08, aliasText: '프텍 걸고 펑 났다' });
  assert.ok(Math.abs(hit.n2 - base.n2 - 0.08) < 1e-4);
});

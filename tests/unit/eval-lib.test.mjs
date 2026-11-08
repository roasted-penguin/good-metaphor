import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scoreCases, mixedSetting, regressions } from '../../tools/eval-lib.mjs';
import { loadCommonGraphFromDisk } from '../../tools/load-graph.mjs';

const read = p => JSON.parse(readFileSync(p, 'utf8'));
const common = loadCommonGraphFromDisk();
const admin = read('extension/config/admin.json');
const evalSet = read('tools/eval-set.json');
const holdout = read('tools/eval-holdout.json');

test('scoreCases: hit@1·hit@3와 그룹별 hit@1을 센다', () => {
  const cases = [
    { sentence: '가', expectNodes: ['a'], group: 'finance' },
    { sentence: '나', expectNodes: ['b'], group: 'finance' },
    { sentence: '다', expectNodes: ['c'] }
  ];
  const ranks = { 가: ['a', 'x', 'y'], 나: ['x', 'b', 'y'], 다: ['c', 'x', 'y'] };
  const r = scoreCases(cases, (c) => ranks[c.sentence]);
  assert.equal(r.n, 3);
  assert.equal(r.hit1, 2);
  assert.equal(r.hit3, 3);
  assert.deepEqual(r.groups, { finance: { hit1: 1, n: 2 } });
  assert.equal(r.misses.length, 1);
  assert.equal(r.misses[0].sentence, '나');
  assert.deepEqual(r.misses[0].got, ['x', 'b', 'y']);
});

test('평가셋의 금융 그룹: 기존 문장은 T-113에서 틀린 5문장, T-103 새 금융 문장은 7개', () => {
  assert.equal(evalSet.filter(c => c.group === 'finance' && c.since === 'T-103').length, 7);
  const fin = evalSet.filter(c => c.group === 'finance' && !c.since).map(c => c.sentence.slice(0, 3));
  assert.deepEqual(fin.sort(), ['Lev', '누진세', '레버리', '백화점', '복권의'].sort());
});

test('검증셋: 10문장 이상, 금융 3개 이상, 그래프에 있는 id만, 본 평가셋과 겹치지 않음', () => {
  const nodeIds = new Set(common.nodes.map(n => n.id));
  const tagIds = new Set(common.tags.map(t => t.id));
  const evalSentences = new Set(evalSet.map(c => c.sentence));
  assert.ok(holdout.length >= 10, `검증셋 ${holdout.length}문장`);
  assert.ok(holdout.filter(c => c.group === 'finance').length >= 3);
  for (const c of holdout) {
    assert.ok(c.expectNodes.length && c.expectNodes.every(id => nodeIds.has(id)), c.sentence);
    assert.ok(tagIds.has(c.expectTag), c.sentence);
    assert.ok(!evalSentences.has(c.sentence), c.sentence);
  }
});

test('mixedSetting: 평가 도구의 혼합 설정은 admin.json retrieval을 그대로 쓴다', () => {
  const s = mixedSetting(admin);
  for (const [k, v] of Object.entries(admin.retrieval)) assert.deepEqual(s[k], v, k);
});

test('regressions: 지켜야 할 문장 중 hit@1을 놓친 것만 돌려준다', () => {
  const cases = [{ sentence: '가', expectNodes: ['a'] }, { sentence: '나', expectNodes: ['b'] }, { sentence: '다', expectNodes: ['c'] }];
  const r = scoreCases(cases, c => ({ 가: ['a'], 나: ['x'], 다: ['x'] })[c.sentence]);
  assert.deepEqual(regressions(['가', '나'], r), ['나']);
  assert.deepEqual(regressions([], r), []);
});

test('회귀 가드 목록의 문장은 모두 평가셋·검증셋에 있다', () => {
  const guard = read('tools/eval-guard.json');
  const all = new Set([...evalSet, ...holdout].map(c => c.sentence));
  assert.ok(guard.length > 0);
  assert.equal(new Set(guard).size, guard.length, '중복');
  for (const s of guard) assert.ok(all.has(s), s);
});

test('scoreCases: 맞는 비유가 없어야 하는 문장(expectNodes: [])은 hit에서 빼고 1위 점수와 함께 따로 센다 (T-103)', () => {
  const cases = [
    { sentence: '가', expectNodes: ['a'] },
    { sentence: '없음', expectNodes: [] }
  ];
  const ranks = { 가: [{ id: 'a', score: 0.8 }, { id: 'x', score: 0.5 }], 없음: [{ id: 'x', score: 0.6 }] };
  const r = scoreCases(cases, c => ranks[c.sentence]);
  assert.equal(r.n, 1);
  assert.equal(r.hit1, 1);
  assert.deepEqual(r.noMatch, [{ sentence: '없음', top: 'x', score: 0.6 }]);
  assert.deepEqual(r.hitScores, [0.8]);
  assert.equal(r.misses.length, 0);
});

// 한글이 하나도 없으면 영어 문장으로 본다
const isEnglish = s => !/[\uac00-\ud7a3]/.test(s);

test('평가셋: 40문장 이상, 영어 25% 이상, 맞는 비유 없는 문장 5개 이상 (T-103)', () => {
  // 별칭 음성 문장(forbidNodes, T-149)은 한국어 일상어 검사라 따로 센다. 비율은 기존 평가 문장으로만 본다
  // 은어 문장(group slang, T-114·T-152)도 한국어 게임 은어 검사라 비율에서 뺀다(T-152에서 5문장 추가)
  const base = evalSet.filter(c => !c.forbidNodes && c.group !== 'slang');
  assert.ok(base.length >= 40, `평가셋 ${base.length}문장`);
  const en = base.filter(c => isEnglish(c.sentence)).length;
  assert.ok(en / base.length >= 0.25, `영어 ${en}/${base.length}`);
  assert.ok(base.filter(c => c.expectNodes.length === 0).length >= 5);
});

test('평가셋: id는 모두 공통 그래프에 있고, 문장 중복이 없다', () => {
  const nodeIds = new Set(common.nodes.map(n => n.id));
  const tagIds = new Set(common.tags.map(t => t.id));
  const seen = new Set(holdout.map(c => c.sentence));
  for (const c of evalSet) {
    assert.ok(Array.isArray(c.expectNodes) && c.expectNodes.every(id => nodeIds.has(id)), c.sentence);
    if (c.expectNodes.length) assert.ok(tagIds.has(c.expectTag), c.sentence);
    assert.ok(!seen.has(c.sentence), `중복: ${c.sentence}`);
    seen.add(c.sentence);
  }
});

// 글자 3-gram 자카드: 새 문장이 태그 설명·예문을 베끼지 않았는지 본다
const grams = s => { const t = s.replace(/\s+/g, ' '); const out = new Set(); for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3)); return out; };
const jaccard = (a, b) => { const A = grams(a), B = grams(b); let n = 0; for (const g of A) if (B.has(g)) n++; return n / (A.size + B.size - n); };

test('T-103 새 문장은 태그 설명·예문과 3-gram 자카드 < 0.3', () => {
  const tagTexts = common.tags.flatMap(t => [t.desc || '', ...(t.examples || [])]);
  const fresh = evalSet.filter(c => c.since === 'T-103');
  assert.ok(fresh.length >= 24, `새 문장 ${fresh.length}개`);
  for (const c of fresh) for (const t of tagTexts) {
    assert.ok(jaccard(c.sentence, t) < 0.3, `"${c.sentence}" ↔ "${t}"`);
  }
});

test('admin.json retrieval.tagPenalty는 공통 그래프에 있는 태그 id에만 0~0.1 사이 값 (T-113, 규칙 9)', () => {
  const tagIds = new Set(common.tags.map(t => t.id));
  const pen = admin.retrieval.tagPenalty;
  assert.ok(pen && Object.keys(pen).length, 'tagPenalty 없음');
  for (const [id, v] of Object.entries(pen)) {
    assert.ok(tagIds.has(id), `없는 태그: ${id}`);
    assert.ok(v > 0 && v <= 0.1, `${id}: ${v}`);
  }
});

test('admin.json 임베딩 모델은 e5-base q8 (T-113 결정)', () => {
  assert.equal(admin.embedding.model, 'Xenova/multilingual-e5-base');
  assert.equal(admin.embedding.dtype, 'q8');
});

test('바꿔 말한 문장 쌍: 24쌍 이상, 같음·다름 각 12쌍 이상, a는 평가셋·검증셋 문장, a !== b (T-130)', () => {
  const pairs = read('tools/paraphrase-pairs.json');
  const all = new Set([...evalSet, ...holdout].map(c => c.sentence));
  assert.ok(Array.isArray(pairs) && pairs.length >= 24, `쌍 ${pairs.length}개`);
  assert.ok(pairs.filter(p => p.same === true).length >= 12, '같은 뜻 쌍 부족');
  assert.ok(pairs.filter(p => p.same === false).length >= 12, '다른 뜻 쌍 부족');
  for (const p of pairs) {
    assert.equal(typeof p.same, 'boolean', p.a);
    assert.ok(typeof p.a === 'string' && all.has(p.a), `평가셋·검증셋에 없음: ${p.a}`);
    assert.ok(typeof p.b === 'string' && p.b.trim() && p.a !== p.b, p.a);
  }
});

// --- T-149 별칭 음성 문장: forbidNodes가 1위가 아니면 통과. hit@1 분모·비유 없음 목록과 따로 센다 ---
test('scoreCases: forbidNodes 문장은 negative로 따로 세고 n·noMatch를 바꾸지 않는다', () => {
  const cases = [
    { sentence: '가', expectNodes: ['a'] },
    { sentence: '없음', expectNodes: [] },
    { sentence: '음1', expectNodes: [], forbidNodes: ['a'], group: 'alias-negative' },
    { sentence: '음2', expectNodes: [], forbidNodes: ['b', 'c'], group: 'alias-negative' }
  ];
  const ranks = { 가: ['a'], 없음: [{ id: 'x', score: 0.5 }], 음1: ['x', 'a'], 음2: ['c', 'x'] };
  const r = scoreCases(cases, c => ranks[c.sentence]);
  assert.equal(r.n, 1);
  assert.equal(r.hit1, 1);
  assert.equal(r.noMatch.length, 1);
  assert.deepEqual(r.groups, {}, '음성 그룹은 hit@1 그룹 표에 넣지 않는다');
  assert.equal(r.negative.n, 2);
  assert.equal(r.negative.pass, 1);
  assert.deepEqual(r.negative.fails, [{ sentence: '음2', top: 'c', forbid: ['b', 'c'] }]);
});

test('scoreCases: 음성 문장이 없으면 negative는 0/0', () => {
  const r = scoreCases([{ sentence: '가', expectNodes: ['a'] }], () => ['a']);
  assert.deepEqual(r.negative, { n: 0, pass: 0, fails: [] });
});

test('평가셋 alias-negative: 4문장 이상, forbidNodes는 그래프 id, expectNodes는 비어 있음, 가드에 없음 (T-149)', () => {
  const nodeIds = new Set(common.nodes.map(n => n.id));
  const neg = evalSet.filter(c => c.group === 'alias-negative');
  assert.ok(neg.length >= 4, `${neg.length}문장`);
  const guard = new Set(read('tools/eval-guard.json'));
  for (const c of neg) {
    assert.deepEqual(c.expectNodes, [], c.sentence);
    assert.ok(c.forbidNodes?.length && c.forbidNodes.every(id => nodeIds.has(id)), c.sentence);
    assert.match(c.since, /^T-\d+$/, c.sentence); // T-149에서 시작, 이후 작업이 더한다(T-152)
    assert.ok(!guard.has(c.sentence));
  }
  // 기존 지표 분모가 그대로: 음성이 아닌 문장 수와 비유 없음 문장 수
  const plain = evalSet.filter(c => !c.forbidNodes);
  // T-152에서 은어 홀드아웃 5문장(starforce)을 더해 39 → 44
  assert.equal(plain.filter(c => c.expectNodes.length).length, 44);
  assert.equal(evalSet.filter(c => c.group === 'slang' && c.since === 'T-152').length, 5);
  assert.equal(plain.filter(c => !c.expectNodes.length).length, 5);
});

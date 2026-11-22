import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addRecord, removeRecord, setReason, applyFeedback, feedbackKey, FEEDBACK_MAX, maskSentence, bumpHover, summarizeFeedback, feedbackPercent, formatFeedbackStats, similarMemory, boostForNode, reportedNodes, feedbackForGraph } from '../../extension/lib/feedback.js';

// 검색 후보(retrieve 결과 모양만 흉내)
const cands = ['a', 'b', 'c', 'd'].map((id, i) => ({ id, label: id.toUpperCase(), score: 1 - i * 0.1 }));
const rec = (over) => ({ id: over.id || Math.random().toString(36).slice(2), ts: over.ts || 1, sentenceHash: 'h1', nodeId: 'a', vote: 'down', ...over });

test('👎: 그 문장에서 그 노드가 빠지고 다음 후보가 1위', () => {
  const r = applyFeedback(cands, [rec({ nodeId: 'a', vote: 'down' })], 'h1', 3);
  assert.deepEqual(r.candidates.map(c => c.id), ['b', 'c', 'd']);
  assert.equal(r.applied, true);
  assert.deepEqual(r.excluded, ['a']);
  assert.equal(r.pinned, null);
});

test('pick: 고른 노드만 후보로 고정된다 (근거 검증은 이 후보로 그대로)', () => {
  const r = applyFeedback(cands, [rec({ nodeId: 'a', vote: 'pick', pickedNodeId: 'c' })], 'h1', 3);
  assert.deepEqual(r.candidates.map(c => c.id), ['c']);
  assert.equal(r.pinned, 'c');
  assert.equal(r.applied, true);
});

test('pick한 노드가 검색 후보에 없으면 고정하지 않는다 (근거 밖 금지, 규칙 1)', () => {
  const r = applyFeedback(cands, [rec({ vote: 'pick', pickedNodeId: 'zzz' })], 'h1', 3);
  assert.equal(r.pinned, null);
  assert.deepEqual(r.candidates.map(c => c.id), ['a', 'b', 'c']);
});

test('다른 문장에는 영향이 없다', () => {
  const r = applyFeedback(cands, [rec({ sentenceHash: 'h2', nodeId: 'a', vote: 'down' })], 'h1', 3);
  assert.deepEqual(r.candidates.map(c => c.id), ['a', 'b', 'c']);
  assert.equal(r.applied, false);
});

test('👍은 후보를 바꾸지 않는다', () => {
  const r = applyFeedback(cands, [rec({ vote: 'up' })], 'h1', 3);
  assert.deepEqual(r.candidates.map(c => c.id), ['a', 'b', 'c']);
  assert.equal(r.applied, false);
});

test('나중 기록이 이긴다: pick한 노드를 나중에 👎하면 고정이 풀리고 빠진다', () => {
  const r = applyFeedback(cands, [
    rec({ ts: 1, vote: 'pick', pickedNodeId: 'c' }),
    rec({ ts: 2, nodeId: 'c', vote: 'down' })
  ], 'h1', 3);
  assert.equal(r.pinned, null);
  assert.deepEqual(r.candidates.map(c => c.id), ['a', 'b', 'd']);
});

test('addRecord: 최근 500건만 남긴다', () => {
  let list = [];
  for (let i = 0; i < FEEDBACK_MAX + 5; i++) list = addRecord(list, rec({ id: 'r' + i, ts: i }));
  assert.equal(FEEDBACK_MAX, 500);
  assert.equal(list.length, 500);
  assert.equal(list[0].id, 'r5');
  assert.equal(list.at(-1).id, 'r504');
});

test('removeRecord(되돌리기): 그 기록만 지우면 원래 후보로 돌아온다', () => {
  const list = addRecord([], rec({ id: 'x', nodeId: 'a', vote: 'down' }));
  const back = removeRecord(list, 'x');
  assert.deepEqual(back, []);
  assert.deepEqual(applyFeedback(cands, back, 'h1', 3).candidates.map(c => c.id), ['a', 'b', 'c']);
});

test('feedbackKey: 그 문장의 기록이 바뀔 때만 바뀐다 (결과 캐시 무효화용)', () => {
  const base = [rec({ id: 'p', sentenceHash: 'h2' })];
  const k0 = feedbackKey(base, 'h1');
  assert.equal(feedbackKey([...base, rec({ id: 'q', sentenceHash: 'h3' })], 'h1'), k0);
  assert.notEqual(feedbackKey([...base, rec({ id: 'r', sentenceHash: 'h1' })], 'h1'), k0);
});

test('feedbackKey: 👍은 후보를 바꾸지 않으니 지문도 바꾸지 않는다 (불필요한 LLM 재호출 방지)', () => {
  const base = [rec({ id: 'p', vote: 'down' })];
  assert.equal(feedbackKey([...base, rec({ id: 'u', vote: 'up' })], 'h1'), feedbackKey(base, 'h1'));
});

test('setReason: 그 기록에만 이유를 붙이고 정해진 값만 받는다', () => {
  const list = [rec({ id: 'x' }), rec({ id: 'y' })];
  const out = setReason(list, 'x', 'forced');
  assert.equal(out.find(r => r.id === 'x').reason, 'forced');
  assert.equal(out.find(r => r.id === 'y').reason, undefined);
  assert.throws(() => setReason(list, 'x', '<script>'), /이유/);
});

test('maskSentence: 메일·주소·긴 숫자·전화번호를 가린다', () => {
  assert.equal(
    maskSentence('연락은 hong@example.com 이나 010-1234-5678, 주문번호 20261101로 주세요. https://a.b/c 참고'),
    '연락은 [메일] 이나 [숫자], 주문번호 [숫자]로 주세요. [주소] 참고'
  );
});

test('maskSentence: 1~3자리 숫자는 그대로 둔다', () => {
  const s = '이 약은 최소 4시간을 기다려야 한다.';
  assert.equal(maskSentence(s), s);
});

test('maskSentence: 주소 뒤에 붙은 조사는 남긴다 (T-137)', () => {
  assert.equal(maskSentence('https://a.com/x에서 받았다'), '[주소]에서 받았다');
  assert.equal(maskSentence('https://a.com/x을 열었다'), '[주소]을 열었다');
  assert.equal(maskSentence('www.a.com는 느리다'), '[주소]는 느리다');
  assert.equal(maskSentence('http://a.com/p?q=1로 보낸다'), '[주소]로 보낸다');
});

test('maskSentence: 주소 끝 한글이 알려진 조사가 아니면 함께 가린다(경로가 새지 않게) (T-137)', () => {
  assert.equal(maskSentence('https://a.com/wiki/Maple스토리'), '[주소]');
  assert.equal(maskSentence('https://a.com/u/hong길동 님'), '[주소] 님');
  assert.equal(maskSentence('https://a.com/x1234가나 참고'), '[주소] 참고');
  // 조사가 붙어도 조사가 아닌 한글 덩어리면 통째로 가린다
  assert.equal(maskSentence('https://a.com/u/hong길동에서'), '[주소]');
});

test('maskSentence: 겹친 조사도 남긴다 (T-137)', () => {
  assert.equal(maskSentence('https://a.com/x에서는 된다'), '[주소]에서는 된다');
  assert.equal(maskSentence('https://a.com/x까지는 간다'), '[주소]까지는 간다');
  assert.equal(maskSentence('https://a.com/x의 글'), '[주소]의 글');
});

test('maskSentence: 문장 끝·괄호의 주소 (T-137)', () => {
  assert.equal(maskSentence('자세한 건 https://a.com/x.'), '자세한 건 [주소].');
  assert.equal(maskSentence('자세한 건 https://a.com/x로.'), '자세한 건 [주소]로.');
  assert.equal(maskSentence('출처(https://a.com/x)를 보라'), '출처([주소])를 보라');
  assert.equal(maskSentence('출처(https://a.com/x)'), '출처([주소])');
});

test('maskSentence: 주소 안 한글 경로는 함께 가린다(새지 않게) (T-137)', () => {
  assert.equal(maskSentence('https://ko.wikipedia.org/wiki/메이플스토리에서 봤다'), '[주소] 봤다');
  assert.equal(maskSentence('https://a.com/q=홍길동'), '[주소]');
  // 조사를 떼도 주소 안 숫자·메일은 남지 않는다
  assert.equal(maskSentence('https://a.com/u/12345678에서'), '[주소]에서');
});

test('bumpHover: 그날 값이 1 늘어난다', () => {
  assert.deepEqual(bumpHover({}, '2026-11-01'), { '2026-11-01': 1 });
  assert.deepEqual(bumpHover({ '2026-11-01': 2 }, '2026-11-01'), { '2026-11-01': 3 });
});

test('bumpHover: 가장 최근 14일만 남긴다', () => {
  const counts = {};
  for (let d = 1; d <= 15; d++) counts[`2026-10-${String(d).padStart(2, '0')}`] = 1;
  const next = bumpHover(counts, '2026-10-16');
  assert.equal(Object.keys(next).length, 14);
  assert.equal(next['2026-10-01'], undefined);
  assert.equal(next['2026-10-02'], undefined);
  assert.equal(next['2026-10-16'], 1);
});

test('summarizeFeedback: 오늘 포함 지난 7일만 센다', () => {
  // 로컬 정오로 만들어 시간대와 무관하게 날짜가 맞게 한다
  const at = (day) => new Date(2026, 10, day, 12).getTime();
  const records = [
    rec({ ts: at(2), vote: 'up' }),
    rec({ ts: at(3), vote: 'down' }),
    rec({ ts: at(8), vote: 'down' }),
    rec({ ts: at(5), vote: 'pick', pickedNodeId: 'b' }),
    rec({ ts: at(1), vote: 'down' }), // 범위 밖
  ];
  const counts = { '2026-11-01': 5, '2026-11-02': 3, '2026-11-08': 2 };
  assert.deepEqual(summarizeFeedback(records, counts, '2026-11-08'), { hovers: 5, up: 1, down: 2, pick: 1 });
});

test('summarizeFeedback: 빈 입력이면 모두 0', () => {
  assert.deepEqual(summarizeFeedback([], {}, '2026-11-08'), { hovers: 0, up: 0, down: 0, pick: 0 });
});

test('feedbackPercent: 호버 대비 반올림 정수, 100% 상한, 호버 0·모름이면 null (T-137)', () => {
  assert.equal(feedbackPercent(3, 18), 17);
  assert.equal(feedbackPercent(1, 3), 33);
  assert.equal(feedbackPercent(2, 3), 67);
  assert.equal(feedbackPercent(0, 5), 0);
  assert.equal(feedbackPercent(5, 2), 100);
  assert.equal(feedbackPercent(3, 0), null);
  assert.equal(feedbackPercent(3, undefined), null);
  assert.equal(feedbackPercent(3, NaN), null);
});

test('formatFeedbackStats: 개수 옆 호버 대비 %, 호버 0이면 개수만 (T-137)', () => {
  assert.equal(formatFeedbackStats({ hovers: 18, up: 1, down: 3, pick: 0 }),
    '지난 7일 · 호버 18번 · 👍 1 (6%) · 👎 3 (17%) · 교정 0 (0%)');
  assert.equal(formatFeedbackStats({ hovers: 0, up: 1, down: 2, pick: 1 }),
    '지난 7일 · 호버 0번 · 👍 1 · 👎 2 · 교정 1');
});

// ── 비슷한 문장 메모리 (T-130) ──

test('similarMemory: 다른 문장의 👎만 넣고 지금 문장·벡터 없는 기록·👍은 뺀다', () => {
  const v = [0.1, 0.2];
  const m = similarMemory([
    rec({ sentenceHash: 'h1', nodeId: 'a', vote: 'down', vec: v }),
    rec({ sentenceHash: 'h2', nodeId: 'b', vote: 'down', vec: v }),
    rec({ sentenceHash: 'h3', nodeId: 'c', vote: 'down' }),
    rec({ sentenceHash: 'h4', nodeId: 'd', vote: 'up', vec: v })
  ], 'h1');
  assert.deepEqual(m, [{ vec: v, nodeId: 'b', vote: 'down' }]);
});

test('similarMemory: pick은 pickedNodeId를 nodeId로 쓴다', () => {
  const v = [1, 0];
  const m = similarMemory([rec({ sentenceHash: 'h2', nodeId: 'a', vote: 'pick', pickedNodeId: 'c', vec: v })], 'h1');
  assert.deepEqual(m, [{ vec: v, nodeId: 'c', vote: 'pick' }]);
});

test('similarMemory: 같은 문장·노드는 나중 기록이 이긴다, 고정은 문장마다 하나', () => {
  const v = [1, 0];
  // pick c 다음에 c를 👎 → 그 문장의 c는 down만
  const m1 = similarMemory([
    rec({ ts: 2, sentenceHash: 'h2', nodeId: 'c', vote: 'down', vec: v }),
    rec({ ts: 1, sentenceHash: 'h2', nodeId: 'a', vote: 'pick', pickedNodeId: 'c', vec: v })
  ], 'h1');
  assert.deepEqual(m1, [{ vec: v, nodeId: 'c', vote: 'down' }]);
  // pick b 다음에 pick c → c만 고정
  const m2 = similarMemory([
    rec({ ts: 1, sentenceHash: 'h2', nodeId: 'a', vote: 'pick', pickedNodeId: 'b', vec: v }),
    rec({ ts: 2, sentenceHash: 'h2', nodeId: 'a', vote: 'pick', pickedNodeId: 'c', vec: v })
  ], 'h1');
  assert.deepEqual(m2, [{ vec: v, nodeId: 'c', vote: 'pick' }]);
  // 서로 다른 문장의 같은 노드 👎는 각각 남는다
  const m3 = similarMemory([
    rec({ sentenceHash: 'h2', nodeId: 'a', vote: 'down', vec: v }),
    rec({ sentenceHash: 'h3', nodeId: 'a', vote: 'down', vec: [0, 1] })
  ], 'h1');
  assert.equal(m3.length, 2);
});

test('similarMemory: 기록이 없으면 빈 배열', () => {
  assert.deepEqual(similarMemory([], 'h1'), []);
  assert.deepEqual(similarMemory(undefined, 'h1'), []);
});

// 로그인 사용자 노드 가중치 (T-130). 가중치는 기록만으로 정해진다(0 = 가중치 없음).
const down = (h, nodeId = 'cube', ts = 0) => ({ id: `${h}-${ts}`, ts, sentenceHash: h, nodeId, vote: 'down' });

test('boostForNode: 서로 다른 문장 👎 2건이면 0', () => {
  assert.equal(boostForNode([down('a', 'cube', 1), down('b', 'cube', 2)], 'cube'), 0);
  assert.equal(boostForNode([], 'cube'), 0);
});

test('boostForNode: 3문장이면 -0.05, 4문장이면 -0.10', () => {
  const three = [down('a', 'cube', 1), down('b', 'cube', 2), down('c', 'cube', 3)];
  assert.equal(boostForNode(three, 'cube'), -0.05);
  assert.equal(boostForNode([...three, down('d', 'cube', 4)], 'cube'), -0.1);
});

test('boostForNode: 같은 문장 반복 👎는 값을 바꾸지 않는다', () => {
  const three = [down('a', 'cube', 1), down('b', 'cube', 2), down('c', 'cube', 3)];
  assert.equal(boostForNode([...three, down('b', 'cube', 4), down('a', 'cube', 5)], 'cube'), -0.05);
});

test('boostForNode: 다른 노드·👍·고정 기록은 세지 않는다', () => {
  const recs = [
    down('a', 'cube', 1), down('b', 'meso', 2),
    { id: 'u', ts: 3, sentenceHash: 'c', nodeId: 'cube', vote: 'up' },
    { id: 'p', ts: 4, sentenceHash: 'd', nodeId: 'cube', vote: 'pick', pickedNodeId: 'star' },
    down('e', 'cube', 5)
  ];
  assert.equal(boostForNode(recs, 'cube'), 0);
});

test('boostForNode: 하한 -0.2, 부동소수 오차 없음', () => {
  const recs = n => 'abcdefghij'.slice(0, n).split('').map((h, i) => down(h, 'cube', i));
  assert.equal(boostForNode(recs(5), 'cube'), -0.15);
  assert.equal(boostForNode(recs(6), 'cube'), -0.2);
  assert.equal(boostForNode(recs(10), 'cube'), -0.2);
});

test('boostForNode: 👎 → 되돌리기 → 다시 👎를 반복해도 더 내려가지 않는다', () => {
  let recs = [down('s1', 'cube', 1), down('s2', 'cube', 2), down('s3', 'cube', 3)];
  assert.equal(boostForNode(recs, 'cube'), -0.05);
  recs = removeRecord(recs, 's3-3');
  assert.equal(boostForNode(recs, 'cube'), 0);
  for (let t = 4; t < 8; t++) {
    recs = addRecord(recs, down('s3', 'cube', t));
    assert.equal(boostForNode(recs, 'cube'), -0.05);
    recs = removeRecord(recs, `s3-${t}`);
    assert.equal(boostForNode(recs, 'cube'), 0);
  }
});

// --- T-118 "사실이 틀렸어요" 제보 3건이면 공통 노드를 후보에서 뺀다 ---

const RG = {
  nodes: [
    { id: 'starforce', label: '스타포스', source: 'common', verifiedAt: '2026-10-11' },
    { id: 'meso', label: '메소', source: 'common', verifiedAt: '2026-11-08' },
    { id: 'u:mine', label: '내 노드', source: 'user' }
  ]
};
const after = new Date(2026, 9, 12, 9).getTime();   // 2026-10-12 09:00 (로컬)
const fact = (sentenceHash, over = {}) => rec({ sentenceHash, nodeId: 'starforce', vote: 'down', reason: 'fact', ts: after, ...over });

test('제보: 서로 다른 문장 3건이면 그 공통 노드를 뺀다 (T-118)', () => {
  assert.deepEqual([...reportedNodes([fact('s1'), fact('s2'), fact('s3')], RG)], ['starforce']);
  assert.deepEqual([...reportedNodes([fact('s1'), fact('s2')], RG)], [], '2건은 아직');
});

test('제보: 같은 문장은 몇 번이어도 1건 (T-118)', () => {
  assert.equal(reportedNodes([fact('s1'), fact('s1'), fact('s1')], RG).size, 0);
  assert.equal(reportedNodes([fact('s1'), fact('s1'), fact('s2'), fact('s3')], RG).size, 1);
});

test('제보: verifiedAt(로컬 자정) 이전 제보는 세지 않는다 — 다시 검수하면 풀린다 (T-118)', () => {
  const before = new Date(2026, 9, 10, 23, 59).getTime();
  assert.equal(reportedNodes([fact('s1', { ts: before }), fact('s2'), fact('s3')], RG).size, 0);
  const midnight = new Date(2026, 9, 11, 0, 0).getTime();
  assert.equal(reportedNodes([fact('s1', { ts: midnight }), fact('s2'), fact('s3')], RG).size, 1, '검수 당일 자정부터 센다');
  // 같은 기록이어도 노드를 다시 검수해 verifiedAt이 오르면 빠지지 않는다
  const rechecked = { nodes: [{ ...RG.nodes[0], verifiedAt: '2026-11-01' }] };
  assert.equal(reportedNodes([fact('s1'), fact('s2'), fact('s3')], rechecked).size, 0);
});

test('제보: forced·meaning·none·이유 없음·👍·고정은 세지 않는다 (T-118)', () => {
  for (const reason of ['forced', 'meaning', 'none', undefined]) {
    assert.equal(reportedNodes([fact('s1', { reason }), fact('s2', { reason }), fact('s3', { reason })], RG).size, 0, String(reason));
  }
  assert.equal(reportedNodes([fact('s1', { vote: 'up' }), fact('s2', { vote: 'pick' }), fact('s3')], RG).size, 0);
});

test('제보: 사용자 노드·그래프에 없는 노드는 대상이 아니다 (T-118)', () => {
  const u = h => fact(h, { nodeId: 'u:mine' });
  assert.equal(reportedNodes([u('s1'), u('s2'), u('s3')], RG).size, 0);
  const gone = h => fact(h, { nodeId: 'gone' });
  assert.equal(reportedNodes([gone('s1'), gone('s2'), gone('s3')], RG).size, 0);
  // u: 접두어면 source 표시가 없어도 사용자 노드로 본다
  const g2 = { nodes: [{ id: 'u:x', label: 'x', verifiedAt: '2020-01-01' }] };
  const ux = h => fact(h, { nodeId: 'u:x' });
  assert.equal(reportedNodes([ux('s1'), ux('s2'), ux('s3')], g2).size, 0);
});

test('제보: 노드마다 따로 세고 threshold를 바꿀 수 있다 (T-118)', () => {
  const m = h => fact(h, { nodeId: 'meso', ts: new Date(2026, 10, 9).getTime() });
  const recs = [fact('s1'), fact('s2'), fact('s3'), m('s1'), m('s2')];
  assert.deepEqual([...reportedNodes(recs, RG)], ['starforce']);
  assert.deepEqual([...reportedNodes(recs, RG, { threshold: 2 })].sort(), ['meso', 'starforce']);
  assert.equal(reportedNodes([], RG).size, 0);
  assert.equal(reportedNodes(undefined, RG).size, 0);
});

// T-302: 관심사를 바꾸면 다른 관심사 노드에 남긴 기록은 조용히 빠진다(그래프에 있는 노드 기록만)
test('feedbackForGraph: 그래프에 없는 노드를 가리키는 기록은 빼고, 내 노드(u:)·지금 그래프 노드 기록은 남긴다 (T-302)', () => {
  const graph = { nodes: [{ id: 'lunch_peak' }, { id: 'no_show' }, { id: 'u:mine', source: 'user' }] };
  const records = [
    rec({ id: 'r1', nodeId: 'starforce', vote: 'down' }),                               // 메이플 노드 👎 → 뺀다
    rec({ id: 'r2', nodeId: 'cube', vote: 'pick', pickedNodeId: 'meso' }),              // 메이플 고정 → 뺀다
    rec({ id: 'r3', nodeId: 'lunch_peak', vote: 'down' }),                              // 식당 노드 → 남긴다
    rec({ id: 'r4', nodeId: null, vote: 'pick', pickedNodeId: 'no_show' }),             // 비유 없음에서 고른 식당 노드
    rec({ id: 'r5', nodeId: 'u:mine', vote: 'down' }),                                  // 내 노드는 관심사와 무관
    rec({ id: 'r6', nodeId: 'lunch_peak', vote: 'pick', pickedNodeId: 'starforce' })    // 고른 쪽이 다른 관심사 → 뺀다
  ];
  assert.deepEqual(feedbackForGraph(records, graph).map(r => r.id), ['r3', 'r4', 'r5']);
  assert.deepEqual(feedbackForGraph(null, graph), []);
  assert.deepEqual(feedbackForGraph(records, null), [], '그래프가 없으면 아무 기록도 쓰지 않는다');
});

test('feedbackForGraph 뒤 applyFeedback: 다른 관심사의 고정·👎는 후보를 바꾸지 않고 오류도 없다 (T-302)', () => {
  const graph = { nodes: cands.map(c => ({ id: c.id })) };
  const foreign = [rec({ nodeId: 'starforce', vote: 'down' }), rec({ nodeId: 'starforce', vote: 'pick', pickedNodeId: 'cube', ts: 2 })];
  const r = applyFeedback(cands, feedbackForGraph(foreign, graph), 'h1', 3);
  assert.deepEqual(r.candidates.map(c => c.id), ['a', 'b', 'c']);
  assert.equal(r.applied, false);
  assert.deepEqual(r.excluded, []);
  assert.equal(r.pinned, null);
  assert.equal(feedbackKey(feedbackForGraph(foreign, graph), 'h1'), '', '캐시 지문도 비어 있다');
});

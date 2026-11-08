// 교정 → 예문 후보·평가셋 후보 (T-131, ADR 0010 3단계)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectCorrections, collectPraise, toExampleCandidates, copiesEval, syncCorrectionExamples,
  buildCorrectionsExport, filterEvalCopies, EXAMPLE_CAP, EVAL_COPY_MIN
} from '../../extension/lib/corrections.js';
import { charJaccard } from '../../extension/lib/grounding.js';

// 병합 그래프 흉내: 공통 노드 2개 + 사용자 노드 1개, 공통 태그 + 내 태그(u_focus)
const graph = {
  tags: [
    { id: 'inflation', label: '인플레이션', source: 'common' },
    { id: 'currency', label: '화폐', source: 'common' },
    { id: 'prob_upgrade', label: '확률형 강화', source: 'common' },
    { id: 'daily_accumulation', label: '매일 쌓기', source: 'common' },
    { id: 'u_focus', label: '몰입 시간', source: 'user' }
  ],
  nodes: [
    { id: 'meso', label: '메소', tags: ['inflation', 'currency'] },
    { id: 'cube', label: '큐브', tags: ['prob_upgrade'] },
    { id: 'u:focus', label: '내 몰입 루틴', tags: ['u_focus', 'daily_accumulation'], source: 'user' }
  ]
};
const commonTagIds = new Set(['inflation', 'currency', 'prob_upgrade', 'daily_accumulation']);
const S1 = '중앙은행이 돈을 많이 찍어내면 물가가 오르고 화폐 가치가 떨어진다.';
const S2 = '아침마다 같은 시간에 공부를 하면 집중하는 시간이 점점 길어진다.';
const S3 = '보석을 세공할 때마다 깨질 수 있지만 성공하면 값이 크게 오른다.';
let seq = 0;
const rec = over => ({ id: 'r' + ++seq, ts: ++seq, sentenceHash: 'h:' + over.sentence, nodeId: null, tagId: null, provider: 'demo/x', ...over });
const pick = (sentence, pickedNodeId, over = {}) => rec({ sentence, vote: 'pick', pickedNodeId, ...over });
const terms = [{ term: '나쁜말', variants: ['나 쁜 말'], status: '승인' }];

/* ───── 수집 ───── */

test('collectCorrections: pick 기록만 교정으로, 모양은 { sentence, sentenceHash, nodeId, tagId, source, ts }', () => {
  const recs = [
    rec({ sentence: S1, vote: 'down', nodeId: 'cube' }),
    rec({ sentence: S1, vote: 'up', nodeId: 'meso' }),
    pick(S1, 'meso', { nodeId: 'cube' }),
    // 비유 없음 화면의 후보 선택도 같은 모양(nodeId 없음)
    pick(S3, 'cube')
  ];
  const out = collectCorrections(recs, graph);
  assert.equal(out.length, 2);
  const m = out.find(c => c.nodeId === 'meso');
  assert.deepEqual(Object.keys(m).sort(), ['nodeId', 'sentence', 'sentenceHash', 'source', 'tagId', 'ts']);
  assert.equal(m.sentence, S1);
  assert.equal(m.source, 'pick');
  assert.equal(m.tagId, 'inflation');
  assert.equal(out.find(c => c.nodeId === 'cube').tagId, 'prob_upgrade');
});

test('collectCorrections: 같은 문장은 가장 최근 pick 하나만', () => {
  const recs = [pick(S1, 'cube', { ts: 10 }), pick(S1, 'meso', { ts: 20 })];
  const out = collectCorrections(recs, graph);
  assert.equal(out.length, 1);
  assert.equal(out[0].nodeId, 'meso');
  // 저장 순서와 상관없이 ts가 큰 것
  assert.equal(collectCorrections([...recs].reverse(), graph)[0].nodeId, 'meso');
});

test('collectCorrections: tagId는 기록의 고른 노드 태그(pickedTagId, 그 노드 태그일 때만), 없으면 tags[0]', () => {
  assert.equal(collectCorrections([pick(S1, 'meso', { pickedTagId: 'currency' })], graph)[0].tagId, 'currency');
  // 고른 노드의 태그가 아니면 무시하고 tags[0]
  assert.equal(collectCorrections([pick(S1, 'meso', { pickedTagId: 'prob_upgrade' })], graph)[0].tagId, 'inflation');
  // 기록의 tagId(보던 노드의 태그)는 고른 노드 태그로 쓰지 않는다
  assert.equal(collectCorrections([pick(S1, 'meso', { tagId: 'currency' })], graph)[0].tagId, 'inflation');
});

test('collectCorrections: 그래프에 없는 노드(지운 내 노드)·pickedNodeId 없는 기록은 뺀다', () => {
  const out = collectCorrections([pick(S1, 'u:gone'), rec({ sentence: S2, vote: 'pick' })], graph);
  assert.deepEqual(out, []);
});

test('collectPraise: 👍만 { sentence, nodeId, tagId, source: up }, 나중에 👎·pick이 온 문장은 뺀다', () => {
  const recs = [
    rec({ sentence: S1, vote: 'up', nodeId: 'meso' }),
    rec({ sentence: S3, vote: 'up', nodeId: 'cube' }),
    rec({ sentence: S3, vote: 'down', nodeId: 'cube' }),
    rec({ sentence: S2, vote: 'up', nodeId: 'u:focus' }),
    pick(S2, 'meso')
  ];
  const out = collectPraise(recs, graph);
  assert.deepEqual(out, [{ sentence: S1, nodeId: 'meso', tagId: 'inflation', source: 'up' }]);
});

/* ───── 거름 ───── */

const corr = (sentence, nodeId = 'meso', tagId = 'inflation', ts = 1) => ({ sentence, sentenceHash: 'h:' + sentence, nodeId, tagId, source: 'pick', ts });

test('toExampleCandidates: 가림(maskSentence)을 먼저 적용한 텍스트가 후보', () => {
  const { accepted } = toExampleCandidates([corr('문의는 help@example.com 으로, 주문번호 12345678 기준 환불은 3일 걸린다.')]);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].text, '문의는 [메일] 으로, 주문번호 [숫자] 기준 환불은 3일 걸린다.');
  assert.equal(accepted[0].tagId, 'inflation');
  assert.equal(accepted[0].nodeId, 'meso');
  assert.equal(accepted[0].count, 1);
});

test('toExampleCandidates: 금칙어(우회 표기 포함)는 blocked', () => {
  const { accepted, rejected } = toExampleCandidates([corr('이 글은 나.쁜 말 이 섞인 아주 긴 문장이에요.')], { blockTerms: terms });
  assert.equal(accepted.length, 0);
  assert.equal(rejected[0].reason, 'blocked');
});

test('copiesEval: 평가 문장과 글자 3-gram 자카드 ≥ 0.5면 베끼기', () => {
  const evalS = ['API 서버는 분당 요청 수에 상한을 두어 한 사용자가 자원을 독점하지 못하게 한다.'];
  const near = 'API 서버는 분당 요청 수에 상한을 두어 한 사람이 자원을 독점하지 못하게 한다.';
  assert.ok(charJaccard(near, evalS[0]) >= EVAL_COPY_MIN);
  assert.equal(copiesEval(near, evalS), true);
  assert.equal(copiesEval(S3, evalS), false);
  assert.equal(copiesEval(near, []), false);
});

test('toExampleCandidates: 평가셋·검증셋·가드 문장을 베끼면 copies-eval', () => {
  const evalSentences = [S1];
  const { accepted, rejected } = toExampleCandidates([corr(S1.replace('많이', '아주 많이')), corr(S3, 'cube', 'prob_upgrade')], { evalSentences });
  assert.deepEqual(rejected.map(r => r.reason), ['copies-eval']);
  assert.deepEqual(accepted.map(a => a.text), [S3]);
});

test('toExampleCandidates: 그 태그의 기존 예문과 자카드 ≥ 0.8이면 duplicate, 다른 태그 예문과는 비교하지 않는다', () => {
  const existing = { inflation: [S1] };
  const r1 = toExampleCandidates([corr(S1 + ' ')], { existingExamples: existing });
  assert.equal(r1.rejected[0].reason, 'duplicate');
  const r2 = toExampleCandidates([corr(S1, 'meso', 'currency')], { existingExamples: existing });
  assert.equal(r2.accepted.length, 1);
});

test('toExampleCandidates: 같은 태그·같은 텍스트는 count로 합치고, 거의 같은 텍스트는 duplicate', () => {
  const a = '주문번호 1234567 상품은 물가가 오르면 값도 같이 오른다.';
  const b = '주문번호 7654321 상품은 물가가 오르면 값도 같이 오른다.'; // 가리면 a와 같다
  const c = '주문번호 1234567 상품은 물가가 오르면 값도 같이 오른다요.';
  const { accepted, rejected } = toExampleCandidates([corr(a), corr(b), corr(c)]);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].count, 2);
  assert.deepEqual(rejected.map(r => r.reason), ['duplicate']);
});

test('toExampleCandidates: 정규화 후 8자 미만은 too-short, 200자 초과는 too-long', () => {
  const { accepted, rejected } = toExampleCandidates([corr('  물가   오름  '), corr('가'.repeat(201)), corr('가나다라마바사아')]);
  assert.deepEqual(rejected.map(r => r.reason), ['too-short', 'too-long']);
  assert.equal(accepted.length, 1);
});

/* ───── 내 오버레이에 바로 반영 ───── */

const overlay = (over = {}) => ({
  useCommon: true, nodes: [graph.nodes[2]], hiddenNodeIds: [], nodeBoosts: {},
  tags: [{ id: 'u_focus', label: '몰입 시간', examples: ['손으로 적은 예문은 그대로 남아야 한다.'] }],
  ...over
});
const opts = { blockTerms: terms, commonTagIds };

test('syncCorrectionExamples: 사용자 노드 + 오버레이 태그면 가린 문장을 그 태그 examples에 덧붙인다', () => {
  const recs = [pick('오늘 2026년 목표를 세우고 매일 같은 시간에 공부하면 몰입이 길어진다.', 'u:focus')];
  const { overlay: ov, changed } = syncCorrectionExamples(overlay(), recs, graph, opts);
  assert.equal(changed, true);
  assert.deepEqual(ov.tags[0].examples, ['손으로 적은 예문은 그대로 남아야 한다.', '오늘 [숫자]년 목표를 세우고 매일 같은 시간에 공부하면 몰입이 길어진다.']);
  assert.deepEqual(ov.correctionExamples, { u_focus: ['오늘 [숫자]년 목표를 세우고 매일 같은 시간에 공부하면 몰입이 길어진다.'] });
});

test('syncCorrectionExamples: 공통 노드 교정·공통 태그로 가는 사용자 노드 교정은 오버레이를 건드리지 않는다', () => {
  const recs = [pick(S1, 'meso'), pick(S2, 'u:focus', { pickedTagId: 'daily_accumulation' })];
  const before = overlay();
  const { overlay: ov, changed } = syncCorrectionExamples(before, recs, graph, opts);
  assert.equal(changed, false);
  assert.deepEqual(ov, before);
});

test('syncCorrectionExamples: 내 태그가 공통 태그 id를 덮어쓴 경우도 공통 태그로 보고 건드리지 않는다', () => {
  const g = { ...graph, nodes: [{ id: 'u:x', label: 'x', tags: ['currency'], source: 'user' }] };
  const before = overlay({ tags: [{ id: 'currency', label: '내 화폐', examples: [] }] });
  assert.equal(syncCorrectionExamples(before, [pick(S1, 'u:x')], g, opts).changed, false);
});

test('syncCorrectionExamples: 태그당 상한 5개, 넘으면 오래된 교정 예문부터 빠지고 손으로 적은 예문은 남는다', () => {
  const texts = [
    '첫째 교정: 새벽에 일어나 책상에 앉는 습관이 쌓이면 몰입이 쉬워진다.',
    '둘째 교정: 운동을 매일 조금씩 하면 몸이 점점 가벼워지는 것을 느낀다.',
    '셋째 교정: 외국어 단어를 날마다 외우면 어느 순간 문장이 들리기 시작한다.',
    '넷째 교정: 악기 연습을 거르지 않으면 손가락이 저절로 길을 기억한다.',
    '다섯째 교정: 일기를 꾸준히 쓰면 생각을 정리하는 속도가 빨라진다.',
    '여섯째 교정: 화분에 물을 정해진 날 주면 잎이 고르게 자라난다.',
    '일곱째 교정: 저축을 자동이체로 걸어 두면 모르는 사이에 목돈이 모인다.'
  ];
  const recs = texts.map((t, i) => pick(t, 'u:focus', { ts: 100 + i }));
  const { overlay: ov } = syncCorrectionExamples(overlay(), recs, graph, opts);
  assert.equal(EXAMPLE_CAP, 5);
  const ex = ov.tags[0].examples;
  assert.equal(ex[0], '손으로 적은 예문은 그대로 남아야 한다.');
  assert.equal(ov.correctionExamples.u_focus.length, 5);
  assert.deepEqual(ex.slice(1), ov.correctionExamples.u_focus);
  assert.deepEqual(ex.slice(1), texts.slice(2)); // 첫째·둘째가 빠졌다
});

test('syncCorrectionExamples: 금칙어 문장은 넣지 않고, 기록이 사라지면(되돌리기·전부 지우기) 교정 예문도 빠진다', () => {
  const blocked = pick('몰입할 때 나쁜말 이 섞이면 예문이 될 수 없어요.', 'u:focus');
  const good = pick(S2, 'u:focus');
  const first = syncCorrectionExamples(overlay(), [blocked, good], graph, opts).overlay;
  assert.deepEqual(first.correctionExamples.u_focus, [S2]);
  const cleared = syncCorrectionExamples(first, [], graph, opts);
  assert.equal(cleared.changed, true);
  assert.deepEqual(cleared.overlay.tags[0].examples, ['손으로 적은 예문은 그대로 남아야 한다.']);
  assert.equal(cleared.overlay.correctionExamples, undefined);
  // 다시 맞춰도 바뀌는 것이 없다
  assert.equal(syncCorrectionExamples(cleared.overlay, [], graph, opts).changed, false);
});

test('syncCorrectionExamples: 손으로 적은 예문과 거의 같은 교정 문장은 duplicate로 넣지 않는다', () => {
  const recs = [pick('손으로 적은 예문은 그대로 남아야 한다', 'u:focus')];
  assert.equal(syncCorrectionExamples(overlay(), recs, graph, opts).changed, false);
});

/* ───── 운영자 승인 큐 내보내기 ───── */

const meta = { blockTerms: terms, commonTagIds, generatedAt: '2026-11-09T00:00:00.000Z', commonGraphVersion: 'g1', tagsVersion: 't1' };

test('buildCorrectionsExport: 모양, 가린 문장, 공통 노드·공통 태그만, rejected는 이유·개수만', () => {
  const recs = [
    pick('물가 지수 1234567 이 오르면 같은 돈으로 살 수 있는 물건이 줄어든다.', 'meso'),
    pick('물가 지수 7654321 이 오르면 같은 돈으로 살 수 있는 물건이 줄어든다.', 'meso'),
    pick('짧다', 'meso'),
    pick('보석 세공이 나쁜말 처럼 실패하면 다시 시작해야 한다는 이야기예요.', 'cube'),
    pick(S2, 'u:focus'),
    rec({ sentence: '연락처 010-1234-5678 로 물으면 금리가 오른 이유를 알려 준다.', vote: 'up', nodeId: 'meso' }),
    rec({ sentence: S2 + ' 정말로', vote: 'up', nodeId: 'u:focus' })
  ];
  const ex = buildCorrectionsExport(recs, graph, meta);
  assert.equal(ex.kind, 'good-metaphor-corrections');
  assert.equal(ex.version, 1);
  assert.equal(ex.generatedAt, meta.generatedAt);
  assert.equal(ex.commonGraphVersion, 'g1');
  assert.equal(ex.tagsVersion, 't1');
  assert.deepEqual(ex.exampleCandidates, [{ tagId: 'inflation', text: '물가 지수 [숫자] 이 오르면 같은 돈으로 살 수 있는 물건이 줄어든다.', nodeId: 'meso', count: 2 }]);
  assert.deepEqual(ex.rejected.sort((a, b) => a.reason.localeCompare(b.reason)), [
    { tagId: 'prob_upgrade', reason: 'blocked', count: 1 },
    { tagId: 'inflation', reason: 'too-short', count: 1 }
  ]);
  for (const r of ex.rejected) assert.deepEqual(Object.keys(r).sort(), ['count', 'reason', 'tagId']);
  // 평가셋 후보: 공통 노드 pick, 가림, 같은 가린 문장은 하나, 금칙어·길이 밖은 뺌
  assert.deepEqual(ex.evalCandidates.map(e => e.sentence), ['물가 지수 [숫자] 이 오르면 같은 돈으로 살 수 있는 물건이 줄어든다.']);
  assert.deepEqual(ex.evalCandidates[0].expectNodes, ['meso']);
  assert.equal(ex.evalCandidates[0].expectTag, 'inflation');
  assert.equal(ex.evalCandidates[0].source, 'pick');
  assert.deepEqual(ex.guardCandidates, [{ sentence: '연락처 [숫자] 로 물으면 금리가 오른 이유를 알려 준다.', expectNodes: ['meso'], source: 'up' }]);
  // 사용자 노드·원문 숫자·금칙어가 어디에도 없다
  const s = JSON.stringify(ex);
  for (const bad of ['u:focus', S2, '1234567', '010-1234', '나쁜말']) assert.ok(!s.includes(bad), bad);
});

test('filterEvalCopies(운영자 도구): 평가 문장을 베낀 예문 후보는 rejected로 옮기고, 이미 평가셋에 있는 평가·가드 후보는 뺀다', () => {
  const ex = buildCorrectionsExport([pick(S1, 'meso'), pick(S3, 'cube'), rec({ sentence: S1, vote: 'up', nodeId: 'meso' })], graph, meta);
  // S1 👍은 이미 평가 문장이라 빠지고, 직접 더한 S3 👍만 남는다
  ex.guardCandidates.push({ sentence: S3, expectNodes: ['cube'], source: 'up' });
  const out = filterEvalCopies(ex, [S1]);
  assert.deepEqual(out.exampleCandidates.map(c => c.text), [S3]);
  assert.deepEqual(out.rejected, [{ tagId: 'inflation', reason: 'copies-eval', count: 1 }]);
  assert.deepEqual(out.evalCandidates.map(c => c.sentence), [S3]);
  assert.deepEqual(out.guardCandidates.map(c => c.sentence), [S3]);
  // 원본은 바꾸지 않는다
  assert.equal(ex.exampleCandidates.length, 2);
});

test('filterEvalCopies: 내보낸 뒤 늘어난 금칙어도 운영자 쪽에서 다시 거른다', () => {
  const ex = buildCorrectionsExport([pick(S3, 'cube')], graph, { ...meta, blockTerms: [] });
  const out = filterEvalCopies(ex, [], { blockTerms: [{ term: '세공', status: '승인' }] });
  assert.deepEqual(out.exampleCandidates, []);
  assert.deepEqual(out.rejected, [{ tagId: 'prob_upgrade', reason: 'blocked', count: 1 }]);
  assert.deepEqual(out.evalCandidates, []);
});

test('buildCorrectionsExport: 공통 태그의 지금 예문(tags.json)과 거의 같은 후보는 duplicate', () => {
  const g = { ...graph, tags: graph.tags.map(t => (t.id === 'prob_upgrade' ? { ...t, examples: [S3] } : t)) };
  const ex = buildCorrectionsExport([pick(S3 + ' ', 'cube')], g, meta);
  assert.deepEqual(ex.exampleCandidates, []);
  assert.deepEqual(ex.rejected, [{ tagId: 'prob_upgrade', reason: 'duplicate', count: 1 }]);
});

test('운영자 도구(tools/check-corrections.mjs): 평가셋·검증셋·가드 문장을 모두 읽고, 베낀 예문 후보를 거른다', async () => {
  const { evalSentencesFromDisk, blockTermsFromDisk } = await import('../../tools/check-corrections.mjs');
  const { readFileSync } = await import('node:fs');
  const read = f => JSON.parse(readFileSync(new URL(`../../tools/${f}`, import.meta.url), 'utf8'));
  const all = evalSentencesFromDisk();
  for (const s of [read('eval-set.json')[0].sentence, read('eval-holdout.json')[0].sentence, read('eval-guard.json').at(-1)]) assert.ok(all.includes(s), s);
  assert.ok(blockTermsFromDisk().length > 0);
  const holdout = read('eval-holdout.json')[0].sentence;
  const ex = buildCorrectionsExport([pick(holdout, 'cube'), pick(S3, 'cube', { ts: 1e9 })], graph, meta);
  const out = filterEvalCopies(ex, all);
  assert.deepEqual(out.exampleCandidates.map(c => c.text), [S3]);
  assert.deepEqual(out.rejected, [{ tagId: 'prob_upgrade', reason: 'copies-eval', count: 1 }]);
});

/* ───── 수정 1회: 한 문장을 예문과 평가 문장 두 곳에 쓰지 않게 ───── */

test('filterEvalCopies: 공통 태그 지금 예문(tags.json)과 자카드 ≥ 0.5인 평가·가드 후보는 뺀다', () => {
  const ex = buildCorrectionsExport([pick(S3, 'cube'), pick(S1, 'meso')], graph, meta);
  ex.guardCandidates.push({ sentence: S1.replace('많이', '아주 많이'), expectNodes: ['meso'], source: 'up' });
  const out = filterEvalCopies(ex, [], { commonExamples: [S1] });
  assert.deepEqual(out.evalCandidates.map(c => c.sentence), [S3]);
  assert.deepEqual(out.guardCandidates, []);
});

test('buildCorrectionsExport: 예문 후보이기도 한 평가·가드 후보에는 alsoExampleCandidate: true', () => {
  const recs = [pick(S3, 'cube'), pick('짧은 문장이지만 금칙어는 없는 나쁜말 문장입니다.', 'meso'), rec({ sentence: S3 + ' 정말', vote: 'up', nodeId: 'cube' })];
  const ex = buildCorrectionsExport(recs, graph, { ...meta, blockTerms: [] });
  const e = ex.evalCandidates.find(c => c.sentence === S3);
  assert.equal(e.alsoExampleCandidate, true);
  assert.equal(ex.guardCandidates[0].alsoExampleCandidate, true);
  // 예문 후보가 아닌 평가 후보에는 붙지 않는다(중복으로 예문에서 빠진 경우 등)
  const g = { ...graph, tags: graph.tags.map(t => (t.id === 'prob_upgrade' ? { ...t, examples: [S3] } : t)) };
  const ex2 = buildCorrectionsExport([pick(S3, 'cube')], g, meta);
  assert.equal(ex2.exampleCandidates.length, 0);
  assert.equal(ex2.evalCandidates[0].alsoExampleCandidate, undefined);
});

test('filterEvalCopies: 예문 후보가 걸러지면 alsoExampleCandidate 표시를 다시 계산한다', () => {
  const ex = buildCorrectionsExport([pick(S3, 'cube')], graph, meta);
  assert.equal(ex.evalCandidates[0].alsoExampleCandidate, true);
  // 예문 후보가 그대로 남으면 표시도 남고, 예문 후보가 없어지면 표시도 빠진다
  const out = filterEvalCopies(ex, [], {});
  assert.equal(out.evalCandidates[0].alsoExampleCandidate, true);
  const out2 = filterEvalCopies({ ...ex, exampleCandidates: [] }, [], {});
  assert.equal(out2.evalCandidates[0].alsoExampleCandidate, undefined);
});

test('운영자 도구: 지금 tags.json의 공통 예문을 읽는다', async () => {
  const { commonExamplesFromDisk } = await import('../../tools/check-corrections.mjs');
  const { readFileSync } = await import('node:fs');
  const tf = JSON.parse(readFileSync(new URL('../../extension/data/common/tags.json', import.meta.url), 'utf8'));
  const all = commonExamplesFromDisk();
  assert.equal(all.length, tf.tags.flatMap(t => t.examples || []).length);
  assert.ok(all.includes(tf.tags[0].examples[0]));
});

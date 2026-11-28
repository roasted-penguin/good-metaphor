// 노드 파이프라인 T-197: check 태그 적합성(가짜 LLM)과 gate의 2위 대안 정답·비유 없음 침범 미루기
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildTagFitPrompt, parseTagFit, applyTagFit, BudgetError } from '../../tools/node-pipeline/tag-fit.mjs';
import { checkBatch, renderSheet, summarize, REASONS } from '../../tools/node-pipeline/check.mjs';
import { compareScores, gateCandidates, blocking, altRows, renderAltTable, altPendingRefusals } from '../../tools/node-pipeline/gate.mjs';
import { INTERESTS } from '../../tools/node-pipeline/sources.mjs';
import { loadInterestGraph } from '../../tools/load-graph.mjs';

const tagsFile = JSON.parse(readFileSync(new URL('../../extension/data/common/tags.json', import.meta.url), 'utf8'));
const TAG = id => tagsFile.tags.find(t => t.id === id);

/* ───── 태그 적합성 ───── */

test('buildTagFitPrompt: 사실만 근거, 태그마다 desc와 예문(다른 분야), JSON 꼴', () => {
  const node = { id: 'n', label: '주문서 강화', facts: ['주문서를 바르면 확률로 성공한다.', '실패하면 장비가 망가질 수 있다.'] };
  const { system, user } = buildTagFitPrompt({ node, tags: [TAG('prob_upgrade'), TAG('loss_risk')] });
  assert.match(system, /사실에 없는 내용을 보태지 않는다/);
  assert.match(system, /"verdict": "yes" 또는 "no"/);
  assert.match(user, /\[개념\] 주문서 강화/);
  assert.match(user, /- 실패하면 장비가 망가질 수 있다\./);
  assert.ok(user.includes(`prob_upgrade | ${TAG('prob_upgrade').label} — ${TAG('prob_upgrade').desc}`));
  assert.ok(user.includes(`  예: ${TAG('loss_risk').examples[0]}`), '예문을 기준 자료로');
});

test('parseTagFit: 물은 태그만, yes/no만, 코드 울타리 허용, 꼴이 틀리면 null', () => {
  const m = parseTagFit('```json\n{"tags":[{"id":"a","verdict":"yes","reason":"맞아요"},{"id":"b","verdict":"no","reason":"억지"},{"id":"z","verdict":"yes"},{"id":"c","verdict":"maybe"}]}\n```', ['a', 'b', 'c']);
  assert.deepEqual([...m.entries()], [['a', { verdict: 'yes', reason: '맞아요' }], ['b', { verdict: 'no', reason: '억지' }]]);
  assert.deepEqual([...parseTagFit('[{"id":"a","verdict":"no","reason":"r"}]', ['a']).keys()], ['a'], '배열만 낸 답도 받는다');
  assert.equal(parseTagFit('아무 말', ['a']), null);
  assert.equal(parseTagFit('{"tags":[{"id":"a | 이름","verdict":"yes","reason":"r"}]}', ['a']).get('a').verdict, 'yes', '"id | 이름" 꼴 id도 받는다(T-228)');
  assert.equal(parseTagFit('{"verdict":"yes"}', ['a']), null);
});

// 가짜 검사 결과(checkBatch 꼴)
const R = (id, tags, status = 'warn') => ({ status, fails: status === 'fail' ? ['number'] : [], warns: status === 'warn' ? ['aliasesReview'] : [], notes: [], node: { id, label: id, facts: ['가면 바뀐다.', '모으면 늘어난다.'], tags, sources: [] }, edges: [] });
// 가짜 LLM: 태그 줄에서 id를 읽어 표대로 답한다
const fakeLLM = (table, { calls = [] } = {}) => async (system, user) => {
  const id = user.match(/\[개념\] (\S+)/)[1];
  calls.push(id);
  const v = table[id];
  if (v instanceof Error) throw v;
  return JSON.stringify({ tags: Object.entries(v).map(([t, verdict]) => ({ id: t, verdict, reason: `${t} ${verdict}` })) });
};

test('applyTagFit: no 태그는 빼고(확인), 다 빠지면 실패, 실패 후보는 묻지 않음, 후보마다 한 번', async () => {
  const results = [
    R('keep', ['prob_upgrade', 'loss_risk']),
    R('drop1', ['prob_upgrade', 'random_reroll']),
    R('none', ['random_reroll']),
    R('failed', ['loss_risk'], 'fail'),
    R('clean', ['loss_risk'], 'pass')
  ];
  const calls = [];
  const complete = fakeLLM({ keep: { prob_upgrade: 'yes', loss_risk: 'yes' }, drop1: { prob_upgrade: 'yes', random_reroll: 'no' }, none: { random_reroll: 'no' }, clean: { loss_risk: 'yes' } }, { calls });
  const stat = await applyTagFit(results, { complete, tags: tagsFile.tags, model: 'fake' });
  assert.deepEqual(calls, ['keep', 'drop1', 'none', 'clean'], '실패 후보는 안 묻고, 태그가 여러 개여도 후보마다 한 번');
  assert.deepEqual(stat, { asked: 4, yes: 4, no: 2, failed: 1, pending: 0 });
  const [keep, drop1, none, failed, clean] = results;
  assert.deepEqual(keep.node.tags, ['prob_upgrade', 'loss_risk']);
  assert.equal(keep.status, 'warn');
  assert.deepEqual(drop1.node.tags, ['prob_upgrade']);
  assert.ok(drop1.warns.includes('tagFitDropped'));
  assert.deepEqual(drop1.tagFit.verdicts.map(v => [v.id, v.verdict]), [['prob_upgrade', 'yes'], ['random_reroll', 'no']]);
  assert.equal(none.status, 'fail');
  assert.ok(none.fails.includes('tagFitNone'));
  assert.equal(failed.tagFit, undefined);
  assert.equal(clean.status, 'pass', 'yes뿐이면 판정 그대로');
  assert.equal(clean.tagFit.model, 'fake');
});

test('applyTagFit: 호출 상한(BudgetError)·429면 나머지는 tagFitPending(태그 그대로), 답이 빠진 태그도 pending', async () => {
  let n = 0;
  const budget = async (s, u) => { if (n++ >= 1) throw new BudgetError(); return fakeLLM({ a: { loss_risk: 'yes' } })(s, u); };
  const results = [R('a', ['loss_risk']), R('b', ['loss_risk']), R('c', ['loss_risk'])];
  const stat = await applyTagFit(results, { complete: budget, tags: tagsFile.tags });
  assert.deepEqual([stat.asked, stat.pending], [1, 2]);
  assert.deepEqual(results.map(r => r.tagFit.status), ['done', 'pending', 'pending']);
  assert.deepEqual(results[2].node.tags, ['loss_risk']);
  assert.ok(results[2].warns.includes('tagFitPending'));
  assert.equal(results[2].tagFit.note, '호출 상한');

  const e429 = Object.assign(new Error('429'), { status: 429 });
  const calls = [];
  const rs = [R('x', ['loss_risk']), R('y', ['loss_risk'])];
  await applyTagFit(rs, { complete: fakeLLM({ x: e429 }, { calls }), tags: tagsFile.tags });
  assert.deepEqual(calls, ['x'], '429면 멈춤');
  assert.deepEqual(rs.map(r => r.tagFit.note), ['429', '429']);

  const part = [R('p', ['loss_risk', 'prob_upgrade'])];
  await applyTagFit(part, { complete: fakeLLM({ p: { loss_risk: 'no' } }), tags: tagsFile.tags });
  assert.deepEqual(part[0].node.tags, ['prob_upgrade'], '답이 없는 태그는 남긴다');
  assert.ok(part[0].warns.includes('tagFitPending') && part[0].warns.includes('tagFitDropped'));
});

test('checkBatch + applyTagFit + renderSheet: 실제 메이플 그래프로 검사 → 태그 적합성 → 시트·집계에 기록', async () => {
  const graph = loadInterestGraph('maplestory');
  const cand = { id: 'dye_revamp', label: '염색 개편', facts: ['염색약을 쓰면 머리 색이 바뀐다.', '원하는 색을 고르면 그 색으로 정해진다.'], tags: ['random_reroll', 'progression_gate'], sources: ['https://maplestory.nexon.com/News/Update/1'] };
  const results = await checkBatch([cand], { cfg: INTERESTS.maplestory, graph, tags: graph.tags });
  await applyTagFit(results, { complete: fakeLLM({ '염색': { random_reroll: 'no', progression_gate: 'no' } }), tags: graph.tags });
  assert.equal(results[0].status, 'fail');
  const sum = summarize(results);
  assert.ok(sum.reasons.some(([k]) => k === 'fail:tagFitNone'));
  const md = renderSheet({ interest: 'maplestory', batch: 9, results, pages: 1, generatedAt: 'T' });
  assert.ok(md.includes(REASONS.tagFitNone));
  assert.match(md, /- 태그 적합성 random_reroll: no\(뺌\) — random_reroll no/);
});

/* ───── gate: 2위 대안 정답(T-195 판정 (1)), 비유 없음 침범 미루기(판정 (2)) ───── */

const S = (kind, top1, extra = {}) => ({ kind, top1, top3: [top1, ...(extra.more || [])], hit1: extra.hit1, margin: extra.margin ?? null, rival: extra.rival ?? null });
const CASES = [
  { sentence: 'm1', expectNodes: ['A'], expectTag: 'loss_risk', guarded: false, sets: ['eval'] },
  { sentence: 'm2', expectNodes: ['B'], expectTag: 'periodic_cap', guarded: true, sets: ['eval'] },
  { sentence: 'm3', expectNodes: ['A'], expectTag: 'loss_risk', guarded: false, sets: ['holdout'] },
  { sentence: 'n1', expectNodes: [], forbidNodes: ['A'], guarded: false, sets: ['eval'] },
  { sentence: 'n2', expectNodes: [], guarded: false, sets: ['validation'] }
];
const BASE = new Map([
  ['m1', S('hit', 'A', { hit1: true, margin: 0.02, rival: 'B' })],
  ['m2', S('hit', 'B', { hit1: true, margin: 0.02, rival: 'A' })],
  ['m3', S('hit', 'A', { hit1: true, margin: 0.003, rival: 'B' })], // 원래 얇던 문장(바닥 0.003)
  ['n1', S('negative', 'B', { hit1: true })],
  ['n2', S('noMatch', 'A')]
]);
const TAGS = new Map([['N', ['loss_risk']], ['M', ['market_price']]]);

test('compareScores(T-197): 2위로 들어와 여유를 얇게 한 새 노드가 expectTag를 가지면 alt(via margin), 바닥보다 더 얇게 해도 같음', () => {
  const cur = new Map([...BASE,
    ['m1', S('hit', 'A', { hit1: true, margin: 0.001, rival: 'N', more: ['N'] })],  // 0.005 아래로 새로 → 같은 태그 N → 대안
    ['m2', S('hit', 'B', { hit1: true, margin: 0.002, rival: 'N' })],               // N에 periodic_cap 없음 → margin
    ['m3', S('hit', 'A', { hit1: true, margin: 0.001, rival: 'N' })]                // 바닥보다 더 얇게 → 같은 태그 → 대안
  ]);
  const issues = compareScores(BASE, cur, CASES, { candidateIds: ['N'], candidateTags: TAGS });
  assert.deepEqual(issues.map(i => [i.sentence, i.kind, i.culprit, i.via ?? null]), [['m1', 'alt', 'N', 'margin'], ['m2', 'margin', 'N', null], ['m3', 'alt', 'N', 'margin']]);
  assert.deepEqual([issues[0].before, issues[0].marginBefore, issues[0].marginAfter, issues[0].expectTag], ['A', 0.02, 0.001, 'loss_risk']);
  assert.deepEqual(blocking(issues).map(i => i.sentence), ['m2']);
  // 여유가 0.005 위에서 줄면 그대로 아무것도 아님
  const fine = new Map([...BASE, ['m1', S('hit', 'A', { hit1: true, margin: 0.01, rival: 'N' })]]);
  assert.deepEqual(compareScores(BASE, fine, CASES, { candidateIds: ['N'], candidateTags: TAGS }), []);
  // 기존 노드가 경쟁자면(후보 아님) 태그가 맞아도 margin(범인 없음)
  const old = new Map([...BASE, ['m1', S('hit', 'A', { hit1: true, margin: 0.001, rival: 'B' })]]);
  assert.deepEqual(compareScores(BASE, old, CASES, { candidateIds: ['N'], candidateTags: new Map([['B', ['loss_risk']]]) }).map(i => [i.kind, i.culprit]), [['margin', null]]);
});

test('blocking·gateCandidates(T-197): deferNoMatch면 비유 없음 침범은 막지 않고 deferred, 아니면(실제 관문) 그대로 회귀', async () => {
  const ev = raw => {
    const ids = new Set(raw.nodes.map(n => n.id));
    const m = new Map(BASE);
    if (ids.has('N')) m.set('m1', S('hit', 'A', { hit1: true, margin: 0.001, rival: 'N' }));
    if (ids.has('Q')) { m.set('n1', S('negative', 'Q', { hit1: true })); m.set('n2', S('noMatch', 'Q')); }
    if (ids.has('M')) m.set('m2', S('hit', 'B', { hit1: true, margin: 0.001, rival: 'M' }));
    return Promise.resolve(m);
  };
  const nodes = [{ id: 'N', tags: ['loss_risk'] }, { id: 'Q', tags: ['loss_risk'] }, { id: 'M', tags: ['market_price'] }];
  const RAW = { version: 'v', nodes: [{ id: 'A' }, { id: 'B' }], edges: [] };

  const fb = await gateCandidates({ rawGraph: RAW, nodes, evaluate: ev, cases: CASES, deferNoMatch: true });
  assert.deepEqual(fb.accepted, ['N', 'Q']);
  assert.deepEqual(fb.rejected.map(r => [r.id, r.issues[0].kind]), [['M', 'margin']], 'expectTag 없는 경쟁자가 여유를 깎으면 그대로 회귀');
  assert.deepEqual(fb.altPending, ['N']);
  assert.deepEqual(fb.alternatives.map(a => [a.sentence, a.via]), [['m1', 'margin']]);
  assert.deepEqual(fb.deferredIds, ['Q']);
  assert.deepEqual(fb.deferred.map(d => [d.sentence, d.kind]), [['n1', 'noMatch'], ['n2', 'noMatch']]);

  const br = await gateCandidates({ rawGraph: RAW, nodes, evaluate: ev, cases: CASES });
  assert.deepEqual(br.accepted, ['N']);
  assert.deepEqual(br.rejected.map(r => [r.id, r.issues[0].kind]), [['Q', 'noMatch'], ['M', 'margin']]);
  assert.deepEqual(br.deferred, []);
});

test('altRows·renderAltTable·altPendingRefusals(T-197): 2위 대안 정답 줄은 들어온 자리·여유 변화를 보이고, accept-alt 뒤에 풀림', () => {
  const alts = [{ sentence: 'm1', kind: 'alt', via: 'margin', before: 'A', after: 'A', marginBefore: 0.02, marginAfter: 0.001, culprit: 'N', guarded: false, expectTag: 'loss_risk' }];
  const rows = altRows(alts, { interest: 'maplestory', nodes: [{ id: 'N', label: '새 노드', facts: ['잃을 수 있다.'], tags: ['loss_risk'] }], cases: CASES, tags: tagsFile.tags });
  assert.deepEqual([rows[0].via, rows[0].marginBefore, rows[0].marginAfter, rows[0].oldTop1, rows[0].approve], ['margin', 0.02, 0.001, 'A', false]);
  const md = renderAltTable(rows, { interest: 'maplestory', batch: 'all', embedderId: 'fallback' });
  assert.match(md, /\| N 새 노드 \| 2위\(여유 0\.02→0\.001\) \| loss_risk \|/);
  assert.deepEqual([...altPendingRefusals({ alternatives: alts }, CASES).keys()], ['N']);
  assert.equal(altPendingRefusals({ alternatives: alts }, [{ sentence: 'm1', expectNodes: ['A', 'N'] }]).size, 0);
});

/* ───── 근접 중복·태그 밀도 (ADR 0015 제안 2·3) ───── */
import { applyNearDup, applyTagDensity, nearDupFloor, factKey, conceptText, TAG_DENSITY_MIN } from '../../tools/node-pipeline/near-dup.mjs';

// 가짜 임베더: 글 → 미리 정한 2차원 단위 벡터(각도로 거리 조절)
const unit = deg => [Math.cos(deg * Math.PI / 180), Math.sin(deg * Math.PI / 180)];
const fakeEmbed = angles => async texts => texts.map(t => unit(angles[t.split('.')[0]] ?? 90));
const N = (id, label, facts, tags = ['loss_risk']) => ({ id, label, facts, tags });

test('nearDupFloor·factKey·conceptText: 기존 노드끼리 가장 가까운 쌍, 공백·문장부호 무시, 이름. 사실', () => {
  const nodes = [N('a', 'A', []), N('b', 'B', []), N('c', 'C', [])];
  const f = nearDupFloor(nodes, [unit(0), unit(30), unit(80)]);
  assert.deepEqual([f.a, f.b, f.score], ['a', 'b', Math.round(Math.cos(Math.PI / 6) * 1000) / 1000]);
  assert.equal(factKey('보스를  잡으면, 보상이 생긴다.'), factKey('보스를 잡으면 보상이 생긴다'));
  assert.equal(conceptText(N('x', '큐브', ['돌린다.', '바뀐다.'])), '큐브. 돌린다. 바뀐다.');
});

test('applyNearDup: 바닥보다 가까우면 실패, 바닥 − 0.03 이상이면 확인, 같은 사실 재사용은 실패, 앞선 후보·앞 묶음과도 비교', async () => {
  const existing = [N('a', 'A', ['가 사실이다.']), N('b', 'B', ['나 사실이다.'])];   // 0°·40° → 바닥 cos40 ≈ 0.766
  const prior = [N('p', 'P', ['앞 묶음 사실이다.'])];                              // 200°
  const results = [
    R('dup', ['loss_risk']), R('close', ['loss_risk']), R('far', ['loss_risk']), R('twin', ['loss_risk']), R('reuse', ['loss_risk']), R('nearPrior', ['loss_risk']), R('failed', ['loss_risk'], 'fail')
  ];
  results.forEach(r => { r.node.label = r.node.id.toUpperCase(); r.node.facts = [`${r.node.id} 고유 사실이다.`]; });
  results[4].node.facts = ['가  사실이다', '새 사실이다.'];
  const angles = { A: 0, B: 40, P: 200, DUP: 20, CLOSE: 82, FAR: 140, TWIN: 141, REUSE: 300, NEARPRIOR: 205, FAILED: 1 };
  const stat = await applyNearDup(results, { existing, prior, embed: fakeEmbed(angles), embedderId: 'fake' });
  assert.equal(stat.floor.a + stat.floor.b, 'ab');
  const by = Object.fromEntries(results.map(r => [r.node.id, r]));
  assert.ok(by.dup.fails.includes('nearDup'), '기존 노드 A와 20°(cos 0.94) > 바닥 0.766');
  assert.equal(by.dup.nearDup.best.id, 'a');
  assert.ok(by.close.warns.includes('nearDupClose') && by.close.status !== 'fail', 'B와 42°(cos 0.743): 바닥 − 0.03 안');
  assert.equal(by.far.status, 'warn');
  assert.ok(by.twin.fails.includes('nearDup'), '앞선 후보 far와 1° → 같은 묶음 안 중복');
  assert.equal(by.twin.nearDup.best.id, 'far');
  assert.ok(by.reuse.fails.includes('factReused'));
  assert.deepEqual(by.reuse.nearDup.reusedFrom, ['a']);
  assert.ok(by.nearPrior.fails.includes('nearDup'), '앞 묶음 후보 P와 5°');
  assert.equal(by.failed.nearDup, undefined, '이미 실패한 후보는 건너뜀');
  assert.deepEqual([stat.failed, stat.reused, stat.close], [3, 1, 1]);
});

test('applyTagDensity: 상한 = max(ceil(10% × 노드 수), 5), 넘긴 후보만 경고(거르지 않음), 실패 후보는 안 셈', () => {
  const graphNodes = Array.from({ length: 20 }, (_, i) => N('g' + i, 'G', [], i < 5 ? ['loss_risk'] : ['market_price']));
  const results = [R('one', ['loss_risk']), R('two', ['prob_upgrade']), R('bad', ['loss_risk'], 'fail')];
  const d = applyTagDensity(results, { graphNodes });
  assert.equal(d.cap, TAG_DENSITY_MIN, '22개의 10%는 3 → 최소 5');
  assert.ok(results[0].warns.includes('tagDense') && results[0].status === 'warn');
  assert.match(results[0].notes.at(-1), /loss_risk 6\/5/);
  assert.equal(results[1].warns.includes('tagDense'), false);
  assert.deepEqual(d.counts.find(c => c[0] === 'loss_risk'), ['loss_risk', 5, 6]);
  assert.deepEqual(d.counts.find(c => c[0] === 'market_price'), ['market_price', 15, 15], '이미 넘은 태그는 표에 보이지만 새 후보가 없으면 경고 없음');
  const big = Array.from({ length: 100 }, (_, i) => N('h' + i, 'H', [], i < 10 ? ['loss_risk'] : ['market_price']));
  const rs = [R('x', ['loss_risk'])];
  assert.equal(applyTagDensity(rs, { graphNodes: big }).cap, 11, '101개의 10% → 11');
  assert.equal(rs[0].warns.includes('tagDense'), false, '11/11은 상한 안');
});

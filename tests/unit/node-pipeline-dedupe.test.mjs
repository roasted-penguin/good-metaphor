// T-205: 묶음 사이 id·이름 중복, 조문 꼴(법령) 후보의 "이름이 본문에 없음" 완화
import test from 'node:test';
import assert from 'node:assert/strict';
import { crossBatchGroups, resolveCrossBatch, describeGroups } from '../../tools/node-pipeline/dedupe.mjs';
import { labelNouns, nounIn, articleTitles, labelSignals, groundingSignals, draftCandidates } from '../../tools/node-pipeline/draft.mjs';
import { checkBatch, lawLabelGrounded, isArticleSource, summarize } from '../../tools/node-pipeline/check.mjs';
import { buildPatch } from '../../tools/node-pipeline/apply.mjs';
import { regroundLabels } from '../../tools/node-pipeline/run.mjs';
import { INTERESTS } from '../../tools/node-pipeline/sources.mjs';
import { HEADING_MARK } from '../../tools/node-pipeline/web.mjs';
import { loadInterestGraph } from '../../tools/load-graph.mjs';

const rest = INTERESTS.restaurant, maple = INTERESTS.maplestory;

/* ───── 묶음 사이 중복 ───── */

const res = (id, label, { status = 'warn', facts = 2, fails = [] } = {}) => ({
  status, fails: status === 'fail' && !fails.length ? ['number'] : fails, warns: status === 'warn' ? ['structure'] : [], notes: [],
  node: { id, label, facts: Array.from({ length: facts }, (_, i) => `사실 ${i}다.`), tags: ['loss_risk'], sources: ['https://www.law.go.kr/x'] }, edges: []
});

test('crossBatchGroups: 같은 id가 두 묶음에 — 판정 같고 사실 수 같으면 앞 묶음을 남긴다(T-198 franchise_dispute_mediation)', () => {
  const { groups } = crossBatchGroups([
    { batch: 5, results: [res('franchise_dispute_mediation', '가맹사업 분쟁조정협의회'), res('a_one', '하나')] },
    { batch: 8, results: [res('franchise_dispute_mediation', '가맹사업 분쟁조정'), res('b_one', '둘')] }
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].keep, { batch: 5, id: 'franchise_dispute_mediation', label: '가맹사업 분쟁조정협의회', status: 'warn' });
  assert.deepEqual(groups[0].drop.map(d => [d.batch, d.id, d.why]), [[8, 'franchise_dispute_mediation', 'sameId']]);
});

test('crossBatchGroups: 판정이 좋은 쪽 > 사실이 많은 쪽 > 앞 묶음', () => {
  const pick = (a, b) => crossBatchGroups([{ batch: 1, results: [a] }, { batch: 2, results: [b] }]).groups[0].keep.batch;
  assert.equal(pick(res('x_a', '가'), res('x_a', '가', { status: 'pass' })), 2, '통과가 확인보다 먼저');
  assert.equal(pick(res('x_a', '가', { status: 'fail' }), res('x_a', '가')), 2, '실패는 남기지 않는다(soul_amplification 꼴)');
  assert.equal(pick(res('x_a', '가'), res('x_a', '가', { facts: 3 })), 2, '사실 3개가 2개보다 먼저');
  assert.equal(pick(res('x_a', '가', { facts: 3 }), res('x_a', '가', { facts: 3 })), 1, '모두 같으면 앞 묶음');
});

test('crossBatchGroups: 같은 이름 다른 id(공백·가운뎃점 무시)도 잡고, 이름·id로 이어진 셋을 한 무리로', () => {
  const { groups } = crossBatchGroups([
    { batch: 1, results: [res('deposit_escrow', '가맹금 예치 제도')] },
    { batch: 2, results: [res('franchise_fee_escrow', '가맹금·예치제도')] },
    { batch: 3, results: [res('franchise_fee_escrow', '가맹금 맡김')] }
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].keep.id, 'deposit_escrow');
  assert.deepEqual(groups[0].drop.map(d => [d.batch, d.why]), [[2, 'sameLabel'], [3, 'linked']]);
  assert.match(describeGroups(groups)[0], /deposit_escrow\(묶음 1, warn\) 남김 ← 묶음 2 franchise_fee_escrow「가맹금·예치제도」\(같은 이름/);
});

test('crossBatchGroups: 한 묶음 안 중복은 check 몫이라 무리로 내지 않는다', () => {
  assert.equal(crossBatchGroups([{ batch: 1, results: [res('x_a', '가'), res('x_a', '나', { status: 'fail', fails: ['idDupBatch'] })] }]).groups.length, 0);
});

test('resolveCrossBatch: 진 쪽은 실패(dupCross)+이유, 원래 판정 기억, 다시 돌려도 같고, 중복이 사라지면 표시를 걷는다', () => {
  const input = [
    { batch: 5, results: [res('franchise_dispute_mediation', '가맹사업 분쟁조정협의회')] },
    { batch: 8, results: [res('franchise_dispute_mediation', '가맹사업 분쟁조정'), res('b_one', '둘')] }
  ];
  const before = JSON.stringify(input);
  const { batches } = resolveCrossBatch(input);
  assert.equal(JSON.stringify(input), before, '입력은 그대로');
  assert.equal(batches[0].results[0].status, 'warn');
  const lost = batches[1].results[0];
  assert.equal(lost.status, 'fail');
  assert.ok(lost.fails.includes('dupCross'));
  assert.deepEqual(lost.dupCross, { statusBefore: 'warn', keep: { batch: 5, id: 'franchise_dispute_mediation' }, why: 'sameId' });
  assert.match(lost.notes.at(-1), /묶음 사이 중복\(같은 id\): 묶음 5 franchise_dispute_mediation/);
  assert.equal(batches[1].results[1].status, 'warn', '다른 후보는 그대로');
  // 다시 돌려도(이미 표시된 결과) 같은 답
  const again = resolveCrossBatch(batches).batches;
  assert.deepEqual(again, batches);
  // 앞 묶음 후보가 빠지면(다시 check해 실패) 뒤 묶음 후보가 원래 판정으로 돌아온다
  const gone = resolveCrossBatch([{ batch: 5, results: [] }, batches[1]]).batches[1].results[0];
  assert.equal(gone.status, 'warn');
  assert.equal(gone.fails.includes('dupCross'), false);
  assert.equal(gone.dupCross, undefined);
  assert.equal(gone.notes.some(n => n.startsWith('묶음 사이 중복')), false);
});

test('resolveCrossBatch + buildPatch: --batch all로 합쳐도 같은 개념은 노드 하나, 진 쪽 id를 승인하면 거절', () => {
  const { batches } = resolveCrossBatch([
    { batch: 5, results: [res('franchise_dispute_mediation', '가맹사업 분쟁조정협의회')] },
    { batch: 8, results: [res('franchise_dispute_mediation', '가맹사업 분쟁조정'), res('mediation_board', '가맹사업 분쟁조정협의회')] }
  ]);
  const all = batches.flatMap(b => b.results);
  const patch = buildPatch(all, ['franchise_dispute_mediation', 'mediation_board'], { day: '2026-11-23' });
  assert.deepEqual(patch.nodes.map(n => n.label), ['가맹사업 분쟁조정협의회']);
  assert.deepEqual(patch.refused.map(r => r.id), ['mediation_board']);
  assert.match(patch.refused[0].reason, /dupCross/);
  assert.equal(summarize(all).reasons.find(([k]) => k === 'fail:dupCross')[1], 2);
});

/* ───── 조문 꼴 이름 근거 ───── */

// 합성 조문(실제 법령 문장을 옮기지 않은 짧은 꼴)
const ARTICLE_TEXT = [
  '■ 제7장 영업',
  '제40조(건강진단) ① 식품을 다루는 영업자와 그 종업원은 정해진 때에 건강진단을 받아야 한다. ② 진단 결과 다른 사람에게 옮길 수 있는 질병이 있으면 그 일에 종사하지 못한다.',
  '제41조(식품위생교육) ① 영업을 하려는 자는 미리 교육을 받아야 한다.',
  '제12조의2 (영업지역의 보호) 본부는 계약 기간 중 가맹점의 영업지역 안에 같은 업종의 직영점을 두지 못한다.'
].join('\n');

test('labelNouns·nounIn·articleTitles: 끝 조사 떼기(심의·부과는 그대로), 붙여 쓴 낱말 반쪽, 조 제목·조의N', () => {
  assert.deepEqual(labelNouns('건강진단과 종사 자격 제한'), ['건강진단', '종사', '자격', '제한']);
  assert.deepEqual(labelNouns('식당 알바비 정기 지급과 통화 지급 원칙'), ['식당', '알바비', '정기', '지급', '통화', '원칙']);
  assert.deepEqual(labelNouns('최저임금 심의 및 결정 일정'), ['최저임금', '심의', '결정', '일정']);
  assert.deepEqual(labelNouns('가산세 부과'), ['가산세', '부과']);
  assert.deepEqual(labelNouns('가맹사업 분쟁조정협의회'), ['가맹사업', '분쟁조정협의회']);
  const t = '계약갱신 요구권은 기간 안에 쓴다'.replace(/\s/g, '');
  assert.equal(nounIn('갱신요구권', t), true, '앞뒤 반쪽');
  assert.equal(nounIn('권리금', t), false);
  assert.equal(nounIn('갱신', '갱'), false);
  assert.deepEqual(articleTitles(ARTICLE_TEXT), [{ no: '제40조', title: '건강진단' }, { no: '제41조', title: '식품위생교육' }, { no: '제12조의2', title: '영업지역의 보호' }]);
});

test('labelSignals: 본문·제목(절 제목+조 제목)에 든 낱말 수, 가장 잘 맞는 조 번호 — 숫자와 조 번호만', () => {
  const s = labelSignals('건강진단과 종사 자격 제한', ARTICLE_TEXT, '제7장 영업');
  assert.deepEqual(s, { nouns: 4, inPage: 2, inTitles: 1, article: '제40조', articleHits: 1 });
  assert.deepEqual(labelSignals('영업지역 설정과 침해 금지', ARTICLE_TEXT, '제7장 영업'), { nouns: 4, inPage: 1, inTitles: 1, article: '제12조의2', articleHits: 1 });
  assert.deepEqual(labelSignals('식품위생교육 이수 의무', ARTICLE_TEXT), { nouns: 3, inPage: 1, inTitles: 1, article: '제41조', articleHits: 1 });
  const g = groundingSignals({ label: '질병과 종사', facts: ['진단 결과가 나쁘면 일을 못 한다.'] }, ARTICLE_TEXT, '제7장 영업');
  assert.equal(g.labelInPage, false);
  assert.deepEqual(g.labelNouns, { nouns: 2, inPage: 2, inTitles: 0, article: null, articleHits: 0 });
  assert.equal(JSON.stringify(g).includes('옮길 수 있는 질병'), false, 'D-5: 본문 글은 남기지 않는다');
});

test('draftCandidates: 새 초안은 grounding.labelNouns를 남긴다(절 제목 포함)', () => {
  const ans = JSON.stringify({ nodes: [{ id: 'health_check', label: '건강진단 의무', facts: ['영업자는 정해진 때 진단을 받아야 일할 수 있다.', '병이 있으면 그 일을 못 한다.'], tags: ['progression_gate'] }] });
  const { candidates } = draftCandidates(ans, { page: { url: 'https://www.law.go.kr/x', title: '법령', section: '제7장 영업' }, pageText: ARTICLE_TEXT });
  assert.deepEqual(candidates[0].grounding.labelNouns, { nouns: 2, inPage: 1, inTitles: 1, article: '제40조', articleHits: 1 });
});

test('lawLabelGrounded: 본문에 모두·제목+2/3·조 제목 절반 이상·제N조 인용이면 근거, 아니면 null', () => {
  assert.equal(lawLabelGrounded({ nouns: 3, inPage: 3, inTitles: 0, article: null, articleHits: 0 }), 'body');
  assert.equal(lawLabelGrounded({ nouns: 3, inPage: 2, inTitles: 1, article: null, articleHits: 0 }), 'titles');
  assert.equal(lawLabelGrounded({ nouns: 3, inPage: 2, inTitles: 0, article: null, articleHits: 0 }), null, '제목에 하나도 없으면 2/3로는 부족');
  assert.equal(lawLabelGrounded({ nouns: 4, inPage: 1, inTitles: 2, article: '제40조', articleHits: 2 }), 'article');
  assert.equal(lawLabelGrounded({ nouns: 4, inPage: 1, inTitles: 1, article: '제40조', articleHits: 1 }), null);
  assert.equal(lawLabelGrounded(null, { label: '제40조 건강진단' }), 'cites');
  assert.equal(lawLabelGrounded(undefined, { label: '건강진단' }), null, '신호 없는 예전 초안');
  assert.equal(lawLabelGrounded({ nouns: 0, inPage: 0, inTitles: 0, article: null, articleHits: 0 }), null);
});

// check 수준: 식당 법령 후보는 근거가 있으면 경고 없이 메모, 같은 신호라도 법령이 아닌 출처는 경고 그대로
const graphR = loadInterestGraph('restaurant');
const lawCand = (over = {}) => ({
  id: 'health_check_rule', label: '건강진단과 종사 제한', tags: ['progression_gate'], aliases: [], edges: [],
  facts: ['영업자와 종업원은 정해진 때 진단을 받아야 일을 계속할 수 있다.', '옮는 병이 있으면 그 일에서 빠져야 한다.'],
  sources: ['https://www.law.go.kr/%EB%B2%95%EB%A0%B9/%EC%8B%9D%ED%92%88%EC%9C%84%EC%83%9D%EB%B2%95'],
  grounding: { labelInPage: false, labelNouns: { nouns: 3, inPage: 3, inTitles: 1, article: '제40조', articleHits: 1 }, factOverlap: [0.8, 0.7], copiedRun: [6, 5] },
  ...over
});
const runR = cands => checkBatch(cands, { cfg: rest, graph: graphR, tags: graphR.tags, blockTerms: [] });

test('checkBatch(T-205): 법령 출처는 이름 핵심 낱말 근거가 있으면 labelNotInPage 없이 메모, 근거 없으면 경고', async () => {
  assert.equal(isArticleSource(lawCand().sources[0], rest), true);
  assert.equal(isArticleSource('https://www.ddm.go.kr/x', rest), false);
  assert.equal(isArticleSource(lawCand().sources[0], maple), false, '메이플은 조문 꼴 출처 없음');
  const [ok] = await runR([lawCand()]);
  assert.equal(ok.warns.includes('labelNotInPage'), false, JSON.stringify(ok.warns));
  assert.ok(ok.notes.some(n => /이름 근거\(조문\): 핵심 낱말이 모두 조문에 있음 · 제40조 \(낱말 3\/3\)/.test(n)), ok.notes.join(' / '));
  const [weak] = await runR([lawCand({ grounding: { ...lawCand().grounding, labelNouns: { nouns: 3, inPage: 1, inTitles: 0, article: null, articleHits: 0 } } })]);
  assert.ok(weak.warns.includes('labelNotInPage'), '낱말이 본문에 거의 없으면 경고 그대로');
  const [legacy] = await runR([lawCand({ grounding: { labelInPage: false, factOverlap: [0.8, 0.7], copiedRun: [6, 5] } })]);
  assert.ok(legacy.warns.includes('labelNotInPage'), '신호 없는 예전 초안은 경고 그대로');
  const [other] = await runR([lawCand({ id: 'local_rule', label: '보건소 건강진단 안내', sources: ['https://www.ddm.go.kr/health/contents.do?key=1'] })]);
  assert.ok(other.warns.includes('labelNotInPage'), '법령이 아닌 출처는 신호가 좋아도 경고');
});

test('regroundLabels: 신호 없는 법령 후보만 페이지를 다시 가져와 그 절에서 잰다(LLM 없음, 본문 저장 없음)', async () => {
  const shell = `<script>var lsVO = { lsiSeq : '285339' };\n var efYd = '20261008';</script>`;
  const body = `<p class="gtit">제7장 영업</p><p>${ARTICLE_TEXT.split('\n').slice(1).join('</p><p>')}</p><p class="gtit">제8장 조리사</p><p>제51조(조리사) 큰 급식소는 조리사를 둔다.</p>`;
  const url = 'https://www.law.go.kr/%EB%B2%95%EB%A0%B9/%EC%8B%9D%ED%92%88%EC%9C%84%EC%83%9D%EB%B2%95';
  const pages = { [url]: shell, 'https://www.law.go.kr/LSW/lsInfoR.do?lsiSeq=285339&efYd=20261008&chrClsCd=010202&ancYnChk=0': body };
  const seen = [];
  const fetcher = { get: async u => { seen.push(u); return pages[u] ? { ok: true, status: 200, url: u, html: pages[u] } : { ok: false, status: 404 }; } };
  const cfg = { ...rest, seeds: [{ kind: 'law', url, keep: /영업|조리사/, keepSub: /^제\d+절/, maxSections: 4 }] };
  const old = { ...lawCand(), section: '제7장 영업 · 제8장 조리사', grounding: { labelInPage: false, factOverlap: [0.8], copiedRun: [3] } };
  const fresh = lawCand({ id: 'fresh_one' });
  const other = { ...lawCand({ id: 'local_one' }), sources: ['https://www.ddm.go.kr/x'], grounding: { labelInPage: false } };
  const { candidates, regrounded, failed } = await regroundLabels({ cfg, candidates: [old, fresh, other], fetcher });
  assert.equal(regrounded, 1);
  assert.deepEqual(failed, []);
  assert.equal(seen.length, 2, '껍데기 + 본문 한 번씩');
  assert.equal(candidates[1], fresh, '신호 있는 후보는 그대로');
  assert.equal(candidates[2], other, '법령 아닌 출처는 그대로');
  assert.equal(candidates[0].grounding.regrounded, 'section', '작은 장 둘이 합쳐진 절을 제목으로 찾음');
  assert.deepEqual(candidates[0].grounding.labelNouns, { nouns: 3, inPage: 2, inTitles: 1, article: '제40조', articleHits: 1 });
  assert.equal(JSON.stringify(candidates).includes('옮길 수 있는 질병'), false, 'D-5');
  assert.equal(old.grounding.labelNouns, undefined, '입력은 그대로');
  assert.ok(HEADING_MARK);
});

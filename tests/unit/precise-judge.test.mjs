// T-184: 정밀 모드 추상화 호출에 태그 판정을 합친다. 프롬프트·JSON 파싱·"없음"·확률 하한·runAbstract 통합. 네트워크 없음
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAbstractJudgePrompt, buildAbstractPrompt, rewriteQueryText } from '../../extension/lib/prompt.js';
import { NONE_CHOICE, parseAbstractJudge, judgeTagProbs, tagChoices } from '../../extension/lib/judges.js';
import { runAbstract, runAnalogy } from '../../extension/lib/pipeline.js';
import { retrieve } from '../../extension/lib/retrieval.js';
import { REJECTED_TEXT } from '../../extension/lib/analogy-server.js';

const tagsFile = JSON.parse(readFileSync(new URL('../../extension/data/common/tags.json', import.meta.url)));
const admin = JSON.parse(readFileSync(new URL('../../extension/config/admin.json', import.meta.url)));
const TAGS = tagsFile.tags;
const two = [{ id: 'a', label: 'A', desc: 'a 설명' }, { id: 'b', label: 'B', desc: 'b 설명' }];

// --- 프롬프트 ---
test('buildAbstractJudgePrompt: tags.json의 태그 전부와 "없음"을 선택지로 넣는다(개수를 가정하지 않음, 규칙 9)', () => {
  const p = buildAbstractJudgePrompt({ sentence: '금리가 오르면 이자가 늘어난다.', choices: tagChoices(TAGS) });
  const all = p.system + p.user;
  for (const t of TAGS) assert.ok(all.includes(`- ${t.id}: ${t.label}`), t.id);
  assert.ok(all.includes(`- ${NONE_CHOICE.id}: ${NONE_CHOICE.label}`));
  // 다른 목록을 주면 그 목록만(하드코딩 없음)
  const q = buildAbstractJudgePrompt({ sentence: 's', choices: two });
  const qa = q.system + q.user;
  assert.ok(qa.includes('- a: A') && qa.includes('- b: B') && qa.includes(`- ${NONE_CHOICE.id}:`));
  assert.ok(!qa.includes(TAGS[0].id));
});

test('buildAbstractJudgePrompt: 추상화 규칙(T-122 전문용어)을 그대로 두고, abstract·tags JSON 하나만 요구한다', () => {
  const p = buildAbstractJudgePrompt({ sentence: '레버리지는 손익을 키운다', word: '레버리지', pageTitle: '투자', choices: two });
  const old = buildAbstractPrompt({ sentence: '레버리지는 손익을 키운다', word: '레버리지', pageTitle: '투자' });
  assert.match(p.system, /원문에 나온 전문용어·외래어/);
  assert.match(p.system, /"abstract"/);
  assert.match(p.system, /"tags"/);
  assert.match(p.system, /JSON/);
  // 원문 정보(페이지·문장·단어)는 기존 추상화와 같은 줄로 넣는다
  assert.ok(p.user.startsWith(old.user));
});

// --- 파싱 ---
const choices = [...two];
test('parseAbstractJudge: abstract와 tags를 읽고, 목록 밖 id는 버리고 높은 순으로 정규화한다', () => {
  const r = parseAbstractJudge('```json\n{"abstract":" 값이 오르면 덜 산다 ","tags":[{"id":"b","p":0.9},{"id":"zzz","p":1},{"id":"a","p":"20%"}]}\n```', choices);
  assert.equal(r.abstractText, '값이 오르면 덜 산다');
  assert.deepEqual(r.answers.map(x => x.id), ['b', 'a', NONE_CHOICE.id]);
  assert.deepEqual(r.answers.map(x => x.p), [0.9, 0.2, 0]);
});

test('parseAbstractJudge: {id: p} 객체 형식과 none도 받는다', () => {
  const r = parseAbstractJudge('{"abstract":"x","tags":{"a":0.3,"none":0.8}}', choices);
  assert.equal(r.answers[0].id, NONE_CHOICE.id);
  assert.equal(r.answers[0].p, 0.8);
});

test('parseAbstractJudge: JSON이 아니면 응답 전체를 추상 구조로, 판정은 null(호버를 막지 않는다)', () => {
  const r = parseAbstractJudge('  가격이 오르면 같은 돈으로 덜 산다  ', choices);
  assert.equal(r.abstractText, '가격이 오르면 같은 돈으로 덜 산다');
  assert.equal(r.answers, null);
});

test('parseAbstractJudge: tags가 없거나 abstract가 없으면 각각 null·빈 문자열', () => {
  assert.deepEqual(parseAbstractJudge('{"abstract":"구조"}', choices), { abstractText: '구조', answers: null });
  const r = parseAbstractJudge('{"tags":[{"id":"a","p":0.7}]}', choices);
  assert.equal(r.abstractText, '');
  assert.equal(r.answers[0].id, 'a');
  assert.deepEqual(parseAbstractJudge('', choices), { abstractText: '', answers: null });
});

// --- 없음·하한 ---
const ans = (...xs) => xs.map(([id, p]) => ({ id, p }));
test('judgeTagProbs: 하한 아래 태그는 버리고, none은 결과에 넣지 않는다', () => {
  assert.deepEqual(judgeTagProbs(ans(['a', 0.9], ['b', 0.5], ['none', 0.1]), { floor: 0.6 }), ans(['a', 0.9]));
  assert.deepEqual(judgeTagProbs(ans(['a', 0.9], ['b', 0.5], ['none', 0]), { floor: 0 }), ans(['a', 0.9], ['b', 0.5]));
  // 하한과 같은 값은 남긴다
  assert.deepEqual(judgeTagProbs(ans(['a', 0.7]), { floor: 0.7 }), ans(['a', 0.7]));
});

test('judgeTagProbs: none 확률이 가장 높은 태그 이상이면 판정 없음(빈 배열)', () => {
  assert.deepEqual(judgeTagProbs(ans(['none', 0.8], ['a', 0.7])), []);
  assert.deepEqual(judgeTagProbs(ans(['a', 0.7], ['none', 0.7])), []);
  assert.deepEqual(judgeTagProbs(ans(['a', 0.75], ['none', 0.7])), ans(['a', 0.75]));
  assert.equal(judgeTagProbs(null), null);
});

test('judgeTagProbs의 빈 결과를 retrieve에 넘기면 판정 없을 때와 같은 순위', () => {
  const g = { tags: two, nodes: [{ id: 'n1', label: 'N1', tags: ['a'], facts: [] }, { id: 'n2', label: 'N2', tags: ['b'], facts: [] }], edges: [] };
  const vecs = new Map([['tag:a', [1, 0]], ['tag:b', [0.9, 0.436]], ['node:n1', [1, 0]], ['node:n2', [1, 0]]]);
  const plain = retrieve([1, 0], g, vecs, { topK: 2 });
  const none = retrieve([1, 0], g, vecs, { topK: 2, tagJudge: { p: judgeTagProbs(ans(['none', 0.9], ['b', 0.9])), mode: 'combine', weight: 0.5 } });
  assert.deepEqual(none, plain);
  const withB = retrieve([1, 0], g, vecs, { topK: 2, tagJudge: { p: judgeTagProbs(ans(['b', 0.9], ['none', 0.1])), mode: 'combine', weight: 0.5 } });
  assert.equal(withB[0].id, 'n2');
});

// --- runAbstract 통합 ---
function fakeAsk(raw) {
  const calls = [];
  const ask = async (system, user, opts) => { calls.push({ system, user, opts }); return raw; };
  return { ask, calls };
}
const SENT = '명절 직전에는 사과 값이 두 배가 된다.';

test('runAbstract: tagJudge 없으면 예전처럼 글 응답 한 번(json false), judge null', async () => {
  const { ask, calls } = fakeAsk(' 구조 ');
  const r = await runAbstract({ sentence: SENT, ask });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.json, false);
  assert.equal(calls[0].system, buildAbstractPrompt({ sentence: SENT }).system);
  assert.equal(r.abstractText, '구조');
  assert.equal(r.judge, null);
});

test('runAbstract: tagJudge가 있으면 같은 한 번의 호출(json true)로 추상 구조와 태그 확률을 함께 받는다', async () => {
  const { ask, calls } = fakeAsk('{"abstract":"사려는 사람이 몰리면 값이 오른다","tags":[{"id":"market_price","p":0.95},{"id":"scarcity_value","p":0.4},{"id":"none","p":0.05}]}');
  const stages = [];
  const r = await runAbstract({ sentence: SENT, word: '', pageTitle: 'p', ask, onStage: s => stages.push(s), tagJudge: { tags: TAGS, floor: 0.5 } });
  assert.equal(calls.length, 1);
  assert.deepEqual(stages, ['abstract']);
  assert.equal(calls[0].opts.json, true);
  assert.equal(calls[0].system, buildAbstractJudgePrompt({ sentence: SENT, word: '', pageTitle: 'p', choices: tagChoices(TAGS) }).system);
  assert.equal(r.abstractText, '사려는 사람이 몰리면 값이 오른다');
  assert.equal(r.queryText, rewriteQueryText(r.abstractText, SENT));
  assert.deepEqual(r.judge.probs, [{ id: 'market_price', p: 0.95 }]);
  assert.equal(r.judge.answers[0].id, 'market_price');
});

test('runAbstract: 판정이 없는 응답(글만)이어도 추상 구조로 검색하고 judge.probs는 null', async () => {
  const { ask } = fakeAsk('가격이 오른다');
  const r = await runAbstract({ sentence: SENT, ask, tagJudge: { tags: TAGS } });
  assert.equal(r.abstractText, '가격이 오른다');
  assert.equal(r.judge.probs, null);
});

test('규칙 1 유지: 판정으로 고른 후보여도 생성 LLM이 후보 밖 nodeId를 대면 비유를 숨긴다', async () => {
  const { ask: ab } = fakeAsk('{"abstract":"x","tags":[{"id":"market_price","p":0.9}]}');
  const a = await runAbstract({ sentence: SENT, ask: ab, tagJudge: { tags: TAGS } });
  assert.ok(a.judge.probs.length);
  const candidates = [{ id: 'auction', label: '경매장', facts: ['찾는 사람이 많은 아이템은 가격이 오른다.'], source: 'common', tag: null, otherTags: [], neighbors: [] }];
  const { ask } = fakeAsk(JSON.stringify({ meaning: '값이 올라요.', analogy: '메이플로 치면 없는 노드예요.', nodeId: 'not-a-candidate', tagId: null, usedFact: '', mapping: '' }));
  const r = await runAnalogy({ sentence: SENT, graph: { domain: '메이플스토리', analogyPrefix: '메이플로 치면', tags: TAGS }, candidates, ask, providerKind: 'openai-compat', endingRetry: false });
  assert.equal(r.answer.analogy, '');
  assert.equal(r.rejected, REJECTED_TEXT);
});

// --- 배포 설정 ---
test('admin.json preciseTagJudge: 정밀 모드 전용 설정, 결합 방식 combine·가중치·하한이 숫자', () => {
  const c = admin.preciseTagJudge;
  assert.ok(c && typeof c.enabled === 'boolean');
  assert.equal(c.mode, 'combine');
  assert.equal(typeof c.weight, 'number');
  assert.ok(c.floor >= 0 && c.floor <= 1);
});

// 이어 묻기 에이전트 도구·프롬프트·최종 답 검사(T-216, ADR 0017 에이전트 1)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeFacts, nodesByTag, makeFollowupTools, buildFollowupPrompt, finalizeAnswer, runFollowup, cleanQuestion, FOLLOWUP_QUESTIONS, FOLLOWUP_TOOL_NAMES } from '../../extension/lib/agent-tools.js';
import { AGENT_STOP_TEXT, AGENT_CAP_TEXT } from '../../extension/lib/agent.js';
import { REJECTED_TEXT } from '../../extension/lib/analogy-server.js';
import { GROUNDING_REJECTED_TEXT } from '../../extension/lib/grounding.js';
import { BLOCKED_REJECTED_TEXT } from '../../extension/lib/blocklist.js';
import { mergeGraphs } from '../../extension/lib/graph.js';
import { loadInterestGraph } from '../../tools/load-graph.mjs';

const GRAPH = mergeGraphs(loadInterestGraph('maplestory'), null);
const SF = GRAPH.nodes.find(n => n.id === 'starforce');
const CUBE = GRAPH.nodes.find(n => n.id === 'cube');
// 금칙어는 테스트 코드 안에만(규칙 11)
const BLOCK = [{ term: '나쁜말', variants: [], status: '승인' }];
const PAYLOAD = { sentence: '확률형 강화는 실패하면 들인 비용만 날아간다.', word: '강화', context: '앞 문장이에요.', pageTitle: '제목' };
const PREV = { meaning: '실패하면 손해라는 뜻이에요.', analogy: '메이플로 치면 스타포스와 같아요.', evidence: { nodeId: 'starforce', nodeLabel: '스타포스 강화' } };

test('nodeFacts: 사실·태그(id·이름)·이웃, 없는 id는 null', () => {
  const f = nodeFacts(GRAPH, 'starforce');
  assert.equal(f.id, 'starforce');
  assert.equal(f.label, '스타포스 강화');
  assert.deepEqual(f.facts, SF.facts);
  assert.ok(f.tags.some(t => t.id === 'prob_upgrade' && t.label));
  assert.ok(Array.isArray(f.neighbors));
  assert.equal(nodeFacts(GRAPH, 'nope'), null);
});

test('nodesByTag: 그 태그를 가진 노드, 제외 반영, 상한', () => {
  const r = nodesByTag(GRAPH, 'prob_upgrade', ['starforce']);
  assert.ok(r.length >= 1);
  assert.ok(r.every(n => n.id !== 'starforce'));
  assert.ok(r.every(n => GRAPH.nodes.find(g => g.id === n.id).tags.includes('prob_upgrade')));
  assert.ok(nodesByTag(GRAPH, 'prob_upgrade', [], 1).length === 1);
  assert.deepEqual(nodesByTag(GRAPH, 'no_tag', []), []);
});

test('makeFollowupTools: 도구 셋, 본 노드는 seen에 쌓이고, search_graph는 주입 검색을 감싸 제외를 넘긴다', async () => {
  const seen = new Set();
  const asked = [];
  const searchGraph = async (text, exclude) => { asked.push({ text, exclude }); return [{ id: 'cube', label: CUBE.label, score: 0.5 }]; };
  const tools = makeFollowupTools({ graph: GRAPH, searchGraph, seen });
  assert.deepEqual(Object.keys(tools).sort(), [...FOLLOWUP_TOOL_NAMES].sort());

  const f = await tools.get_node_facts.run({ nodeId: 'starforce' });
  assert.equal(f.id, 'starforce');
  assert.ok(seen.has('starforce'));
  await assert.rejects(() => tools.get_node_facts.run({ nodeId: 'ghost' }), /없는 개념/);
  assert.ok(!seen.has('ghost'));

  const s = await tools.search_graph.run({ text: '다시 굴리기', exclude: ['starforce'] });
  assert.deepEqual(asked[0], { text: '다시 굴리기', exclude: ['starforce'] });
  assert.equal(s[0].id, 'cube');
  assert.deepEqual(s[0].facts, CUBE.facts, '검색 결과에 그래프 사실을 붙인다');
  assert.ok(seen.has('cube'));

  const t = await tools.search_by_tag.run({ tagId: 'prob_upgrade', exclude: ['starforce', 'cube'] });
  assert.ok(t.every(n => n.id !== 'starforce' && n.id !== 'cube'));
  for (const n of t) assert.ok(seen.has(n.id));
  await assert.rejects(() => tools.search_graph.run({ text: '' }), /text/);
});

test('buildFollowupPrompt: 호버와 같은 범위(제목·앞 문장·문장·단어)만, 질문·이전 결과·후보, 도구 이름, 규칙', () => {
  const { system, user } = buildFollowupPrompt({
    domain: '메이플스토리', ...PAYLOAD, question: '왜 비슷해요?', prev: PREV,
    candidates: [{ id: 'starforce', label: '스타포스 강화', tag: { id: 'prob_upgrade', label: '확률 강화' } }]
  });
  for (const name of FOLLOWUP_TOOL_NAMES) assert.match(system, new RegExp(name));
  assert.match(system, /"final"/);
  assert.match(system, /usedFact/);
  assert.match(system, /해요체/);
  assert.match(system, /멸칭/);
  assert.match(user, /설명할 문장: 확률형 강화는/);
  assert.match(user, /앞 문장: 앞 문장이에요/);
  assert.match(user, /커서가 가리킨 단어: 강화/);
  assert.match(user, /질문: 왜 비슷해요\?/);
  assert.match(user, /id=starforce/);
  assert.match(user, /prob_upgrade/);
  assert.ok(!/facts/.test(user), '후보 사실은 도구로 읽는다(프롬프트에 싣지 않음)');
});

test('finalizeAnswer: 허용 목록 안 노드 + 맞는 usedFact는 통과, 근거 정보', () => {
  const r = finalizeAnswer({ final: { answer: '스타포스처럼 실패하면 비용만 날아가요.', nodeId: 'starforce', usedFact: SF.facts[1] }, graph: GRAPH, allowed: new Set(['starforce']), ...PAYLOAD, blocklist: BLOCK });
  assert.equal(r.answer, '스타포스처럼 실패하면 비용만 날아가요.');
  assert.equal(r.rejected, null);
  assert.deepEqual(r.evidence, { nodeId: 'starforce', nodeLabel: '스타포스 강화', source: 'common', verifiedAt: SF.verifiedAt });
  assert.deepEqual(r.grounding, { ok: true });
});

test('finalizeAnswer 규칙 1: 허용 목록 밖(그래프에 있어도)·그래프에 없는 노드면 숨김', () => {
  const outside = finalizeAnswer({ final: { answer: '큐브와 같아요.', nodeId: 'cube', usedFact: CUBE.facts[0] }, graph: GRAPH, allowed: new Set(['starforce']), ...PAYLOAD, blocklist: [] });
  assert.equal(outside.answer, '');
  assert.equal(outside.rejected, REJECTED_TEXT);
  assert.equal(outside.evidence, null);
  const ghost = finalizeAnswer({ final: { answer: '유령과 같아요.', nodeId: 'ghost', usedFact: '' }, graph: GRAPH, allowed: new Set(['ghost']), ...PAYLOAD, blocklist: [] });
  assert.equal(ghost.rejected, REJECTED_TEXT);
});

test('finalizeAnswer 근거 검사: usedFact 불일치·지어낸 숫자면 숨김, 노드 없는 답도 숫자·usedFact 검사', () => {
  const fake = finalizeAnswer({ final: { answer: '스타포스는 하루 세 번만 돼요.', nodeId: 'starforce', usedFact: '스타포스는 하루 세 번만 할 수 있다.' }, graph: GRAPH, allowed: new Set(['starforce']), ...PAYLOAD, blocklist: [] });
  assert.equal(fake.answer, '');
  assert.equal(fake.rejected, GROUNDING_REJECTED_TEXT);
  assert.equal(fake.grounding.reason, 'fact-mismatch');
  const num = finalizeAnswer({ final: { answer: '스타포스는 7번 실패하면 끝나요.', nodeId: 'starforce', usedFact: '' }, graph: GRAPH, allowed: new Set(['starforce']), ...PAYLOAD, blocklist: [] });
  assert.equal(num.grounding.reason, 'number-outside');
  const noNode = finalizeAnswer({ final: { answer: '딱 맞는 다른 개념은 없어요.', nodeId: null, usedFact: '' }, graph: GRAPH, allowed: new Set(), ...PAYLOAD, blocklist: [] });
  assert.equal(noNode.answer, '딱 맞는 다른 개념은 없어요.');
  assert.equal(noNode.evidence, null);
  const noNodeFact = finalizeAnswer({ final: { answer: '보스는 하루 세 번이에요.', nodeId: null, usedFact: '보스는 하루 세 번이다.' }, graph: GRAPH, allowed: new Set(), ...PAYLOAD, blocklist: [] });
  assert.equal(noNodeFact.rejected, GROUNDING_REJECTED_TEXT, '노드 없이 사실을 대면 숨김');
});

test('finalizeAnswer 금칙어: 답에 섞이면 숨김, 금칙어 자체는 담지 않는다', () => {
  const r = finalizeAnswer({ final: { answer: '나 쁜 말 같은 구조예요.', nodeId: 'starforce', usedFact: SF.facts[0] }, graph: GRAPH, allowed: new Set(['starforce']), ...PAYLOAD, blocklist: BLOCK });
  assert.equal(r.answer, '');
  assert.equal(r.rejected, BLOCKED_REJECTED_TEXT);
  assert.deepEqual(r.blocked, { field: 'analogy', term: '(가림)' });
  assert.equal(r.evidence, null);
  assert.ok(!JSON.stringify(r).includes('나쁜말'));
});

test('finalizeAnswer: 답이 문자열이 아니거나 비면 형식 오류로 숨김', () => {
  const r = finalizeAnswer({ final: { answer: 3 }, graph: GRAPH, allowed: new Set(), ...PAYLOAD, blocklist: [] });
  assert.equal(r.answer, '');
  assert.ok(r.rejected);
});

test('cleanQuestion: 공백 접기, 2~200자, 칩 질문 문구', () => {
  assert.equal(cleanQuestion('  왜   비슷해요? '), '왜 비슷해요?');
  assert.equal(cleanQuestion('a'), null);
  assert.equal(cleanQuestion(''), null);
  assert.equal(cleanQuestion(null), null);
  assert.equal(cleanQuestion('가'.repeat(300)).length, 200);
  assert.equal(FOLLOWUP_QUESTIONS.why, '왜 비슷해요?');
  assert.equal(FOLLOWUP_QUESTIONS.other, '다른 비유는요?');
});

// runFollowup: 루프 + 도구 + 최종 답 검사를 묶은 에이전트 1
function scripted(answers) {
  const calls = [];
  const ask = async (system, user, opts) => {
    calls.push({ system, user, opts });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (a instanceof Error) throw a;
    return JSON.stringify(a);
  };
  return { ask, calls };
}
const BASE = { graph: GRAPH, payload: PAYLOAD, prev: PREV, candidateIds: ['starforce', 'cube', 'ghost'], blocklist: BLOCK, searchGraph: async () => [] };

test('runFollowup "왜 비슷해요?": get_node_facts → final, 근거 칩, trace', async () => {
  const { ask, calls } = scripted([
    { action: 'get_node_facts', args: { nodeId: 'starforce' } },
    { final: { answer: '둘 다 실패하면 들인 비용만 날아가요.', nodeId: 'starforce', usedFact: SF.facts[2] } }
  ]);
  const r = await runFollowup({ ...BASE, question: '왜 비슷해요?', ask });
  assert.equal(r.answer, '둘 다 실패하면 들인 비용만 날아가요.');
  assert.equal(r.evidence.nodeId, 'starforce');
  assert.equal(r.stopText, null);
  assert.equal(calls.length, 2);
  assert.equal(r.debug.calls, 2);
  assert.deepEqual(r.debug.trace.map(t => t.type), ['action', 'final']);
  assert.ok(calls[0].user.includes('id=cube'), '그래프에 있는 후보만 싣는다');
  assert.ok(!calls[0].user.includes('id=ghost'), '그래프에 없는 후보 id는 버린다');
});

test('runFollowup "다른 비유는요?": search_graph로 본 노드는 호버 후보 밖이어도 근거로 쓸 수 있다', async () => {
  const searchGraph = async () => [{ id: 'arcane_symbol', label: '아케인 심볼', score: 0.4 }];
  const sym = GRAPH.nodes.find(n => n.id === 'arcane_symbol');
  const { ask } = scripted([
    { action: 'search_graph', args: { text: PAYLOAD.sentence, exclude: ['starforce'] } },
    { final: { answer: '꾸준히 쌓아야 성장하는 점이 같아요.', nodeId: 'arcane_symbol', usedFact: sym.facts[2] } }
  ]);
  const r = await runFollowup({ ...BASE, candidateIds: ['starforce'], question: '다른 비유는요?', ask, searchGraph });
  assert.equal(r.evidence?.nodeId, 'arcane_symbol');
  assert.equal(r.rejected, null);
});

test('runFollowup 규칙 1: 보지 않은 노드를 대면 숨김', async () => {
  const { ask } = scripted([{ final: { answer: '레벨업과 같아요.', nodeId: 'level_exp', usedFact: '' } }]);
  const r = await runFollowup({ ...BASE, candidateIds: ['starforce'], question: '왜요?', ask });
  assert.equal(r.answer, '');
  assert.equal(r.rejected, REJECTED_TEXT);
});

test('runFollowup: 상한·반복·체인 소진이면 "여기까지 했어요" + 살펴본 개념, 하루 상한이면 안내 문구', async () => {
  const { ask } = scripted([{ action: 'get_node_facts', args: { nodeId: 'starforce' } }]);
  const rep = await runFollowup({ ...BASE, question: '왜요?', ask });
  assert.equal(rep.answer, '');
  assert.ok(rep.stopText.startsWith(AGENT_STOP_TEXT));
  assert.deepEqual(rep.found, ['스타포스 강화']);
  assert.equal(rep.debug.stop, 'repeat');

  const dead = scripted([new Error('모든 모델 429')]);
  const llm = await runFollowup({ ...BASE, question: '왜요?', ask: dead.ask });
  assert.ok(llm.stopText.startsWith(AGENT_STOP_TEXT));
  assert.equal(llm.debug.stop, 'llm-error');

  const none = scripted([{ final: { answer: '안 불림' } }]);
  const cap = await runFollowup({ ...BASE, question: '왜요?', ask: none.ask, budget: { take: async () => false } });
  assert.equal(cap.capped, true);
  assert.equal(cap.stopText, AGENT_CAP_TEXT);
  assert.equal(none.calls.length, 0);
});

test('말풍선 칩 문구(content.js FU_Q)가 FOLLOWUP_QUESTIONS와 같다', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../extension/content.js', import.meta.url), 'utf8');
  for (const [k, q] of Object.entries(FOLLOWUP_QUESTIONS)) assert.ok(src.includes(`${k}: '${q}'`), `${k}: '${q}'`);
});

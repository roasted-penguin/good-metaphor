// 이어 묻기 에이전트 도구·프롬프트·최종 답 검사(T-216, ADR 0017 에이전트 1)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeFacts, nodesByTag, makeFollowupTools, buildFollowupPrompt, finalizeAnswer, runFollowup, cleanQuestion, followupProblems, FOLLOWUP_QUESTIONS, FOLLOWUP_TOOL_NAMES, FOLLOWUP_MAX_CORRECTIONS, asksOther } from '../../extension/lib/agent-tools.js';
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
  assert.ok(!SF.facts.some(f => user.includes(f)), '후보 사실은 도구로 읽는다(프롬프트에 싣지 않음, T-224부터 순서 안내에 facts라는 낱말은 있다)');
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
  assert.deepEqual(r.debug.trace.map(t => t.type), ['action', 'final', 'verify']);
  assert.equal(r.debug.corrections, 0);
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

// ── T-222: 사실 읽기 강제·한 번 되묻기 ──
test('runFollowup: 사실을 읽지 않고 개념을 대면 그 facts를 실어 한 번 되묻고, 고친 답을 보인다(T-222)', async () => {
  const { ask, calls } = scripted([
    { final: { answer: '실패하면 손해예요.', nodeId: 'starforce', usedFact: '스타포스는 위험하다' } },
    { final: { answer: '실패하면 손해를 보는 점이 같아요.', nodeId: 'starforce', usedFact: SF.facts[2] } }
  ]);
  const r = await runFollowup({ ...BASE, question: '왜 비슷해요?', ask });
  assert.equal(r.answer, '실패하면 손해를 보는 점이 같아요.');
  assert.equal(r.evidence.nodeId, 'starforce');
  assert.equal(calls.length, 2);
  assert.ok(calls[1].user.includes('[검증 실패]'), '되묻기 문구');
  assert.ok(calls[1].user.includes(JSON.stringify(SF.facts)), 'facts를 글자 그대로 싣는다');
  assert.equal(r.debug.corrections, 1);
  const v = r.debug.trace.filter(t => t.type === 'verify');
  assert.deepEqual(v.map(t => t.ok), [false, true]);
  assert.match(v[0].reason, /unread/);
});

test('runFollowup: 되묻기는 한 번뿐, 또 틀리면 finalizeAnswer가 숨긴다(규칙 1·근거 검사 그대로)', async () => {
  assert.equal(FOLLOWUP_MAX_CORRECTIONS, 1);
  const bad = { final: { answer: '스타포스는 확률이 37%예요.', nodeId: 'starforce', usedFact: SF.facts[0] } };
  const { ask, calls } = scripted([bad, bad, bad]);
  const r = await runFollowup({ ...BASE, question: '왜요?', ask });
  assert.equal(calls.length, 2);
  assert.equal(r.answer, '');
  assert.equal(r.rejected, GROUNDING_REJECTED_TEXT);
  // 후보 밖 개념도 한 번 되묻고, 그대로면 규칙 1로 숨긴다
  const out = scripted([{ final: { answer: '레벨업과 같아요.', nodeId: 'level_exp', usedFact: '' } }]);
  const r1 = await runFollowup({ ...BASE, candidateIds: ['starforce'], question: '왜요?', ask: out.ask });
  assert.equal(out.calls.length, 2);
  assert.ok(out.calls[1].user.includes('level_exp'));
  assert.equal(r1.rejected, REJECTED_TEXT);
});

test('runFollowup: 도구로 facts를 읽은 개념이면 되묻지 않는다(검색 결과의 facts도 읽은 것)', async () => {
  const sym = GRAPH.nodes.find(n => n.id === 'arcane_symbol');
  const searchGraph = async () => [{ id: 'arcane_symbol', label: sym.label, score: 0.4 }];
  const { ask, calls } = scripted([
    { action: 'search_graph', args: { text: 'x', exclude: ['starforce'] } },
    { final: { answer: '꾸준히 쌓아야 성장하는 점이 같아요.', nodeId: 'arcane_symbol', usedFact: sym.facts[2] } }
  ]);
  const r = await runFollowup({ ...BASE, question: '다른 비유는요?', ask, searchGraph });
  assert.equal(calls.length, 2);
  assert.equal(r.debug.corrections, 0);
  assert.equal(r.evidence.nodeId, 'arcane_symbol');
});

test('runFollowup: 남은 차례가 없으면 되묻지 않고 그대로 판정한다', async () => {
  const { ask, calls } = scripted([{ final: { answer: '실패하면 손해예요.', nodeId: 'starforce', usedFact: SF.facts[2] } }]);
  const r = await runFollowup({ ...BASE, question: '왜요?', ask, maxCalls: 1 });
  assert.equal(calls.length, 1);
  assert.equal(r.answer, '실패하면 손해예요.', '사실이 맞으면 읽지 않았어도 보인다(근거 검사는 통과)');
  assert.equal(r.debug.corrections, 0);
});

test('followupProblems: 개념 없는 답의 usedFact·숫자, 끝맺음, 문제없으면 null', () => {
  const base = { graph: GRAPH, allowed: new Set(['starforce']), factsRead: new Set(['starforce']), ...PAYLOAD };
  assert.equal(followupProblems({ ...base, final: { answer: '맞는 개념이 없어요.', nodeId: null, usedFact: '' } }), null);
  assert.equal(followupProblems({ ...base, final: { answer: '같아요.', nodeId: 'starforce', usedFact: SF.facts[0] } }), null);
  assert.deepEqual(followupProblems({ ...base, final: { answer: '없어요.', nodeId: null, usedFact: SF.facts[0] } }).reasons, ['fact-without-node']);
  assert.deepEqual(followupProblems({ ...base, final: { answer: '세 번 하면 돼요.', nodeId: null, usedFact: '' } }).reasons, ['number-outside']);
  assert.deepEqual(followupProblems({ ...base, final: { answer: '같은 구조입니다.', nodeId: 'starforce', usedFact: SF.facts[0] } }).reasons, ['ending']);
  const nofact = followupProblems({ ...base, final: { answer: '같아요.', nodeId: 'starforce', usedFact: '' } });
  assert.deepEqual(nofact.reasons, ['no-fact']);
  assert.deepEqual(nofact.read, ['starforce']);
  assert.equal(followupProblems({ ...base, final: { answer: '' } }), null, '빈 답은 형식 문구로');
});

test('buildFollowupPrompt: 사실 읽기 먼저·글자 그대로·"없음" 기준과 예시(T-222)', () => {
  const { system } = buildFollowupPrompt({ domain: '메이플스토리', sentence: 's', question: 'q' });
  assert.match(system, /facts를 도구로 읽는다/);
  assert.match(system, /글자 그대로 복사/);
  assert.match(system, /없음인 예/);
  assert.match(system, /함수 호출 기능은 쓰지 않는다/);
});

test('말풍선 칩 문구(content.js FU_Q)가 FOLLOWUP_QUESTIONS와 같다', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../extension/content.js', import.meta.url), 'utf8');
  for (const [k, q] of Object.entries(FOLLOWUP_QUESTIONS)) assert.ok(src.includes(`${k}: '${q}'`), `${k}: '${q}'`);
});

// ── T-224: 되묻기 뒤 끝맺음은 호버(T-122)와 같이 보이고 표시만 ──
test('runFollowup: 되묻기 뒤에도 ~습니다로 끝나면 글을 고치지 않고 그대로 보이며 debug.ending에 표시한다(T-224, 호버와 같은 모양)', async () => {
  const formal = { final: { answer: '실패하면 손해를 보는 점이 같습니다.', nodeId: 'starforce', usedFact: SF.facts[2] } };
  const { ask, calls } = scripted([formal, formal]);
  const r = await runFollowup({ ...BASE, question: '왜 비슷해요?', ask });
  assert.equal(calls.length, 2, '끝맺음 문제로 한 번만 되묻는다');
  assert.ok(calls[1].user.includes('해요체'));
  assert.equal(r.answer, formal.final.answer, '뜻을 바꿀 수 있는 결정적 고치기는 하지 않는다');
  assert.equal(r.rejected, null);
  assert.deepEqual(r.debug.ending, { ok: false, retried: true, issues: [{ field: 'answer', style: 'formal' }] });
});

test('runFollowup debug.ending: 되묻기로 고쳐지면 ok, 문제없으면 retried=false, 다른 이유로 되물었으면 retried=false(T-224)', async () => {
  const fixed = scripted([
    { final: { answer: '같은 구조입니다.', nodeId: 'starforce', usedFact: SF.facts[2] } },
    { final: { answer: '같은 구조예요.', nodeId: 'starforce', usedFact: SF.facts[2] } }
  ]);
  const r1 = await runFollowup({ ...BASE, question: '왜요?', ask: fixed.ask });
  assert.equal(r1.answer, '같은 구조예요.');
  assert.deepEqual(r1.debug.ending, { ok: true, retried: true, issues: [] });

  const clean = scripted([
    { action: 'get_node_facts', args: { nodeId: 'starforce' } },
    { final: { answer: '같은 구조예요.', nodeId: 'starforce', usedFact: SF.facts[2] } }
  ]);
  const r2 = await runFollowup({ ...BASE, question: '왜요?', ask: clean.ask });
  assert.deepEqual(r2.debug.ending, { ok: true, retried: false, issues: [] });

  // 첫 답은 사실을 안 읽은 해요체, 고친 답이 합쇼체 → 끝맺음으로는 되묻지 않았으므로 retried=false, 그대로 보인다
  const other = scripted([
    { final: { answer: '같아요.', nodeId: 'starforce', usedFact: '없는 사실' } },
    { final: { answer: '같은 구조입니다.', nodeId: 'starforce', usedFact: SF.facts[2] } }
  ]);
  const r3 = await runFollowup({ ...BASE, question: '왜요?', ask: other.ask });
  assert.equal(r3.answer, '같은 구조입니다.');
  assert.deepEqual(r3.debug.ending, { ok: false, retried: false, issues: [{ field: 'answer', style: 'formal' }] });

  // 숨긴 답·멈춤에는 ending을 싣지 않는다
  const hidden = scripted([{ final: { answer: '레벨업입니다.', nodeId: 'level_exp', usedFact: '' } }]);
  const r4 = await runFollowup({ ...BASE, candidateIds: ['starforce'], question: '왜요?', ask: hidden.ask });
  assert.equal(r4.answer, '');
  assert.equal(r4.debug.ending, undefined);
});

// ── T-224: Groq가 스스로 facts를 읽게 하는 첫 차례 안내 ──
test('buildFollowupPrompt: 첫 차례는 facts 읽기 도구 호출이라는 안내와 실제 근거 id로 쓴 예시를 사용자 글 끝에 싣는다(T-224)', () => {
  const { user } = buildFollowupPrompt({ domain: '메이플스토리', sentence: 's', question: '왜 비슷해요?', prev: PREV, candidates: [{ id: 'cube', label: '큐브' }] });
  const tail = user.slice(user.lastIndexOf('질문:'));
  assert.match(tail, /\[순서\]/);
  assert.ok(tail.includes('{"action": "get_node_facts", "args": {"nodeId": "starforce"}}'), '방금 근거 개념 id로 예시');
  // 근거가 없으면 첫 후보 id, 후보도 없으면 search_graph 예시
  const c = buildFollowupPrompt({ domain: 'd', sentence: 's', question: 'q', candidates: [{ id: 'cube', label: '큐브' }] }).user;
  assert.ok(c.includes('"nodeId": "cube"'));
  const n = buildFollowupPrompt({ domain: 'd', sentence: 's', question: 'q' }).user;
  assert.ok(n.includes('"action": "search_graph"'));
  // "다른 비유"면 방금 근거를 읽게 하지 않고 exclude에 넣은 검색을 예시로
  for (const q of [FOLLOWUP_QUESTIONS.other, '다른 개념도 있어요?']) {
    const o = buildFollowupPrompt({ domain: 'd', sentence: 's', question: q, prev: PREV, candidates: [{ id: 'cube', label: '큐브' }] }).user;
    assert.ok(o.includes('"action": "search_graph", "args": {"text": "<문장의 핵심 구조>", "exclude": ["starforce"]}'), q);
    assert.ok(!o.includes('"get_node_facts", "args": {"nodeId": "starforce"}'), q);
  }
  assert.equal(asksOther('왜 비슷해요?'), false);
});

test('runFollowup "다른 비유는요?": 방금 근거 개념으로 다시 답하면 한 번 되묻는다(T-224)', async () => {
  const { ask, calls } = scripted([
    { action: 'get_node_facts', args: { nodeId: 'starforce' } },
    { final: { answer: '실패하면 손해를 보는 점이 같아요.', nodeId: 'starforce', usedFact: SF.facts[2] } },
    { final: { answer: '이 문장에는 맞는 다른 개념이 없어요.', nodeId: null, usedFact: '' } }
  ]);
  const r = await runFollowup({ ...BASE, question: '다른 비유는요?', ask });
  assert.equal(calls.length, 3);
  assert.match(r.debug.trace.find(t => t.type === 'verify' && !t.ok).reason, /same-as-prev/);
  assert.equal(r.evidence, null);
  // "왜 비슷해요?"는 같은 개념이 맞다
  const base = { graph: GRAPH, allowed: new Set(['starforce']), factsRead: new Set(['starforce']), ...PAYLOAD, prevNodeId: 'starforce' };
  const f = { answer: '같아요.', nodeId: 'starforce', usedFact: SF.facts[0] };
  assert.equal(followupProblems({ ...base, final: f, question: '왜 비슷해요?' }), null);
  assert.deepEqual(followupProblems({ ...base, final: f, question: '다른 비유는요?' }).reasons, ['same-as-prev']);
});

test('followupProblems: 개념 없이 비유를 대면 되묻기(T-231, fu10)', () => {
  const base = { graph: GRAPH, allowed: new Set(['starforce']), factsRead: new Set(), ...PAYLOAD };
  // fu10 실제 답: nodeId 없이 "메이플로 치면 … 같아요"
  const fu10 = '메이플로 치면 경매장에서 구하기 어려운 아이템은 찾는 사람이 많아 가격이 오르는 것과 같아요. 다른 비유로는 검색된 개념 중 맞는 것이 없어요.';
  assert.deepEqual(followupProblems({ ...base, final: { answer: fu10, nodeId: null, usedFact: '' } }).reasons, ['analogy-without-node']);
  // 개념 이름 + 닮음 말
  assert.deepEqual(followupProblems({ ...base, final: { answer: '스타포스 강화와 비슷해요.', nodeId: null, usedFact: '' } }).reasons, ['analogy-without-node']);
  // 없다고 하면서 개념을 대며 다르다고 하는 것은 괜찮다
  for (const answer of ['맞는 개념이 없어요. 스타포스 강화와는 구조가 달라요.', '메이플에는 비슷한 개념이 없어요. 쉽게 말하면 날짜 안내예요.', '스타포스 강화와 같지는 않아요.']) {
    assert.equal(followupProblems({ ...base, final: { answer, nodeId: null, usedFact: '' } }), null, answer);
  }
  // 개념을 댄 답은 이 검사와 상관없다
  assert.equal(followupProblems({ ...base, factsRead: new Set(['starforce']), final: { answer: '메이플로 치면 스타포스와 같아요.', nodeId: 'starforce', usedFact: SF.facts[0] } }), null);
});

test('followupProblems: 한글에 붙은 영어 낱말이면 되묻기, 원문·그래프에 있는 영어는 괜찮다(T-231)', () => {
  const base = { graph: GRAPH, allowed: new Set(['starforce']), factsRead: new Set(['starforce']), ...PAYLOAD };
  const f = answer => ({ answer, nodeId: 'starforce', usedFact: SF.facts[0] });
  assert.deepEqual(followupProblems({ ...base, final: f('강화가 harder해져요.') }).reasons, ['english']);
  assert.equal(followupProblems({ ...base, final: f('MVP처럼 HEXA를 올리는 것과 같아요.') }), null, '그래프에 있는 영어');
  assert.equal(followupProblems({ ...base, sentence: 'ETF는 여러 종목을 묶는다.', final: f('ETF는 스타포스와 같아요.') }), null, '원문에 있는 영어');
  assert.equal(followupProblems({ ...base, final: f('a/b 테스트처럼 같아요.') }), null, '한 글자 영어는 보지 않음');
});

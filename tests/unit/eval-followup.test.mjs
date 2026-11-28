// 이어 묻기 평가 도구·형식 스모크(T-218). 가짜 LLM으로 확장과 같은 runFollowup을 돌린다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  validateFollowupSet, makeSearchGraph, hoverToPrev, idsFromLabels, checkResponse, runFollowupCase, scoreRow,
  buildFollowupJudgePrompt, parseFollowupJudge, summarizeFollowup, summaryLines, followupLogRow, agentKey, judgeKey, withoutFamily, JUDGE_VERSION, withSample, readFactsFirst
} from '../../tools/eval-followup-lib.mjs';
import { AGENT_TASKS, fixedPrev, checkAgentTask, summarizeAgent, agentSummaryLine, agentRowLine } from '../../tools/smoke-agent.mjs';
import { REJECTED_TEXT } from '../../extension/lib/analogy-server.js';
import { FOLLOWUP_PROMPT_VERSION } from '../../extension/lib/agent-tools.js';
import { GROUNDING_REJECTED_TEXT } from '../../extension/lib/grounding.js';
import { mergeGraphs, embedItems } from '../../extension/lib/graph.js';
import { hashEmbed } from '../../extension/lib/fallback-embed.js';
import { loadInterestGraph } from '../../tools/load-graph.mjs';

const GRAPH = mergeGraphs(loadInterestGraph('maplestory'), null);
const ADMIN = JSON.parse(fs.readFileSync(new URL('../../extension/config/admin.json', import.meta.url)));
const VECS = new Map(embedItems(GRAPH, ADMIN.retrieval).map(it => [it.key, hashEmbed(it.text)]));
const searchGraph = makeSearchGraph({ graph: GRAPH, vecs: VECS, embedQuery: async t => hashEmbed(t), retrieval: ADMIN.retrieval });
const SF = GRAPH.nodes.find(n => n.id === 'starforce');
const SET = JSON.parse(fs.readFileSync(new URL('../../tools/eval-followup.json', import.meta.url)));
const PREV = { meaning: '뜻이에요.', analogy: '스타포스 같아요.', evidence: { nodeId: 'starforce', nodeLabel: SF.label } };
const ITEM = { id: 't1', sentence: '레버리지는 이익과 손실을 모두 키운다.', question: '왜 비슷해요?', kind: 'why', expect: 'node', expectNodes: ['starforce'] };

// 가짜 LLM: 차례마다 정해 둔 응답을 낸다. 함수면 user를 받아 응답을 만든다
const scripted = replies => {
  const asked = [];
  const ask = async (system, user, opts) => { asked.push({ system, user, opts }); const r = replies[asked.length - 1]; if (r instanceof Error) throw r; return typeof r === 'function' ? r(user) : r; };
  return { ask, asked };
};
const J = o => JSON.stringify(o);

test('측정셋: 20문항 안팎, id 겹침 없음, expect 값·노드 id가 그래프에 있음, 없음 기대 문항 포함', () => {
  const items = validateFollowupSet(SET, GRAPH);
  assert.ok(items.length >= 18 && items.length <= 24);
  assert.ok(items.some(i => i.expect === 'none'), '맞는 개념 없음 문항');
  assert.ok(items.some(i => i.kind === 'why') && items.some(i => i.kind === 'other') && items.some(i => i.kind === 'free'));
  assert.throws(() => validateFollowupSet({ items: [{ ...ITEM }, { ...ITEM }] }), /겹쳐/);
  assert.throws(() => validateFollowupSet({ items: [{ ...ITEM, expect: 'maybe' }] }), /expect/);
  assert.throws(() => validateFollowupSet({ items: [{ ...ITEM, expectNodes: ['ghost'] }] }, GRAPH), /ghost/);
});

test('makeSearchGraph: 뺄 개념만큼 topK를 늘리고 결과에서 뺀다', async () => {
  const all = await searchGraph('강화 실패 파괴', []);
  assert.equal(all.length, ADMIN.retrieval.topK ?? 3);
  const ex = await searchGraph('강화 실패 파괴', [all[0].id]);
  assert.equal(ex.length, all.length);
  assert.ok(!ex.some(c => c.id === all[0].id));
});

test('hoverToPrev·idsFromLabels: 호버 결과 → 방금 결과·후보 id, 이름 → id', () => {
  const r = hoverToPrev({ answer: { meaning: 'm', analogy: 'a', nodeId: 'starforce' }, evidence: { nodeId: 'starforce', nodeLabel: SF.label, source: 'common' } }, [{ id: 'starforce' }, { id: 'cube' }]);
  assert.deepEqual(r, { prev: { meaning: 'm', analogy: 'a', evidence: { nodeId: 'starforce', nodeLabel: SF.label } }, candidateIds: ['starforce', 'cube'] });
  assert.deepEqual(hoverToPrev({ answer: { meaning: 'm', analogy: '' }, evidence: null }, []).prev.evidence, null);
  assert.deepEqual(idsFromLabels(GRAPH, [SF.label]), ['starforce']);
});

test('checkResponse: JSON 액션 파싱·도구 이름·인자·최종 답 형식', () => {
  assert.deepEqual(checkResponse('그냥 글', GRAPH), { parsed: false, final: false, toolOk: null, argsOk: null });
  assert.equal(checkResponse(J({ action: 'get_node_facts', args: { nodeId: 'starforce' } }), GRAPH).argsOk, true);
  assert.equal(checkResponse(J({ action: 'get_node_facts', args: { nodeId: 'ghost' } }), GRAPH).argsOk, false);
  assert.equal(checkResponse(J({ action: 'search_graph', args: { text: '' } }), GRAPH).argsOk, false);
  assert.equal(checkResponse(J({ action: 'search_graph', args: { text: '강화', exclude: ['starforce'] } }), GRAPH).argsOk, true);
  assert.equal(checkResponse(J({ action: 'search_by_tag', args: { tagId: 'prob_upgrade' } }), GRAPH).argsOk, true);
  assert.equal(checkResponse(J({ action: 'search_by_tag', args: { tagId: 'nope' } }), GRAPH).argsOk, false);
  const bad = checkResponse(J({ action: 'make_analogy', args: {} }), GRAPH);
  assert.equal(bad.toolOk, false);
  assert.equal(checkResponse(J({ final: { answer: '없어요.', nodeId: null, usedFact: '' } }), GRAPH).finalOk, true);
  assert.equal(checkResponse(J({ final: { answer: '' } }), GRAPH).finalOk, false);
});

test('runFollowupCase: 확장과 같은 루프, 응답 원문 형식·걸러지기 전 최종 답·본 개념·호출 수를 남긴다', async () => {
  const fact = SF.facts[0];
  const { ask, asked } = scripted([
    'JSON 아님',
    J({ action: 'get_node_facts', args: { nodeId: 'starforce' } }),
    J({ final: { answer: `${SF.label}도 실패하면 손해를 봐요.`, nodeId: 'starforce', usedFact: fact } })
  ]);
  let t = 0;
  const row = await runFollowupCase({ item: ITEM, graph: GRAPH, prev: PREV, candidateIds: ['starforce'], ask, searchGraph, now: () => (t += 10) });
  assert.equal(asked.length, 3);
  assert.equal(row.calls, 3);
  assert.equal(row.steps, 2);
  assert.equal(row.stop, null);
  assert.equal(row.answer, `${SF.label}도 실패하면 손해를 봐요.`);
  assert.equal(row.evidence.nodeId, 'starforce');
  assert.deepEqual(row.rawFinal.nodeId, 'starforce');
  assert.deepEqual(row.foundIds, ['starforce']);
  assert.deepEqual(row.responses.map(r => r.parsed), [false, true, true]);
  assert.ok(row.ms > 0);
  const s = scoreRow(row, ITEM);
  assert.equal(s.expectOk, true);
  assert.equal(s.hit, true);
  assert.equal(s.haeyoCode, true);
});

test('runFollowupCase·scoreRow: 후보 밖 개념은 규칙 1로 숨김, 지어낸 숫자는 근거 검사로 숨김, 둘 다 원문 최종 답은 남는다', async () => {
  const outside = GRAPH.nodes.find(n => n.id === 'level_exp');
  const r1 = await runFollowupCase({ item: ITEM, graph: GRAPH, prev: PREV, candidateIds: ['starforce'], searchGraph,
    ask: scripted(Array(2).fill(J({ final: { answer: '레벨 같아요.', nodeId: outside.id, usedFact: outside.facts[0] } }))).ask }); // 한 번 되묻고(T-222) 같은 답
  assert.equal(r1.rejected, REJECTED_TEXT);
  assert.equal(r1.rawFinal.nodeId, outside.id);
  const s1 = scoreRow(r1, ITEM);
  assert.equal(s1.hidden, 'rule1');
  assert.equal(s1.rule1, true);
  assert.equal(s1.expectOk, false);

  const r2 = await runFollowupCase({ item: ITEM, graph: GRAPH, prev: PREV, candidateIds: ['starforce'], searchGraph,
    ask: scripted(Array(2).fill(J({ final: { answer: '스타포스는 확률이 37%예요.', nodeId: 'starforce', usedFact: SF.facts[0] } }))).ask });
  assert.equal(r2.rejected, GROUNDING_REJECTED_TEXT);
  assert.equal(scoreRow(r2, ITEM).hidden, 'grounding');
});

test('scoreRow: 없음 기대는 nodeId 없는 최종 답, 다른 비유는 방금 근거와 다른 개념, 멈춤은 기대 못 지킴', async () => {
  const none = { ...ITEM, expect: 'none', expectNodes: undefined };
  const r = await runFollowupCase({ item: none, graph: GRAPH, prev: PREV, candidateIds: ['starforce'], searchGraph,
    ask: scripted([J({ final: { answer: '딱 맞는 개념은 없어요.', nodeId: null, usedFact: '' } })]).ask });
  assert.equal(scoreRow(r, none).expectOk, true);
  assert.equal(scoreRow(r, ITEM).expectOk, false, '개념 기대인데 없다고 답함');

  const other = { ...ITEM, expect: 'any', notPrev: true, expectNodes: undefined };
  const same = await runFollowupCase({ item: other, graph: GRAPH, prev: PREV, candidateIds: ['starforce'], searchGraph,
    ask: scripted(Array(2).fill(J({ final: { answer: `${SF.label}예요.`, nodeId: 'starforce', usedFact: SF.facts[0] } }))).ask });
  const ss = scoreRow(same, other);
  assert.equal(ss.notPrevOk, false);
  assert.equal(ss.expectOk, false);

  const stopped = await runFollowupCase({ item: ITEM, graph: GRAPH, prev: PREV, candidateIds: ['starforce'], searchGraph,
    ask: scripted(['x', 'y']).ask });
  assert.equal(stopped.stop, 'format');
  assert.equal(stopped.rawFinal, null);
  const st = scoreRow(stopped, ITEM);
  assert.equal(st.final, false);
  assert.equal(st.expectOk, false);
  assert.equal(st.hidden, null);
});

test('채점 프롬프트·응답 해석: 볼 수 있던 개념(후보 ∪ 도구로 본 것)의 사실만 싣고, 형식 밖은 null', () => {
  const row = { sentence: '문장이에요', question: '왜 비슷해요?', prev: PREV, candidateIds: ['starforce'], foundIds: ['cube'], rawFinal: { answer: '답이에요.', nodeId: 'starforce', usedFact: SF.facts[0] } };
  const p = buildFollowupJudgePrompt(row, GRAPH);
  assert.match(p.user, /문장이에요/);
  assert.match(p.user, /왜 비슷해요/);
  assert.ok(p.user.includes(SF.facts[0]));
  assert.ok(p.user.includes(GRAPH.nodes.find(n => n.id === 'cube').facts[0]));
  assert.ok(!p.user.includes(GRAPH.nodes.find(n => n.id === 'level_exp').facts[0]));
  for (const k of ['grounded', 'forced', 'helpful', 'haeyo', 'reason']) assert.match(p.system, new RegExp(k));
  assert.match(p.system, /날짜·장소 안내/, '억지 비유 기준(T-222)');
  assert.deepEqual(parseFollowupJudge('{"grounded": true, "helpful": 4, "haeyo": false, "reason": "r"}'), { grounded: true, forced: null, helpful: 4, haeyo: false, reason: 'r' }, 'forced 없는 예전 응답');
  assert.equal(parseFollowupJudge('{"grounded": true, "forced": true, "helpful": 1, "haeyo": true}').forced, true);
  assert.equal(parseFollowupJudge('{"grounded": true, "helpful": 9, "haeyo": true}'), null);
  assert.equal(parseFollowupJudge('{"grounded": "yes", "helpful": 3, "haeyo": true}'), null);
  assert.equal(parseFollowupJudge('채점 못 함'), null);
});

test('summarizeFollowup·summaryLines·followupLogRow: 숨김·멈춤·기대·채점·형식·호출·지연 집계', () => {
  const base = { responses: [{ parsed: true, final: false, toolOk: true, argsOk: true }, { parsed: true, final: true }], calls: 2, steps: 2, ms: 1000 };
  const rows = [
    { ...base, id: 'a', expect: 'node', score: { final: true, shown: true, hidden: null, expectOk: true, hit: true, notPrevOk: null, haeyoCode: true }, judge: { grounded: true, forced: true, helpful: 5, haeyo: true }, rawFinal: { answer: 'x' } },
    { ...base, id: 'b', expect: 'none', score: { final: true, shown: false, hidden: 'rule1', rule1: true, expectOk: false, hit: null, notPrevOk: null, haeyoCode: null }, judge: { grounded: false, helpful: 1, haeyo: false, reason: '지어냄' }, rawFinal: { answer: 'y' } },
    { id: 'c', expect: 'any', stop: 'format', calls: 2, steps: 0, ms: 3000, responses: [{ parsed: false }, { parsed: false }], score: { final: false, shown: false, hidden: null, expectOk: false, hit: null, notPrevOk: null, haeyoCode: null } },
    { id: 'd', expect: 'any', error: '호버 실패', score: {} }
  ];
  const s = summarizeFollowup(rows);
  assert.equal(s.n, 4);
  assert.equal(s.errors, 1);
  assert.equal(s.finals, 2);
  assert.equal(s.shown, 1);
  assert.equal(s.hiddenRule1, 1);
  assert.deepEqual(s.stops, { format: 1 });
  assert.deepEqual(s.expect.node, { ok: 1, n: 1 });
  assert.deepEqual(s.expect.none, { ok: 0, n: 1 });
  assert.equal(s.groundedRate, 0.5);
  assert.equal(s.helpfulAvg, 3);
  assert.deepEqual(s.format, { responses: 6, parsed: 4, actions: 2, toolOk: 2, argsOk: 2 });
  assert.equal(s.callsMax, 2);
  assert.equal(s.msMedian, 1000);
  assert.equal(s.violations.length, 1);
  assert.deepEqual(s.forced, { yes: 1, n: 1 }, 'forced를 준 채점만 센다');
  assert.equal(s.forcedShown, 1);
  const lines = summaryLines(s).join('\n');
  assert.match(lines, /근거 준수 50%/);
  assert.match(lines, /멈춤 format 1/);
  assert.match(lines, /억지 비유 1\/1\(보인 답 1\)/);
  const row = followupLogRow(s, { date: '2026-11-28', gen: ['gemini/x'], judge: 'nvidia/y', embedder: 'e5' });
  assert.match(row, /^\| 2026-11-28 \| e5 \| 이어 묻기 4 \|/);
  assert.match(row, /T-218/);
});

test('캐시 키·채점 계열: 문항·질문이 바뀌면 키가 바뀌고, 채점 제공자는 생성 체인에서 빠진다', () => {
  assert.notEqual(agentKey('g', 'e', ITEM), agentKey('g', 'e', { ...ITEM, question: '다른 비유는요?' }));
  assert.notEqual(judgeKey('j', { id: 'a', rawFinal: { answer: '1' } }), judgeKey('j', { id: 'a', rawFinal: { answer: '2' } }));
  assert.ok(agentKey('g', 'e', ITEM).includes(FOLLOWUP_PROMPT_VERSION), '프롬프트 판이 바뀌면 이어 묻기 캐시를 다시(T-222)');
  assert.ok(judgeKey('j', { id: 'a', rawFinal: {} }).includes(JUDGE_VERSION), '채점 기준 판이 바뀌면 다시 채점');
  const chain = [{ id: 'groq', model: 'a' }, { id: 'nvidia', model: 'b' }, { id: 'gemini', model: 'c' }];
  assert.deepEqual(withoutFamily(chain, { id: 'nvidia', model: 'other' }).map(p => p.id), ['groq', 'gemini']);
});

test('smoke --agent: 고정 과제 3~5개, 고정 prev, 형식·도구·최종 답·단계 집계, 호출 실패는 따로', async () => {
  assert.ok(AGENT_TASKS.length >= 3 && AGENT_TASKS.length <= 5);
  for (const t of AGENT_TASKS) if (t.prevNodeId) assert.ok(GRAPH.nodes.some(n => n.id === t.prevNodeId), t.prevNodeId);
  const why = AGENT_TASKS.find(t => t.id === 'why');
  const prev = fixedPrev(GRAPH, why);
  assert.equal(prev.evidence.nodeId, why.prevNodeId);
  assert.equal(fixedPrev(GRAPH, { prevNodeId: null }).evidence, null);

  const node = GRAPH.nodes.find(n => n.id === why.prevNodeId);
  const good = await checkAgentTask(scripted([
    J({ action: 'get_node_facts', args: { nodeId: node.id } }),
    J({ final: { answer: `${node.label}도 기다려야 해요.`, nodeId: node.id, usedFact: node.facts[0] } })
  ]).ask, why, { graph: GRAPH, searchGraph });
  assert.equal(good.ok, true);
  assert.deepEqual([good.responses, good.parsed, good.actions, good.toolOk, good.argsOk], [2, 2, 1, 1, 1]);
  assert.equal(good.final, true);
  assert.equal(good.finalOk, true);
  assert.equal(good.shown, true);
  assert.equal(good.steps, 2);

  const badTool = await checkAgentTask(scripted([J({ action: 'read_page', args: {} }), J({ final: { answer: '없어요.', nodeId: null, usedFact: '' } })]).ask, why, { graph: GRAPH, searchGraph });
  assert.equal(badTool.toolOk, 0);
  assert.equal(badTool.final, true);

  const err = await checkAgentTask(scripted([Object.assign(new Error('429 한도'), { status: 429 })]).ask, why, { graph: GRAPH, searchGraph });
  assert.equal(err.ok, false);
  assert.match(err.error, /429/);

  const s = summarizeAgent([good, badTool, err]);
  assert.equal(s.errors, 1);
  assert.equal(s.toolOk, 1);
  assert.equal(s.actions, 2);
  assert.equal(s.finals, 2);
  assert.match(agentSummaryLine('gemini/x', s), /도구 이름 1\/2/);
  assert.match(agentRowLine(err), /호출 실패/);
  assert.match(agentRowLine(good), /최종 답 ○/);
});

test('withSample·agentRowLine: 형식이 틀린 응답만 원문 앞부분(240자, 공백 접기)을 남기고 스모크 줄 아래 보인다(T-222)', () => {
  assert.equal(withSample({ parsed: true, final: true }, 'x').sample, undefined);
  assert.equal(withSample({ parsed: false }, '').sample, '');
  assert.equal(withSample({ parsed: true, toolOk: false, argsOk: false }, 'a\n  b').sample, 'a b');
  assert.equal(withSample({ parsed: false }, '가'.repeat(500)).sample.length, 240);
  const line = agentRowLine({ id: 'why', ok: true, responses: 2, parsed: 1, actions: 0, toolOk: 0, argsOk: 0, final: false, stop: 'format', steps: 0, calls: 2, ms: 5, shown: false, note: '멈춤', samples: ['', '{"x":1}'] });
  assert.match(line, /↳ 원문: \(빈 응답\)/);
  assert.match(line, /↳ 원문: \{"x":1\}/);
});

test('readFactsFirst·스스로 읽음: 첫 final 전에 맞는 도구를 불렀는지, 평가 요약·스모크 줄에 보인다(T-224)', async () => {
  const tool = { parsed: true, final: false, toolOk: true, argsOk: true };
  const fin = { parsed: true, final: true, finalOk: true };
  assert.equal(readFactsFirst([tool, fin]), true);
  assert.equal(readFactsFirst([fin, fin]), false, '되묻기 뒤 답만 있으면 스스로 읽은 것이 아니다');
  assert.equal(readFactsFirst([{ parsed: true, final: false, toolOk: false }, fin]), false);
  assert.equal(readFactsFirst([fin, tool]), false, 'final 뒤 도구는 세지 않는다');
  assert.equal(readFactsFirst([]), false);

  const s = summarizeFollowup([
    { id: 'a', expect: 'node', responses: [tool, fin], calls: 2, steps: 2, ms: 1, score: { final: true, shown: true } },
    { id: 'b', expect: 'node', responses: [fin, fin], calls: 2, steps: 2, ms: 1, score: { final: true, shown: true } },
    { id: 'c', expect: 'any', error: 'x', score: {} }
  ]);
  assert.deepEqual(s.selfRead, { ok: 1, n: 2 });
  assert.match(summaryLines(s).join('\n'), /스스로 facts 읽음 1\/2/);

  const why = AGENT_TASKS.find(t => t.id === 'why');
  const node = GRAPH.nodes.find(n => n.id === why.prevNodeId);
  const self = await checkAgentTask(scripted([
    J({ action: 'get_node_facts', args: { nodeId: node.id } }),
    J({ final: { answer: `${node.label}도 기다려야 해요.`, nodeId: node.id, usedFact: node.facts[0] } })
  ]).ask, why, { graph: GRAPH, searchGraph });
  const lazy = await checkAgentTask(scripted([
    J({ final: { answer: '같아요.', nodeId: node.id, usedFact: '없는 사실' } }),
    J({ final: { answer: `${node.label}도 기다려야 해요.`, nodeId: node.id, usedFact: node.facts[0] } })
  ]).ask, why, { graph: GRAPH, searchGraph });
  assert.equal(self.selfRead, true);
  assert.equal(lazy.selfRead, false);
  const none = AGENT_TASKS.find(t => !t.expectTool);
  const nr = await checkAgentTask(scripted([J({ final: { answer: '맞는 개념이 없어요.', nodeId: null, usedFact: '' } })]).ask, none, { graph: GRAPH, searchGraph });
  const sa = summarizeAgent([self, lazy, nr]);
  assert.deepEqual(sa.selfRead, { ok: 1, n: 2 }, '도구가 필요한 과제(expectTool)만 센다');
  assert.match(agentSummaryLine('groq/x', sa), /스스로 facts 읽음 1\/2/);
});

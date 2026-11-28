// 👎 교정 진단 에이전트(T-220, ADR 0017 에이전트 3): 원인 진단, 검증기(규칙 1·근거·금칙어·끝맺음), 상한, 쓰기 제안
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DIAGNOSE_CAUSES, DIAGNOSE_UNKNOWN_TEXT, DIAGNOSE_BUTTON_TEXT, DIAGNOSE_CAP_TEXT, DIAGNOSE_MAX_STEPS, DIAGNOSE_MAX_CALLS, DIAGNOSE_MAX_VERIFIES,
  parseDiagnosis, diagnoseHints, buildDiagnosePrompt, verifyDiagnosis, runDiagnose, diagnoseAction
} from '../../extension/lib/agent-diagnose.js';
import { AGENT_STOP_TEXT } from '../../extension/lib/agent.js';
import { FOLLOWUP_TOOL_NAMES } from '../../extension/lib/agent-tools.js';
import { REJECTED_TEXT } from '../../extension/lib/analogy-server.js';
import { GROUNDING_REJECTED_TEXT } from '../../extension/lib/grounding.js';
import { BLOCKED_REJECTED_TEXT } from '../../extension/lib/blocklist.js';
import { mergeGraphs } from '../../extension/lib/graph.js';
import { loadInterestGraph } from '../../tools/load-graph.mjs';

const COMMON = loadInterestGraph('maplestory');
const GRAPH = mergeGraphs(COMMON, null);
const node = id => GRAPH.nodes.find(n => n.id === id);
const SF = node('starforce');
const CUBE = node('cube');
const BLOCK = [{ term: '나쁜말', variants: [], status: '승인' }]; // 금칙어는 테스트 코드 안에만(규칙 11)
const PAYLOAD = { sentence: '확률형 강화는 실패하면 들인 비용만 날아간다.', word: '강화', context: '앞 문장이에요.', pageTitle: '제목' };
const ORIG = {
  meaning: '실패하면 손해라는 뜻이에요.',
  analogy: '메이플로 치면 메소와 같아요.',
  evidence: { nodeId: 'meso', nodeLabel: '메소' },
  candidates: [
    { id: 'meso', label: '메소', score: 0.81, tagId: 'currency', tag: '화폐', tagSim: 0.4 },
    { id: 'starforce', label: SF.label, score: 0.805, tagId: 'prob_upgrade', tag: '확률 강화', tagSim: 0.7 },
    { id: 'cube', label: CUBE.label, score: 0.7 }
  ],
  grounding: { ok: true },
  ending: { ok: true }
};
const okFinal = (over = {}) => ({ diagnosis: { cause: 'structure' }, answer: '메이플로 치면 스타포스 강화와 같은 구조예요.', nodeId: 'starforce', usedFact: SF.facts[0], ...over });

function scripted(answers) {
  const calls = [];
  const ask = async (system, user, opts) => {
    calls.push({ system, user, opts });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (a instanceof Error) throw a;
    return typeof a === 'string' ? a : JSON.stringify(a);
  };
  return { ask, calls };
}

test('parseDiagnosis: 알려진 원인은 고정 문구, 모르는 값·없음은 unknown', () => {
  for (const [k, label] of Object.entries(DIAGNOSE_CAUSES)) assert.deepEqual(parseDiagnosis({ diagnosis: { cause: k } }), { cause: k, label });
  assert.deepEqual(parseDiagnosis({ diagnosis: { cause: '지어낸 원인' } }), { cause: 'unknown', label: DIAGNOSE_UNKNOWN_TEXT });
  assert.deepEqual(parseDiagnosis({}), { cause: 'unknown', label: DIAGNOSE_UNKNOWN_TEXT });
  assert.deepEqual(parseDiagnosis({ diagnosis: 'tone' }), { cause: 'tone', label: DIAGNOSE_CAUSES.tone }, '문자열도 받는다');
  assert.ok(Object.keys(DIAGNOSE_CAUSES).includes('none'));
  for (const label of Object.values(DIAGNOSE_CAUSES)) assert.match(label, /요\.$/, '해요체');
});

test('diagnoseHints: 원래 결과 기록에서 코드가 본 단서(근거·끝맺음·태그·점수 차·이유 칩)', () => {
  assert.ok(diagnoseHints({ ...ORIG, grounding: { ok: false, reason: 'number-outside' } }).some(h => h.cause === 'number'));
  assert.ok(diagnoseHints({ ...ORIG, grounding: { ok: false, reason: 'fact-mismatch' } }).some(h => h.cause === 'facts'));
  assert.ok(diagnoseHints({ ...ORIG, ending: { ok: false } }).some(h => h.cause === 'tone'));
  const plain = diagnoseHints(ORIG);
  assert.ok(plain.some(h => h.cause === 'tag'), '근거 개념 태그 유사도가 낮다');
  assert.ok(plain.some(h => /차이/.test(h.text)), '1·2위 점수 차가 작다');
  assert.ok(diagnoseHints({ ...ORIG, reason: 'forced' }).some(h => h.cause === 'structure'));
  assert.ok(diagnoseHints({ ...ORIG, reason: 'meaning' }).some(h => h.cause === 'meaning'));
  assert.ok(diagnoseHints({ ...ORIG, reason: 'none' }).some(h => h.cause === 'none'));
  assert.deepEqual(diagnoseHints({}), []);
});

test('buildDiagnosePrompt: 원인 목록·도구·원래 비유·뺀 개념, 보내는 글은 호버 범위', () => {
  const { system, user } = buildDiagnosePrompt({ domain: '메이플스토리', analogyPrefix: '메이플로 치면', payload: PAYLOAD, orig: ORIG, rerun: { analogy: '다시 만든 비유예요.', evidence: { nodeId: 'starforce', nodeLabel: SF.label } }, excluded: ['meso'], candidates: [{ id: 'starforce', label: SF.label }], hints: diagnoseHints(ORIG) });
  assert.match(system, /왜 틀렸는지 진단/);
  for (const k of Object.keys(DIAGNOSE_CAUSES)) assert.match(system, new RegExp(`"?${k}"?`));
  for (const name of FOLLOWUP_TOOL_NAMES) assert.match(system, new RegExp(name));
  assert.match(system, /해요체/);
  assert.match(system, /멸칭/);
  assert.match(user, /설명할 문장: 확률형 강화는/);
  assert.match(user, /앞 문장: 앞 문장이에요\./);
  assert.match(user, /👎한 비유: 메이플로 치면 메소와 같아요\./);
  assert.match(user, /쓰지 말 개념: id=meso/);
  assert.match(user, /다시 만든 비유: 다시 만든 비유예요\./);
  assert.match(user, /id=starforce/);
  assert.match(user, /\[코드가 본 단서\]/);
  assert.ok(!user.includes('문단'), '문단은 보내지 않는다');
});

const V = (final, over = {}) => verifyDiagnosis({ final, graph: GRAPH, allowed: new Set(['starforce', 'cube', 'meso']), excluded: new Set(['meso']), sentence: PAYLOAD.sentence, context: PAYLOAD.context, blocklist: BLOCK, ...over });

test('verifyDiagnosis: 통과하면 진단·새 비유·근거', () => {
  const v = V(okFinal());
  assert.equal(v.ok, true);
  assert.equal(v.value.analogy, okFinal().answer);
  assert.equal(v.value.evidence.nodeId, 'starforce');
  assert.deepEqual(v.value.diagnosis, { cause: 'structure', label: DIAGNOSE_CAUSES.structure });
});

test('verifyDiagnosis: 👎한 개념·후보 밖(규칙 1)·근거 밖 사실·지어낸 숫자·금칙어·~습니다는 진다', () => {
  const ex = V(okFinal({ nodeId: 'meso', usedFact: node('meso').facts[0], answer: '메이플로 치면 메소와 같아요.' }));
  assert.equal(ex.ok, false); assert.equal(ex.reason, 'excluded'); assert.match(ex.feedback, /👎/);
  const out = V(okFinal({ nodeId: 'level_exp', usedFact: node('level_exp').facts[0] }));
  assert.equal(out.ok, false); assert.equal(out.reason, 'rule1'); assert.equal(out.rejected, REJECTED_TEXT);
  const ghost = V(okFinal({ nodeId: 'ghost' }));
  assert.equal(ghost.reason, 'rule1');
  const fact = V(okFinal({ usedFact: '스타포스는 하루 세 번만 할 수 있다.' }));
  assert.equal(fact.reason, 'grounding'); assert.equal(fact.rejected, GROUNDING_REJECTED_TEXT);
  const num = V(okFinal({ answer: '메이플로 치면 스타포스를 777번 누르는 것과 같아요.' }));
  assert.equal(num.reason, 'grounding');
  const bad = V(okFinal({ answer: '메이플로 치면 나쁜말 같은 스타포스 강화예요.' }));
  assert.equal(bad.reason, 'blocked'); assert.equal(bad.rejected, BLOCKED_REJECTED_TEXT);
  const formal = V(okFinal({ answer: '메이플로 치면 스타포스 강화와 같은 구조입니다.' }));
  assert.equal(formal.reason, 'ending'); assert.match(formal.feedback, /해요체/);
  const empty = V(okFinal({ answer: '', nodeId: 'starforce' }));
  assert.equal(empty.ok, false);
  const noNode = V(okFinal({ nodeId: null, usedFact: '' }));
  assert.equal(noNode.reason, 'no-node', '원인이 none이 아니면 새 개념이 있어야 한다');
});

test('verifyDiagnosis: 원인 none + nodeId null이면 비유 없이 통과(억지 비유 금지)', () => {
  const v = V({ diagnosis: { cause: 'none' }, answer: '', nodeId: null, usedFact: '' });
  assert.equal(v.ok, true);
  assert.equal(v.value.analogy, '');
  assert.equal(v.value.evidence, null);
  assert.equal(v.value.diagnosis.cause, 'none');
});

test('runDiagnose: 도구 → final 통과 → 한 줄 진단 + 새 비유, 상한·trace', async () => {
  const { ask, calls } = scripted([
    { action: 'get_node_facts', args: { nodeId: 'starforce' } },
    { final: okFinal() }
  ]);
  const r = await runDiagnose({ graph: GRAPH, payload: PAYLOAD, orig: ORIG, downNodeIds: ['meso'], ask, searchGraph: async () => [], blocklist: BLOCK });
  assert.equal(r.analogy, okFinal().answer);
  assert.equal(r.evidence.nodeId, 'starforce');
  assert.equal(r.diagnosis.label, DIAGNOSE_CAUSES.structure);
  assert.equal(r.stopText, null);
  assert.deepEqual(r.debug.trace.map(t => t.type), ['action', 'final', 'verify']);
  assert.equal(r.debug.calls, 2);
  assert.match(calls[0].system, /왜 틀렸는지 진단/);
  assert.ok(DIAGNOSE_MAX_STEPS >= 3 && DIAGNOSE_MAX_CALLS >= 3 && DIAGNOSE_MAX_VERIFIES === 2);
});

test('runDiagnose: 후보 밖 개념을 두 번 대면 비유를 숨기고 "여기까지 했어요"(규칙 1), 실패 이유가 다음 요청에', async () => {
  const bad = okFinal({ nodeId: 'level_exp', usedFact: node('level_exp').facts[0], answer: '메이플로 치면 레벨업과 같아요.' });
  const { ask, calls } = scripted([{ final: bad }]);
  const r = await runDiagnose({ graph: GRAPH, payload: PAYLOAD, orig: ORIG, downNodeIds: ['meso'], ask, searchGraph: async () => [], blocklist: BLOCK });
  assert.equal(r.analogy, '');
  assert.equal(r.evidence, null);
  assert.ok(r.stopText.startsWith(AGENT_STOP_TEXT));
  assert.equal(r.rejected, REJECTED_TEXT);
  assert.equal(r.debug.stop, 'verify');
  assert.equal(calls.length, DIAGNOSE_MAX_VERIFIES);
  assert.match(calls[1].user, /\[검증 실패\]/);
  assert.equal(r.diagnosis.cause, 'structure', '진단 문구는 고정 문구라 보여 준다');
});

test('runDiagnose: 도구로 본 개념은 후보 밖이어도 쓸 수 있다(이번 실행에서 본 노드)', async () => {
  const lv = node('level_exp');
  const { ask } = scripted([
    { action: 'search_by_tag', args: { tagId: lv.tags[0], exclude: ['meso'] } },
    { final: okFinal({ nodeId: 'level_exp', usedFact: lv.facts[0], answer: `메이플로 치면 ${lv.label}와 같아요.` }) }
  ]);
  const r = await runDiagnose({ graph: GRAPH, payload: PAYLOAD, orig: ORIG, downNodeIds: ['meso'], ask, searchGraph: async () => [], blocklist: BLOCK });
  assert.equal(r.evidence?.nodeId, 'level_exp');
});

test('runDiagnose: 하루 상한이면 LLM을 부르지 않고 상한 문구', async () => {
  const { ask, calls } = scripted([{ final: okFinal() }]);
  const r = await runDiagnose({ graph: GRAPH, payload: PAYLOAD, orig: ORIG, downNodeIds: ['meso'], ask, searchGraph: async () => [], budget: { take: async () => false } });
  assert.equal(calls.length, 0);
  assert.equal(r.capped, true);
  assert.equal(r.stopText, DIAGNOSE_CAP_TEXT);
});

test('runDiagnose: 모델이 끝까지 실패하면(체인 소진) 여기까지 했어요 + 이유', async () => {
  const { ask } = scripted([new Error('429')]);
  const r = await runDiagnose({ graph: GRAPH, payload: PAYLOAD, orig: ORIG, downNodeIds: ['meso'], ask, searchGraph: async () => [] });
  assert.ok(r.stopText.startsWith(AGENT_STOP_TEXT));
  assert.equal(r.analogy, '');
  assert.equal(r.diagnosis, null);
});

// 쓰기 제안: 피드백 층 고정(누구나) / 내 태그 예문(로그인 + 내 노드 + 내 태그만, corrections.js 거름)
const OV = {
  tags: [{ id: 'u_focus', label: '몰입 시간', examples: ['손으로 적은 예문은 그대로 남아야 한다.'] }],
  nodes: [{ id: 'u:focus', label: '내 몰입 루틴', facts: ['나는 매일 같은 시간에 30분 집중한다.'], tags: ['u_focus', 'daily_accumulation'] }]
};
const UG = mergeGraphs(COMMON, OV);
const COMMON_TAGS = new Set(COMMON.tags.map(t => t.id));
const S = '2026년 목표를 세우고 매일 같은 시간에 공부하면 몰입하는 시간이 길어진다.';

test('diagnoseAction: 로그아웃이면 고정만(예문 쓰기 없음)', () => {
  assert.deepEqual(diagnoseAction({ graph: UG, nodeId: 'u:focus', sentence: S, loggedIn: false, commonTagIds: COMMON_TAGS }), { kind: 'pin', nodeId: 'u:focus', tagId: 'u_focus' });
});

test('diagnoseAction: 로그인 + 내 노드·내 태그면 가린 예문 미리보기', () => {
  const a = diagnoseAction({ graph: UG, nodeId: 'u:focus', sentence: S, loggedIn: true, commonTagIds: COMMON_TAGS });
  assert.equal(a.kind, 'example');
  assert.equal(a.tagId, 'u_focus');
  assert.equal(a.tagLabel, '몰입 시간');
  assert.equal(a.text, '[숫자]년 목표를 세우고 매일 같은 시간에 공부하면 몰입하는 시간이 길어진다.');
});

test('diagnoseAction: 공통 노드·공통 태그·금칙어·너무 짧은 문장·없는 노드는 예문 없음', () => {
  assert.equal(diagnoseAction({ graph: UG, nodeId: 'starforce', sentence: S, loggedIn: true, commonTagIds: COMMON_TAGS }).kind, 'pin');
  assert.equal(diagnoseAction({ graph: UG, nodeId: 'u:focus', tagId: 'daily_accumulation', sentence: S, loggedIn: true, commonTagIds: COMMON_TAGS }).kind, 'pin', '내 노드라도 공통 태그는 운영자 큐로만');
  assert.equal(diagnoseAction({ graph: UG, nodeId: 'u:focus', sentence: `${S} 나쁜말`, loggedIn: true, commonTagIds: COMMON_TAGS, blockTerms: BLOCK }).kind, 'pin');
  assert.equal(diagnoseAction({ graph: UG, nodeId: 'u:focus', sentence: '짧아요', loggedIn: true, commonTagIds: COMMON_TAGS }).kind, 'pin');
  assert.equal(diagnoseAction({ graph: UG, nodeId: 'ghost', sentence: S, loggedIn: true, commonTagIds: COMMON_TAGS }), null);
});

test('말풍선 버튼 문구(content.js)가 DIAGNOSE_BUTTON_TEXT와 같다', () => {
  const src = readFileSync(new URL('../../extension/content.js', import.meta.url), 'utf8');
  assert.equal(DIAGNOSE_BUTTON_TEXT, '왜 틀렸는지 살펴볼게요');
  assert.ok(src.includes(`'${DIAGNOSE_BUTTON_TEXT}'`));
});

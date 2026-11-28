// 새 관심사 도우미 품질 평가 도구(T-226): 기록 → 지표, 한 번 호출 코드 검사, 채점 프롬프트·답 읽기·요약, expectTag 1위 비율
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_INTERESTS, callKey, reasonKey, helperMetrics, oneShotMetrics, buildNodeJudgePrompt, parseNodeJudge, judgeSummary,
  expectTagItems, graphFromDrafts, expectTagRate, rowLine, totals, totalLines
} from '../../tools/eval-helper-lib.mjs';
import { PROBLEM_TEXT } from '../../extension/lib/interest-helper.js';
import { hashEmbed } from '../../extension/lib/fallback-embed.js';
import { loadCommonGraphFromDisk } from '../../tools/load-graph.mjs';

const common = loadCommonGraphFromDisk();
const TAGS = common.tags;
const blockTerms = JSON.parse(readFileSync(new URL('../../extension/data/common/blocklist.json', import.meta.url), 'utf8')).terms;

const node = (id, label, facts, tags, extra = {}) => ({ id, label, facts, tags, ...extra });

test('기본 관심사: 3~5개, 금칙어 없음, 공통 관심사(메이플·식당)와 겹치지 않음', () => {
  assert.ok(DEFAULT_INTERESTS.length >= 3 && DEFAULT_INTERESTS.length <= 5);
  for (const n of DEFAULT_INTERESTS) {
    assert.ok(!/메이플|식당/.test(n));
    for (const t of blockTerms) assert.ok(!n.includes(t.term));
  }
});

test('callKey: 모델·시스템·사용자 글이 같으면 같고, 하나라도 다르면 다르다', () => {
  assert.equal(callKey('g/m', 'a', 'b'), callKey('g/m', 'a', 'b'));
  assert.notEqual(callKey('g/m', 'a', 'b'), callKey('g/n', 'a', 'b'));
  assert.notEqual(callKey('g/m', 'a', 'b'), callKey('g/m', 'a', 'c'));
  assert.notEqual(callKey('g/m', 'ab', ''), callKey('g/m', 'a', 'b'), '경계가 섞이지 않는다');
});

test('reasonKey: 도우미 뺀 이유 문구 → 키, 모르는 문구는 other:', () => {
  assert.equal(reasonKey(PROBLEM_TEXT.tag), 'tag');
  assert.equal(reasonKey(PROBLEM_TEXT.dup), 'dup');
  assert.match(reasonKey('남은 사실이 없어요.'), /^other:/);
});

test('helperMetrics: 초안 수(처음 큐에 든 id)·고쳐 씀·첫 통과·최종 통과·뺀 이유·태그 커버리지', () => {
  const a = node('u:a', 'A', ['a다.'], ['cooldown']);
  const b = node('u:b', 'B', ['b다.'], ['loss_risk']);
  const c = node('u:c', 'C', ['c다.'], ['market_price']);
  const states = [
    { queue: [], accepted: [], dropped: [] },
    { queue: [{ ...a, rewrites: 0 }, { ...b, rewrites: 0 }, { ...c, rewrites: 0 }], accepted: [], dropped: [] },
    { queue: [], fix: [{ node: b }], accepted: [{ ...a, rewrites: 0 }], dropped: [{ label: 'C', reason: PROBLEM_TEXT.dup }] },
    { queue: [{ ...b, rewrites: 1 }], accepted: [{ ...a, rewrites: 0 }], dropped: [{ label: 'C', reason: PROBLEM_TEXT.dup }] },
    { queue: [], accepted: [{ ...a, rewrites: 0 }, { ...b, rewrites: 1, tags: ['loss_risk', 'cooldown'] }], dropped: [{ label: 'C', reason: PROBLEM_TEXT.dup }, { label: 'X', reason: PROBLEM_TEXT.giveUp }],
      absentTags: ['vendor_lock_in'], calls: 5, steps: 6, round: 1, stop: null }
  ];
  const m = helperMetrics(states, { tagCount: 25 });
  assert.equal(m.drafted, 3);
  assert.equal(m.rewritten, 1);
  assert.equal(m.accepted, 2);
  assert.equal(m.firstPass, 1);
  assert.equal(m.firstPassRate, 1 / 3);
  assert.equal(m.passRate, 2 / 3);
  assert.deepEqual(m.reasons, { dup: 1, giveUp: 1 });
  assert.equal(m.covered, 2);
  assert.equal(m.coverage, 2 / 25);
  assert.deepEqual(m.absent, ['vendor_lock_in']);
  assert.equal(m.calls, 5);
});

test('helperMetrics: 초안이 없으면 비율은 null(0으로 나누지 않는다)', () => {
  const m = helperMetrics([{ queue: [], accepted: [], dropped: [], calls: 1 }], { tagCount: 25 });
  assert.equal(m.drafted, 0);
  assert.equal(m.firstPassRate, null);
  assert.equal(m.passRate, null);
});

test('oneShotMetrics: 도우미 코드 검사(수치·구조 먼저·근접 중복)에 걸릴 수, 태그 커버리지', () => {
  const nodes = [
    node('u:1', '오프사이드', ['공격수가 수비수보다 앞서면 반칙이 된다.'], ['threshold_req']),
    node('u:2', '전후반', ['한 경기는 전후반 90분 동안 한다.'], ['time_window']),
    node('u:3', '골키퍼', ['골키퍼는 골문을 지키는 선수다.'], ['role_division']),
    node('u:4', '오프사이드', ['공격수가 수비수보다 앞서면 반칙이 된다.'], ['threshold_req'])
  ];
  const m = oneShotMetrics(nodes, { tagCount: 25 });
  assert.equal(m.drafted, 4);
  assert.equal(m.flags.number, 1);
  assert.equal(m.flags.structure, 2, '정의만 쓴 골키퍼·전후반');
  assert.equal(m.flags.dup, 1);
  assert.equal(m.covered, 3);
  assert.equal(m.calls, 1);
});

test('채점 프롬프트: 관심사·노드 id·사실 번호·태그 정의, ok/doubt/wrong·familiar·fit 형식', () => {
  const n = node('u:a', '오프사이드', ['앞서면 반칙이 된다.', '심판이 판정한다.'], ['threshold_req']);
  const { system, user } = buildNodeJudgePrompt({ name: '축구', nodes: [n], tags: TAGS });
  assert.match(system, /축구/);
  assert.match(system, /ok.*doubt.*wrong/s);
  assert.match(system, /familiar/);
  assert.match(system, /"fit"/);
  assert.ok(user.includes('id=u:a | 오프사이드'));
  assert.ok(user.includes('사실 0: 앞서면 반칙이 된다.') && user.includes('사실 1: 심판이 판정한다.'));
  assert.ok(user.includes(TAGS.find(t => t.id === 'threshold_req').desc));
  for (const t of blockTerms) assert.ok(!(system + user).includes(t.term));
});

test('parseNodeJudge: 코드블록·잘못된 값은 null로, 중복 id는 처음 것, 모양이 아니면 null', () => {
  const text = '```json\n' + JSON.stringify({ nodes: [
    { id: 'u:a', facts: ['ok', 'wrong', 'maybe'], familiar: 4, tags: [{ id: 'cooldown', fit: 'no' }, { id: 'x', fit: '?' }], note: '메모' },
    { id: 'u:a', facts: ['wrong'], familiar: 1 },
    { id: 'u:b', facts: 'ok', familiar: 9 }
  ] }) + '\n```';
  const v = parseNodeJudge(text);
  assert.deepEqual(v.get('u:a').facts, ['ok', 'wrong', null]);
  assert.equal(v.get('u:a').familiar, 4);
  assert.deepEqual([...v.get('u:a').tags], [['cooldown', 'no']]);
  assert.deepEqual(v.get('u:b').facts, []);
  assert.equal(v.get('u:b').familiar, null);
  assert.equal(parseNodeJudge('그냥 글'), null);
  assert.equal(parseNodeJudge('{"x": 1}'), null);
});

test('judgeSummary: 그럴듯(모든 사실 ok) 비율, 지울 사실(doubt·wrong·답 없음) 비율, 익숙함 평균, 태그 맞음 비율', () => {
  const nodes = [
    node('u:a', 'A', ['a1', 'a2'], ['cooldown', 'loss_risk']),
    node('u:b', 'B', ['b1'], ['market_price']),
    node('u:c', 'C', ['c1'], ['cooldown'])
  ];
  const v = new Map([
    ['u:a', { facts: ['ok', 'ok'], familiar: 5, tags: new Map([['cooldown', 'yes'], ['loss_risk', 'no']]) }],
    ['u:b', { facts: ['wrong'], familiar: 2, tags: new Map([['market_price', 'yes']]) }],
    ['u:c', { facts: [], familiar: null, tags: new Map() }]
  ]);
  const s = judgeSummary(nodes, v);
  assert.equal(s.judged, 3);
  assert.equal(s.plausible, 1 / 3);
  assert.equal(s.facts, 4);
  assert.equal(s.wrongFacts, 1 / 4);
  assert.equal(s.flaggedFacts, 2 / 4, '답이 없는 사실도 지울 사실로 센다');
  assert.equal(s.familiar, 3.5);
  assert.equal(s.tagFit, 2 / 3);
});

test('expectTagItems: expectTag 있는 문장만, 문장 중복 제거', () => {
  const out = expectTagItems([{ sentence: 'a', expectTag: 'cooldown' }, { sentence: 'b' }], [{ sentence: 'a', expectTag: 'loss_risk' }, { sentence: 'c', expectTag: 'loss_risk', expectNodes: ['x'] }]);
  assert.deepEqual(out, [{ sentence: 'a', expectTag: 'cooldown' }, { sentence: 'c', expectTag: 'loss_risk' }]);
});

test('graphFromDrafts: 공통 노드 없이 초안만, draft 표시는 떼고(검수 마친 것으로), 공통 태그 사전만 빌린다', () => {
  const g = graphFromDrafts(common, '축구', [node('u:a', 'A', ['a다.'], ['cooldown'], { draft: true, factsReviewed: [false] })]);
  assert.deepEqual(g.nodes.map(n => n.id), ['u:a']);
  assert.equal(g.domain, '축구');
  assert.deepEqual(g.tags.map(t => t.id), ['cooldown']);
});

test('expectTagRate: 1위 노드가 expectTag를 가지면 맞음, 덮은 태그 안 비율은 그 태그 노드가 있는 문장만', () => {
  const nodes = [
    node('u:a', '교체 대기', ['선수를 바꾸면 다시 바꾸기까지 기다려야 한다.'], ['cooldown']),
    node('u:b', '이적 시장', ['찾는 구단이 많을수록 선수 몸값이 오른다.'], ['market_price'])
  ];
  const g = graphFromDrafts(common, '축구', nodes);
  const items = [
    { sentence: '스킬을 한 번 쓰면 다시 쓰기까지 기다려야 한다.', expectTag: 'cooldown' },
    { sentence: '사려는 사람이 많을수록 값이 오른다.', expectTag: 'market_price' },
    { sentence: '레버리지는 손실을 키운다.', expectTag: 'loss_risk' }
  ];
  const r = expectTagRate(g, items, { embed: hashEmbed });
  assert.equal(r.n, 3);
  assert.equal(r.coveredN, 2);
  assert.equal(r.hit, 2);
  assert.equal(r.coveredHit, 2);
  assert.equal(r.covered, 1);
  assert.equal(r.all, 2 / 3);
  const empty = expectTagRate(graphFromDrafts(common, '축구', []), items, { embed: hashEmbed });
  assert.equal(empty.hit, 0);
  assert.equal(empty.covered, null);
});

test('rowLine·totals·totalLines: 방법별 한 줄과 합계(노드·문장 합), 오류 줄', () => {
  const helper = {
    interest: '축구', method: 'helper', tagCount: 25,
    metrics: { drafted: 10, accepted: 6, firstPass: 4, firstPassRate: 0.4, passRate: 0.6, rewritten: 3, covered: 5, calls: 12, reasons: {} },
    judge: { judged: 6, plausible: 0.5, facts: 12, wrongFacts: 0.25, flaggedFacts: 0.5, familiar: 4, tagFit: 0.8 },
    expect: { hit: 10, n: 97, all: 10 / 97, coveredHit: 8, coveredN: 20, covered: 0.4 }
  };
  const one = {
    interest: '축구', method: 'oneshot', tagCount: 25,
    metrics: { drafted: 15, accepted: 15, flags: { number: 1, structure: 2, dup: 0 }, covered: 10, calls: 1 },
    judge: { judged: 15, plausible: 0.6, facts: 30, wrongFacts: 0.1, flaggedFacts: 0.3, familiar: 3, tagFit: 0.6 },
    expect: { hit: 20, n: 97, all: 20 / 97, coveredHit: 18, coveredN: 60, covered: 0.3 }
  };
  assert.match(rowLine(helper), /축구 · 도우미: 초안 10 → 남음 6 · 첫 통과 40% · 최종 통과 60%/);
  assert.match(rowLine(helper), /expectTag 1위 10\/97\(10%\)/);
  assert.match(rowLine(one), /T-301 한 번: .*수치 1·구조 2·중복 0/);
  assert.match(rowLine({ interest: '커피', method: 'helper', error: '429' }), /커피 · 도우미: 오류 429/);
  const t = totals([helper, one, { interest: '커피', method: 'helper', error: 'x' }]);
  assert.equal(t.helper.interests, 1);
  assert.equal(t.helper.firstPass, 4);
  assert.equal(t.oneshot.firstPass, null);
  assert.equal(t.helper.flaggedFacts, 0.5);
  assert.equal(t.oneshot.expectHit, 20);
  const lines = totalLines(t, 25);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^도우미\(1개 관심사\)/);
  assert.match(lines[1], /^T-301 한 번\(1개 관심사\)/);
});

test('helperMetrics·rowLine·totalLines: 정상 종료 이유(end)와 평가 다른 제공자 수(T-229)', () => {
  const end = { queue: [], accepted: [], dropped: [], calls: 10, stop: null, end: 'budget', evalBy: { other: 3, same: 1 } };
  const m = helperMetrics([end], { tagCount: 25 });
  assert.equal(m.end, 'budget');
  assert.deepEqual(m.evalBy, { other: 3, same: 1 });
  const row = { interest: '축구', method: 'helper', tagCount: 25, metrics: m };
  assert.match(rowLine(row), /끝 budget/);
  assert.match(rowLine(row), /평가 다른 제공자 3\/4/);
  assert.match(rowLine({ ...row, metrics: { ...m, stop: 'calls' } }), /끝 상한 calls/);
  const t = totals([row, { ...row, interest: '커피' }]);
  assert.equal(t.helper.evalOther, 6);
  assert.match(totalLines(t, 25)[0], /평가 다른 제공자 6\/8/);
  // 예전 기록(evalBy 없음)은 평가 줄을 싣지 않는다
  assert.doesNotMatch(rowLine({ ...row, metrics: { ...m, evalBy: null } }), /평가 다른 제공자/);
});

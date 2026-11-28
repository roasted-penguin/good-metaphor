// 새 관심사 만들기 도우미(T-225, ADR 0017 에이전트 2): 계획 → 초안 → 평가자 → 개선자 루프, 상한, 세션 이어 가기, 쓰기 제한
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  newHelperState, helperStep, runHelper, helperView, helperDraftNodes, mergeHelperDrafts,
  buildPlanPrompt, parsePlan, buildConceptDraftPrompt, buildEvalPrompt, parseEval, buildRewritePrompt, parseRewrite,
  HELPER_LIMITS, HELPER_TEXT, PROBLEM_TEXT, HELPER_MARK, cleanNotes, readList
} from '../../extension/lib/interest-helper.js';
import { DRAFT_LIMITS } from '../../extension/lib/draft.js';
import { mergeGraphs } from '../../extension/lib/graph.js';
import { validateOverlay } from '../../extension/lib/stores.js';
import { TAG_FIT_RULES } from '../../extension/lib/node-checks.js';
import { loadCommonGraphFromDisk } from '../../tools/load-graph.mjs';

const TAGS = JSON.parse(readFileSync(new URL('../../extension/data/common/tags.json', import.meta.url), 'utf8')).tags;
const blockTerms = JSON.parse(readFileSync(new URL('../../extension/data/common/blocklist.json', import.meta.url), 'utf8')).terms;
const BLOCKED = '리.선 족'; // 금칙어는 테스트 안에서만(우회 표기)
const common = loadCommonGraphFromDisk();

const J = o => JSON.stringify(o);
const kind = system => system.includes(HELPER_MARK.plan) ? 'plan'
  : system.includes(HELPER_MARK.draft) ? 'draft'
    : system.includes(HELPER_MARK.evaluate) ? 'evaluate'
      : system.includes(HELPER_MARK.rewrite) ? 'rewrite' : '?';
const idsIn = user => [...user.matchAll(/id=(u:\S+)/g)].map(m => m[1]);
const labelsIn = user => [...user.matchAll(/^- (.+?) \| 태그 /gm)].map(m => m[1]);

// 개념 이름 → 초안(사실·태그). 기본 사실은 구조가 드러나는 평서문
const FACT = {
  '오프사이드': { facts: ['공격수가 수비수보다 앞에서 공을 받으면 반칙이 된다.'], tags: ['threshold_req'] },
  '이적 시장': { facts: ['인기 선수는 데려가려는 구단이 몰릴수록 몸값이 오른다.'], tags: ['market_price', 'scarcity_value'] },
  '체력 안배': { facts: ['전반에 힘을 많이 쓰면 후반에 뛸 힘이 줄어든다.'], tags: ['diminishing_returns'] },
  '경고 누적': { facts: ['경고가 쌓이면 다음 경기에 나갈 수 없다.'], tags: ['loss_risk', 'threshold_req'] },
  '억지 개념': { facts: ['선수들은 경기 전에 몸을 푼다.'], tags: ['prob_upgrade'] },
  '숫자 개념': { facts: ['한 경기는 전후반 90분 동안 한다.'], tags: ['periodic_cap'] }
};

/**
 * 가짜 LLM. opts로 장면을 바꾼다
 *  plan: 첫 계획 개념, plan2: 다음 바퀴 개념, skip: 계획이 포기할 태그
 *  weak: 평가에서 태그 no 낼 개념 이름, rewriteDrop: 고쳐 쓰기에서 drop할 이름, unfamiliar: 익숙하지 않다고 할 이름
 */
function fakeAsk(opts = {}) {
  const log = [];
  const ask = async (system, user) => {
    const k = kind(system);
    log.push({ k, system, user });
    if (opts.throwOn === k) throw new Error('체인 소진');
    if (k === 'plan') {
      const round = log.filter(x => x.k === 'plan').length;
      const list = round === 1 ? (opts.plan ?? ['오프사이드', '이적 시장', '체력 안배']) : (opts.plan2 ?? []);
      return J({ concepts: list.map(l => ({ label: l, tag: FACT[l]?.tags[0] ?? 'threshold_req', why: '팬이면 다 안다' })), skip: opts.skip ?? [] });
    }
    if (k === 'draft') {
      return J({ nodes: labelsIn(user).map(l => ({ label: l, ...(FACT[l] || { facts: [`${l}은 연습할수록 는다.`], tags: ['daily_accumulation'] }), ...(opts.source ? { source: opts.source } : {}) })) });
    }
    if (k === 'evaluate') {
      const blocks = user.split('\n[노드] ').slice(1);
      return J({ nodes: blocks.map(b => {
        const id = b.match(/^id=(\S+)/)[1];
        const label = b.match(/^id=\S+ \| (.+)/)[1];
        const tagIds = [...b.matchAll(/^  태그 (\S+) \|/gm)].map(m => m[1]);
        const weak = (opts.weak || []).includes(label);
        return { id, tags: tagIds.map(t => ({ id: t, verdict: weak ? 'no' : 'yes', reason: weak ? '구조가 안 보여요' : '맞아요' })), familiar: (opts.unfamiliar || []).includes(label) ? 'no' : 'yes', named: 'no', reason: '' };
      }) });
    }
    if (k === 'rewrite') {
      const blocks = user.split('\n[노드] ').slice(1);
      return J({ nodes: blocks.map(b => {
        const id = b.match(/^id=(\S+)/)[1];
        const label = b.match(/^id=\S+ \| (.+)/)[1];
        if ((opts.rewriteDrop || []).includes(label)) return { id, drop: true, reason: '이 관심사에는 이 구조가 없어요.' };
        if (label === '숫자 개념') return { id, label, facts: ['한 경기는 정해진 시간이 끝나면 더 뛰지 않는다.'], tags: ['periodic_cap'] };
        return { id, label, facts: FACT[label]?.facts || ['고친 사실이다.'], tags: FACT[label]?.tags || ['threshold_req'] };
      }) });
    }
    return '{}';
  };
  return { ask, log };
}

function deps(over = {}) {
  const writes = [];
  let n = 0;
  return {
    writes,
    tags: TAGS, blockTerms, existing: [], reservedIds: [],
    write: async nodes => { writes.push(nodes); return { written: nodes.length }; },
    now: () => 1000 + n++, rand: (() => { let s = 1; return () => ((s = (s * 9301 + 49297) % 233280) / 233280); })(),
    ...over
  };
}

async function run(state, d, { roundTrip = false } = {}) {
  let s = state;
  const saved = [];
  s = await runHelper(s, d, { save: async x => { saved.push(x); }, roundTrip });
  return { s, saved };
}

/* ───── 프롬프트 ───── */

test('계획 프롬프트: 관심사·메모·통제 어휘(desc·예문)·피할 이름, 익숙함·구조 먼저·수치·인물/멸칭 규칙. 금칙어 자체는 없다', () => {
  const { system, user } = buildPlanPrompt({ name: '축구', notes: '국내 리그 위주', tags: TAGS, targetTags: TAGS.map(t => t.id), avoid: ['내 노드 하나'], n: 10 });
  const all = system + '\n' + user;
  assert.ok(system.includes(HELPER_MARK.plan));
  for (const t of TAGS) { assert.ok(all.includes(t.id)); assert.ok(all.includes(t.desc)); }
  assert.ok(all.includes(TAGS[0].examples[0]), '예문 한 줄');
  assert.ok(all.includes('축구') && all.includes('국내 리그 위주') && all.includes('내 노드 하나'));
  assert.match(system, /익숙/);
  assert.match(system, /수치/);
  assert.match(system, /실존 인물/);
  assert.match(system, /멸칭/);
  assert.match(system, /skip/);
  for (const t of blockTerms) assert.ok(!all.includes(t.term), '금칙어는 프롬프트에 넣지 않는다(규칙 11)');
});

test('초안·평가·고쳐 쓰기 프롬프트: 표시어, 평가자는 태그 적합성 기준(TAG_FIT_RULES)과 익숙함·이름 판정', () => {
  const d = buildConceptDraftPrompt({ name: '축구', notes: '', concepts: [{ label: '오프사이드', tag: 'threshold_req' }], tags: TAGS });
  assert.ok(d.system.includes(HELPER_MARK.draft) && d.user.includes('오프사이드'));
  assert.match(d.system, /source/);
  const node = { id: 'u:a', label: '오프사이드', facts: ['앞서면 반칙이 된다.'], tags: ['threshold_req'] };
  const e = buildEvalPrompt({ name: '축구', nodes: [node], tags: TAGS });
  assert.ok(e.system.includes(HELPER_MARK.evaluate));
  for (const line of TAG_FIT_RULES.slice(1)) assert.ok(e.system.includes(line));
  assert.match(e.system, /familiar/);
  assert.match(e.system, /named/);
  assert.ok(e.user.includes('id=u:a | 오프사이드'));
  const r = buildRewritePrompt({ name: '축구', items: [{ node, problems: ['number'] }], tags: TAGS });
  assert.ok(r.system.includes(HELPER_MARK.rewrite) && r.user.includes(PROBLEM_TEXT.number));
  assert.match(r.system, /drop/);
});

/* ───── 파싱 ───── */

test('parsePlan: 목록 밖 태그·금칙어 이름·중복 이름·피할 이름을 버리고, skip은 통제 어휘만', () => {
  const ids = new Set(TAGS.map(t => t.id));
  const text = '```json\n' + J({ concepts: [
    { label: '오프사이드', tag: 'threshold_req' },
    { label: '오프사이드', tag: 'loss_risk' },
    { label: '없는 태그', tag: 'made_up' },
    { label: `${BLOCKED} 선수`, tag: 'loss_risk' },
    { label: '내 노드', tag: 'loss_risk' },
    { label: '', tag: 'loss_risk' }
  ], skip: ['cooldown', 'made_up'] }) + '\n```';
  const p = parsePlan(text, { tagIds: ids, blockTerms, avoid: ['내 노드'] });
  assert.deepEqual(p.concepts.map(c => c.label), ['오프사이드']);
  assert.deepEqual(p.skip, ['cooldown']);
  assert.equal(parsePlan('읽을 수 없음', { tagIds: ids, blockTerms }), null);
});

test('parseEval·parseRewrite: id로 묶고 꼴이 틀리면 null', () => {
  const e = parseEval(J({ nodes: [{ id: 'u:a', tags: [{ id: 't1', verdict: 'no', reason: 'x' }], familiar: 'yes', named: 'no' }, { id: 'u:b', tags: 'x' }] }));
  assert.equal(e.get('u:a').tags.get('t1').verdict, 'no');
  assert.equal(e.get('u:a').familiar, 'yes');
  assert.equal(e.has('u:b'), true);
  assert.equal(parseEval('없음'), null);
  const r = parseRewrite(J({ nodes: [{ id: 'u:a', drop: true, reason: '없음' }, { id: 'u:b', label: 'B', facts: ['b다.'], tags: ['cooldown'] }] }));
  assert.equal(r.get('u:a').drop, true);
  assert.equal(r.get('u:b').label, 'B');
  assert.equal(parseRewrite('x'), null);
});

test('감싸기 없는 최상위 배열도 읽는다(T-226 실측: Gemini 3.1 flash-lite 평가 답이 [...])', () => {
  const arr = [{ id: 'u:a', tags: [{ id: 'cooldown', verdict: 'yes', reason: 'x' }], familiar: 'no', named: 'no' }];
  assert.equal(parseEval(J(arr)).get('u:a').familiar, 'no');
  assert.equal(parseEval('검사 결과:\n```json\n' + J(arr) + '\n```').get('u:a').tags.get('cooldown').verdict, 'yes');
  assert.equal(parseEval('답: ' + J([...arr, { id: 'u:b', tags: [], familiar: 'yes', named: 'no' }]) + ' 끝').size, 2, '앞뒤 글이 있어도 둘 다');
  assert.equal(parseRewrite(J([{ id: 'u:a', drop: true }])).get('u:a').drop, true);
  const p = parsePlan(J([{ label: '오프사이드', tag: 'threshold_req', why: 'x' }]), { tagIds: new Set(TAGS.map(t => t.id)) });
  assert.deepEqual(p.concepts.map(c => c.label), ['오프사이드']);
  assert.deepEqual(p.skip, []);
  assert.deepEqual(readList(J({ nodes: [{ a: 1 }] }), 'nodes'), [{ a: 1 }]);
  assert.equal(readList(J({ x: [1, 2] }), 'nodes'), null, '숫자 배열은 노드 목록이 아니다');
  assert.equal(readList(J({ nodes: 'x' }), 'nodes'), null);
  assert.equal(readList('없음', 'nodes'), null);
});

test('초안 답이 최상위 배열이어도 출처를 받는다', async () => {
  const f = fakeAsk({ plan: ['오프사이드'] });
  const ask = async (system, user, opts) => {
    const t = await f.ask(system, user, opts);
    if (system.includes(HELPER_MARK.draft)) return J(JSON.parse(t).nodes.map(n => ({ ...n, source: 'https://example.com/a' })));
    return t;
  };
  const d = deps({ ask });
  await run(newHelperState({ name: '축구', mode: 'add' }), d);
  assert.deepEqual(d.writes[0][0].sources, ['https://example.com/a']);
});

test('cleanNotes: 300자로 자르고 금칙어가 있으면 null', () => {
  assert.equal(cleanNotes('  메모  ', blockTerms), '메모');
  assert.equal(cleanNotes('가'.repeat(400), blockTerms).length, HELPER_LIMITS.notes);
  assert.equal(cleanNotes(`${BLOCKED} 얘기`, blockTerms), null);
  assert.equal(cleanNotes('', blockTerms), '');
});

/* ───── 흐름 ───── */

test('흐름: 계획 → 초안 → 평가 → 쓰기. 결과는 모두 draft·미확인·u: id, 출처는 http(s)만 sources로', async () => {
  const f = fakeAsk({ source: 'https://example.com/rules' });
  const d = deps({ ask: f.ask });
  const { s } = await run(newHelperState({ name: '축구', notes: '', mode: 'add', now: 0 }), d);
  assert.equal(s.status, 'done');
  assert.equal(d.writes.length, 1);
  const nodes = d.writes[0];
  assert.deepEqual(nodes.map(n => n.label).sort(), ['오프사이드', '이적 시장', '체력 안배'].sort());
  for (const n of nodes) {
    assert.equal(n.draft, true);
    assert.deepEqual(n.factsReviewed, n.facts.map(() => false));
    assert.ok(n.id.startsWith('u:'));
    assert.deepEqual(n.sources, ['https://example.com/rules']);
    assert.deepEqual(Object.keys(n).sort(), ['draft', 'facts', 'factsReviewed', 'id', 'label', 'sources', 'tags'].sort(), '내부 필드는 남기지 않는다');
  }
  assert.ok(s.calls <= HELPER_LIMITS.maxCalls);
  assert.equal(s.written, 3);
  const v = helperView(s);
  assert.equal(v.status, 'done');
  assert.match(v.doneText, /초안 3개를 검수 대기에 넣었어요/);
  assert.ok(v.log.length >= 3, '단계별 진행 줄');
});

test('출처: http(s)가 아니면 버린다', async () => {
  const f = fakeAsk({ source: 'javascript:alert(1)', plan: ['오프사이드'] });
  const d = deps({ ask: f.ask });
  await run(newHelperState({ name: '축구', mode: 'add' }), d);
  assert.equal(d.writes[0][0].sources, undefined);
});

test('평가자: 태그가 모두 no면 고쳐 쓰기 → 개선자가 drop하면 뺀다(이유 남김), 목표 태그 실패 1', async () => {
  const f = fakeAsk({ plan: ['오프사이드', '억지 개념'], weak: ['억지 개념'], rewriteDrop: ['억지 개념'] });
  const d = deps({ ask: f.ask });
  const { s } = await run(newHelperState({ name: '축구', mode: 'add' }), d);
  assert.deepEqual(d.writes[0].map(n => n.label), ['오프사이드']);
  const drop = s.dropped.find(x => x.label === '억지 개념');
  assert.ok(drop, '뺀 목록에 있다');
  assert.equal(s.tagFails.prob_upgrade, 1);
  assert.ok(f.log.some(x => x.k === 'rewrite' && x.user.includes(PROBLEM_TEXT.tag)));
});

test('평가자: 고쳐 써도 또 태그가 no면 뺀다(노드당 고쳐 쓰기 1회)', async () => {
  const f = fakeAsk({ plan: ['억지 개념'], weak: ['억지 개념'] });
  const d = deps({ ask: f.ask });
  const { s } = await run(newHelperState({ name: '축구', mode: 'add' }), d);
  assert.equal(f.log.filter(x => x.k === 'rewrite').length, 1);
  assert.equal(d.writes.length, 0, '넣을 초안이 없으면 쓰지 않는다');
  assert.equal(s.dropped.find(x => x.label === '억지 개념').reason, PROBLEM_TEXT.tag);
  assert.match(helperView(s).doneText, /쓸 수 있는 초안이 없어요/);
});

test('평가자: 태그 일부만 no면 그 태그만 빼고 통과', async () => {
  const f = fakeAsk({ plan: ['경고 누적'] });
  const base = f.ask;
  const ask = async (system, user, o) => {
    const t = await base(system, user, o);
    if (kind(system) !== 'evaluate') return t;
    const v = JSON.parse(t);
    v.nodes[0].tags = v.nodes[0].tags.map(x => x.id === 'threshold_req' ? { ...x, verdict: 'no' } : x);
    return J(v);
  };
  const d = deps({ ask });
  await run(newHelperState({ name: '축구', mode: 'add' }), d);
  assert.deepEqual(d.writes[0][0].tags, ['loss_risk']);
});

test('코드 검사: 숫자 사실은 고쳐 쓰기로 숫자를 뺀다', async () => {
  const f = fakeAsk({ plan: ['숫자 개념'] });
  const d = deps({ ask: f.ask });
  await run(newHelperState({ name: '축구', mode: 'add' }), d);
  assert.ok(f.log.some(x => x.k === 'rewrite' && x.user.includes(PROBLEM_TEXT.number)));
  assert.deepEqual(d.writes[0][0].facts, ['한 경기는 정해진 시간이 끝나면 더 뛰지 않는다.']);
  // 숫자가 있는 초안은 평가자 LLM에 보내지 않는다(코드가 먼저 걸러 호출 아낌)
  const firstEval = f.log.find(x => x.k === 'evaluate');
  assert.ok(!firstEval || !firstEval.user.includes('90분'));
});

test('평가자: 익숙하지 않음도 고쳐 쓰기, 또 낯설면 뺀다', async () => {
  const f = fakeAsk({ plan: ['체력 안배'], unfamiliar: ['체력 안배'] });
  const d = deps({ ask: f.ask });
  const { s } = await run(newHelperState({ name: '축구', mode: 'add' }), d);
  assert.equal(s.dropped[0].reason, PROBLEM_TEXT.unfamiliar);
});

test('근접 중복: 오버레이에 거의 같은 노드가 있으면 LLM 없이 바로 뺀다(같은 이름은 계획에서 이미 피한다)', async () => {
  const f = fakeAsk({ plan: ['오프사이드', '이적 시장'] });
  const existing = [{ id: 'u:mine', label: '오프사이드 규칙', facts: [...FACT['오프사이드'].facts], tags: ['threshold_req'] }];
  const d = deps({ ask: f.ask, existing, reservedIds: ['u:mine'] });
  const { s } = await run(newHelperState({ name: '축구', mode: 'add' }), d);
  assert.deepEqual(d.writes[0].map(n => n.label), ['이적 시장']);
  assert.equal(s.dropped.find(x => x.label === '오프사이드').reason, PROBLEM_TEXT.dup);
  assert.equal(f.log.filter(x => x.k === 'rewrite').length, 0, '중복은 고쳐 쓰지 않는다');
  // 같은 이름은 계획 답에서 버린다
  const f2 = fakeAsk({ plan: ['오프사이드'] });
  const d2 = deps({ ask: f2.ask, existing: [{ id: 'u:x', label: '오프사이드', facts: ['다른 사실이다.'], tags: ['threshold_req'] }] });
  await run(newHelperState({ name: '축구', mode: 'add' }), d2);
  assert.equal(f2.log.filter(x => x.k === 'draft').length, 0);
  assert.ok(f2.log[0].user.includes('- 오프사이드'), '피할 이름으로 알린다');
});

test('근접 중복: 초안끼리 사실이 거의 같으면 뒤의 것을 뺀다', async () => {
  const f = fakeAsk({ plan: ['오프사이드', '오프사이드 반칙'] });
  FACT['오프사이드 반칙'] = { facts: [...FACT['오프사이드'].facts], tags: ['threshold_req'] };
  const d = deps({ ask: f.ask });
  const { s } = await run(newHelperState({ name: '축구', mode: 'add' }), d);
  assert.deepEqual(d.writes[0].map(n => n.label), ['오프사이드']);
  assert.equal(s.dropped.find(x => x.label === '오프사이드 반칙').reason, PROBLEM_TEXT.dup);
  delete FACT['오프사이드 반칙'];
});

test('금칙어: 초안 사실의 금칙어는 빠지고 이름의 금칙어면 노드째 뺀다(뺀 목록에 금칙어를 싣지 않음)', async () => {
  const f = fakeAsk({ plan: ['오프사이드', `${BLOCKED} 개념`] });
  FACT[`${BLOCKED} 개념`] = { facts: ['나쁜 이름이다.'], tags: ['loss_risk'] };
  const d = deps({ ask: f.ask });
  const { s } = await run(newHelperState({ name: '축구', mode: 'add' }), d);
  delete FACT[`${BLOCKED} 개념`];
  assert.deepEqual(d.writes[0].map(n => n.label), ['오프사이드']);
  assert.ok(!JSON.stringify(s).includes(BLOCKED));
});

test('빈 태그 루프: 다음 바퀴 계획은 덮지 못한 태그만 묻고, 계획이 두 번 skip한 태그는 "이 관심사에 없음"', async () => {
  const f = fakeAsk({ plan: ['오프사이드'], plan2: ['체력 안배'], skip: ['vendor_lock_in'] });
  const d = deps({ ask: f.ask });
  const { s } = await run(newHelperState({ name: '축구', mode: 'add' }), d);
  const plans = f.log.filter(x => x.k === 'plan');
  assert.ok(plans.length >= 2);
  assert.ok(!plans[1].user.includes('- threshold_req |'), '이미 덮은 태그는 다시 묻지 않는다');
  // T-226: skip 한 번은 실패 1(첫 계획이 못 고른 태그를 몽땅 skip하던 문제). 다음 바퀴에 다시 묻고, 두 번째 skip에 없음
  assert.ok(plans[1].user.includes('- vendor_lock_in |'), 'skip 한 번으로는 다시 묻는다');
  if (plans[2]) assert.ok(!plans[2].user.includes('- vendor_lock_in |'), '두 번 skip하면 다시 묻지 않는다');
  assert.equal(s.tagFails.vendor_lock_in, 2);
  assert.ok(s.absentTags.includes('vendor_lock_in'));
  assert.ok(plans.length <= HELPER_LIMITS.maxRounds);
  assert.deepEqual(d.writes[0].map(n => n.label).sort(), ['오프사이드', '체력 안배'].sort());
});

test('계획 skip 한 번은 "없음"이 아니다(실패 1, T-226)', async () => {
  const f = fakeAsk({ plan: ['오프사이드'], plan2: [], skip: ['vendor_lock_in', 'brokerage_fee'] });
  const d = deps({ ask: f.ask });
  const s = await helperStep(newHelperState({ name: '축구', mode: 'add' }), d);
  assert.deepEqual(s.absentTags, []);
  assert.equal(s.tagFails.vendor_lock_in, 1);
  assert.equal(s.tagFails.brokerage_fee, 1);
});

test('계획 프롬프트: 개수를 먼저 채우고 skip은 아예 없는 구조만(T-226)', () => {
  const { system } = buildPlanPrompt({ name: '축구', tags: TAGS, targetTags: TAGS.map(t => t.id), avoid: [], n: 10 });
  assert.match(system, /10개를 채우는 것이 먼저/);
  assert.match(system, /이번에 고르지 않은 태그가 아니라/);
});

test('같은 태그가 두 번 실패하면 그 태그는 이 관심사에 없음으로 보고 다시 묻지 않는다', async () => {
  FACT['억지 둘'] = { facts: ['선수들은 경기 뒤에 쉰다.'], tags: ['prob_upgrade'] };
  const f = fakeAsk({ plan: ['억지 개념'], plan2: ['억지 둘'], weak: ['억지 개념', '억지 둘'], rewriteDrop: ['억지 개념', '억지 둘'] });
  const d = deps({ ask: f.ask });
  const { s } = await run(newHelperState({ name: '축구', mode: 'add' }), d);
  delete FACT['억지 둘'];
  assert.equal(s.tagFails.prob_upgrade, 2);
  assert.ok(s.absentTags.includes('prob_upgrade'));
  const plans = f.log.filter(x => x.k === 'plan');
  if (plans[2]) assert.ok(!plans[2].user.includes('- prob_upgrade |'));
});

test('초안 상한: 개념이 많아도 20개(DRAFT_LIMITS.max)를 넘기지 않는다', async () => {
  const SY = '가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허고노';
  const WORDS = ['훈련', '전술', '관중', '응원', '경기장', '유니폼', '심판', '주장', '골키퍼', '수비', '공격', '패스', '드리블', '슈팅', '코너킥', '프리킥', '교체', '연장전', '승부차기', '리그', '컵대회', '이적', '유소년', '감독', '전지훈련', '부상', '회복', '전력분석', '홈경기', '원정'];
  const many = WORDS.map((w, k) => `${w} ${SY[k]}`);
  many.forEach((l, k) => { FACT[l] = { facts: [`${WORDS[k]}에 ${SY[k]}${SY[(k + 7) % 30]}${SY[(k + 13) % 30]} 방식으로 힘을 쏟을수록 ${WORDS[(k + 11) % 30]} 결과가 달라진다.`], tags: [TAGS[k % TAGS.length].id] }; });
  const f = fakeAsk({ plan: many, plan2: many });
  const d = deps({ ask: f.ask, limits: { maxCalls: 40, maxSteps: 80 } });
  await run(newHelperState({ name: '축구', mode: 'add' }), d);
  for (const l of many) delete FACT[l];
  assert.ok(d.writes[0].length > HELPER_LIMITS.firstPlan, '빈 태그를 채우려 다음 바퀴도 돈다');
  assert.ok(d.writes[0].length <= DRAFT_LIMITS.max);
  assert.ok(f.log.filter(x => x.k === 'plan')[0].user.includes(`${HELPER_LIMITS.firstPlan}개`));
});

/* ───── 상한·실패 ───── */

test('호출 상한: 다 쓰면 평가를 마친 초안만 넣고 "여기까지", 평가 못 할 초안은 쓰지 않는다', async () => {
  const f = fakeAsk({ plan: ['오프사이드', '이적 시장', '체력 안배', '경고 누적', '억지 개념', '숫자 개념'] });
  const d = deps({ ask: f.ask, limits: { maxCalls: 3, batch: 2 } });
  const { s } = await run(newHelperState({ name: '축구', mode: 'add' }), d);
  assert.equal(s.calls, 3);
  assert.equal(s.stop, 'calls');
  // 계획 1 + 초안 1 + 평가 1: 평가를 거친 2개만
  assert.equal(d.writes[0].length, 2);
  assert.match(helperView(s).doneText, /여기까지 했어요/);
  for (const x of f.log.filter(x => x.k === 'draft')) assert.ok(x, '초안 호출 뒤에는 늘 평가 호출 자리가 남아 있었다');
  assert.equal(f.log.filter(x => x.k === 'draft').length, 1);
});

test('하루 상한(agent.dailyCallCap 공유): budget이 거절하면 daily-cap, 상한 문구, 그때까지 통과분만', async () => {
  const f = fakeAsk();
  let left = 0;
  const d = deps({ ask: f.ask, budget: { take: async () => left-- > 0 } });
  const { s } = await run(newHelperState({ name: '축구', mode: 'add' }), d);
  assert.equal(s.stop, 'daily-cap');
  assert.equal(f.log.length, 0);
  assert.equal(helperView(s).stopText, HELPER_TEXT.cap);
  assert.equal(d.writes.length, 0);

  const f2 = fakeAsk();
  left = 3; // 계획·초안·평가까지
  const d2 = deps({ ask: f2.ask, budget: { take: async () => left-- > 0 } });
  const { s: s2 } = await run(newHelperState({ name: '축구', mode: 'add' }), d2);
  assert.equal(s2.stop, 'daily-cap');
  assert.equal(d2.writes[0].length, 3);
  assert.match(helperView(s2).doneText, /초안 3개/);
  assert.match(helperView(s2).doneText, new RegExp(HELPER_TEXT.cap));
});

test('LLM 오류: 체인이 다 막히면 llm-error로 멈추고 통과분은 넣는다', async () => {
  const f = fakeAsk({ throwOn: 'rewrite', plan: ['오프사이드', '숫자 개념'] });
  const d = deps({ ask: f.ask });
  const { s } = await run(newHelperState({ name: '축구', mode: 'add' }), d);
  assert.equal(s.stop, 'llm-error');
  assert.deepEqual(d.writes[0].map(n => n.label), ['오프사이드']);
  assert.equal(helperView(s).stopText, HELPER_TEXT.llm);
});

test('계획 답을 못 읽으면 format으로 멈춘다', async () => {
  const d = deps({ ask: async () => '모르겠어요' });
  const { s } = await run(newHelperState({ name: '축구', mode: 'add' }), d);
  assert.equal(s.stop, 'format');
  assert.equal(s.status, 'done');
});

test('평가 답을 못 읽으면 한 번 다시 묻고, 또 못 읽으면 검사 못 한 초안은 넣지 않는다', async () => {
  const f = fakeAsk({ plan: ['오프사이드'] });
  const ask = async (system, user, o) => (kind(system) === 'evaluate' ? '꼴 틀림' : f.ask(system, user, o));
  const d = deps({ ask });
  const { s } = await run(newHelperState({ name: '축구', mode: 'add' }), d);
  assert.equal(d.writes.length, 0);
  assert.equal(s.dropped[0].reason, PROBLEM_TEXT.unchecked);
});

test('단계 상한: maxSteps에 닿으면 steps로 멈춘다', async () => {
  const f = fakeAsk();
  const d = deps({ ask: f.ask, limits: { maxSteps: 2 } });
  const { s } = await run(newHelperState({ name: '축구', mode: 'add' }), d);
  assert.equal(s.stop, 'steps');
  assert.equal(s.status, 'done');
});

/* ───── 이어 가기 ───── */

test('이어 가기: 단계마다 JSON으로 저장했다 읽어 다시 돌려도(서비스 워커 재시작) 같은 결과', async () => {
  const a = deps({ ask: fakeAsk({ plan: ['오프사이드', '억지 개념', '숫자 개념'], weak: ['억지 개념'], rewriteDrop: ['억지 개념'] }).ask });
  const r1 = await run(newHelperState({ name: '축구', mode: 'add' }), a);
  const b = deps({ ask: fakeAsk({ plan: ['오프사이드', '억지 개념', '숫자 개념'], weak: ['억지 개념'], rewriteDrop: ['억지 개념'] }).ask });
  // 한 단계마다 새 프로세스처럼: 직렬화 → 역직렬화 → 한 단계
  let s = newHelperState({ name: '축구', mode: 'add' });
  while (s.status === 'running') s = JSON.parse(JSON.stringify(await helperStep(JSON.parse(JSON.stringify(s)), b)));
  assert.deepEqual(b.writes[0].map(n => n.label), a.writes[0].map(n => n.label));
  assert.equal(s.calls, r1.s.calls);
  assert.equal(r1.saved.length, r1.s.steps, '단계마다 저장한다');
});

test('이어 가기: 평가 단계 중간 상태에서 시작해도 끝까지 간다(계획·초안을 다시 부르지 않음)', async () => {
  const f = fakeAsk();
  const d = deps({ ask: f.ask });
  const mid = {
    ...newHelperState({ name: '축구', mode: 'add' }),
    phase: 'evaluate', calls: 2, steps: 2, round: 1,
    queue: [{ id: 'u:nabc', label: '오프사이드', facts: FACT['오프사이드'].facts, tags: ['threshold_req'], target: 'threshold_req', rewrites: 0 }]
  };
  const { s } = await run(JSON.parse(JSON.stringify(mid)), d);
  assert.equal(f.log[0].k, 'evaluate');
  assert.equal(d.writes[0][0].id, 'u:nabc');
  assert.equal(s.status, 'done');
});

test('계획이 더 고를 개념이 없다고 하면 바퀴를 더 돌지 않는다', async () => {
  const f = fakeAsk({ plan: ['오프사이드'], plan2: [] });
  const d = deps({ ask: f.ask });
  await run(newHelperState({ name: '축구', mode: 'add' }), d);
  assert.equal(f.log.filter(x => x.k === 'plan').length, 2);
});

test('끝난 상태는 더 돌지 않는다', async () => {
  const f = fakeAsk();
  const d = deps({ ask: f.ask });
  const { s } = await run(newHelperState({ name: '축구', mode: 'add' }), d);
  const again = await helperStep(s, d);
  assert.equal(again, s);
  assert.equal(d.writes.length, 1);
});

test('쓰기 실패(로그아웃 등): error 상태와 문구', async () => {
  const f = fakeAsk({ plan: ['오프사이드'] });
  const d = deps({ ask: f.ask, write: async () => { throw new Error(HELPER_TEXT.loggedOut); } });
  const { s } = await run(newHelperState({ name: '축구', mode: 'add' }), d);
  assert.equal(s.status, 'error');
  assert.equal(helperView(s).stopText, HELPER_TEXT.loggedOut);
});

/* ───── 쓰기 제한 ───── */

test('helperDraftNodes: draft·미확인·u: id만 남기고 내부 필드는 버린다, u: 아닌 id는 버린다', () => {
  const out = helperDraftNodes([
    { id: 'u:a', label: 'A', facts: ['a다.'], tags: ['cooldown'], target: 'cooldown', rewrites: 1, sources: ['https://x.org'], draft: false, factsReviewed: [true] },
    { id: 'starforce', label: '공통 흉내', facts: ['x다.'], tags: ['cooldown'] }
  ]);
  assert.deepEqual(out, [{ id: 'u:a', label: 'A', facts: ['a다.'], tags: ['cooldown'], sources: ['https://x.org'], draft: true, factsReviewed: [false] }]);
});

test('mergeHelperDrafts: 기존 노드는 그대로 두고 뒤에 붙이기만, id가 겹치면 새 u: id, new면 새 관심사로', () => {
  const ov = { useCommon: true, nodes: [{ id: 'u:a', label: '내 것', facts: ['x다.'], tags: ['cooldown'] }], hiddenNodeIds: ['starforce'], feedbackBoosts: { k: 1 } };
  const before = JSON.stringify(ov);
  const next = mergeHelperDrafts(ov, [{ id: 'u:a', label: '겹침', facts: ['y다.'], tags: ['cooldown'], draft: true, factsReviewed: [false] }], { name: '축구', mode: 'add', reservedIds: common.nodes.map(n => n.id), rand: () => 0.3 });
  assert.equal(JSON.stringify(ov), before, '입력을 바꾸지 않는다');
  assert.deepEqual(next.nodes[0], ov.nodes[0]);
  assert.equal(next.nodes.length, 2);
  assert.notEqual(next.nodes[1].id, 'u:a');
  assert.ok(next.nodes[1].id.startsWith('u:'));
  assert.equal(next.nodes[1].draft, true);
  assert.deepEqual(next.hiddenNodeIds, ['starforce']);
  assert.deepEqual(next.feedbackBoosts, { k: 1 });
  assert.equal(next.useCommon, true);
  assert.deepEqual(validateOverlay(next), []);
  // 검수 전 초안은 병합 그래프에서 빠진다(규칙 1)
  const g = mergeGraphs(common, next);
  assert.ok(!g.nodes.some(n => n.id === next.nodes[1].id));

  const fresh = mergeHelperDrafts({ nodes: [] }, helperDraftNodes([{ id: 'u:b', label: 'B', facts: ['b다.'], tags: ['cooldown'] }]), { name: '축구', mode: 'new' });
  assert.equal(fresh.useCommon, false);
  assert.equal(fresh.domain, '축구');
  assert.equal(fresh.theme, 'neutral');
});

test('helperView: 진행 줄·뺀 목록·없음 태그 이름, 내부 노드 사실은 싣지 않는다', async () => {
  const f = fakeAsk({ plan: ['오프사이드', '억지 개념'], weak: ['억지 개념'], rewriteDrop: ['억지 개념'], skip: ['vendor_lock_in'] });
  const d = deps({ ask: f.ask });
  const { s } = await run(newHelperState({ name: '축구', mode: 'add' }), d);
  const v = helperView(s, TAGS);
  assert.ok(v.dropped.some(x => x.label === '억지 개념'));
  assert.ok(v.absentTags.some(t => t.id === 'vendor_lock_in' && t.label));
  assert.ok(!JSON.stringify(v).includes(FACT['오프사이드'].facts[0]));
  assert.equal(v.name, '축구');
  assert.equal(typeof v.calls, 'number');
});

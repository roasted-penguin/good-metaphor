// 노드 파이프라인 T-213: 식당 장면 초안(독립 출처 2곳 이상), 장면 출처 check, 익숙함 검사(가짜 fetch·LLM)
import test from 'node:test';
import assert from 'node:assert/strict';
import { siteKey, articleText, buildScenePrompt, sceneCandidates, draftScenes } from '../../tools/node-pipeline/scenes.mjs';
import { buildFamiliarPrompt, parseFamiliar, applyFamiliar } from '../../tools/node-pipeline/familiar.mjs';
import { BudgetError } from '../../tools/node-pipeline/tag-fit.mjs';
import { checkBatch, renderSheet, REASONS } from '../../tools/node-pipeline/check.mjs';
import { INTERESTS, loadScenes, sceneFiles } from '../../tools/node-pipeline/sources.mjs';
import { loadInterestGraph } from '../../tools/load-graph.mjs';

const rest = INTERESTS.restaurant;
const graph = loadInterestGraph('restaurant');
const tagIds = new Set(graph.tags.map(t => t.id));

test('siteKey·articleText: 사이트 = 출처 정책 site id(다음 뉴스는 한 곳, 공공은 official), 정책 밖은 null, 짧은 메뉴 줄은 버림', () => {
  assert.equal(siteKey('https://v.daum.net/v/a'), siteKey('https://v.daum.net/v/b'));
  assert.equal(siteKey('https://namu.wiki/w/x'), 'namuwiki');
  assert.equal(siteKey('https://mediahub.seoul.go.kr/archives/1'), 'official');
  assert.equal(siteKey('https://blog.naver.com/x/1'), null, '네이버 블로그는 정책 밖(RAG 금지)');
  assert.equal(siteKey('https://www.mt.co.kr/a'), null);
  assert.equal(articleText('홈\n뉴스\n점심과 저녁 사이에 문을 닫고 재료를 다시 준비하는 가게가 늘었다.\n로그인'), '점심과 저녁 사이에 문을 닫고 재료를 다시 준비하는 가게가 늘었다.');
});

test('장면 파일(T-213): 출처는 모두 출처 정책 안, 장면마다 서로 다른 사이트 2곳 이상, 장면 id 중복 없음', () => {
  assert.ok(sceneFiles('restaurant').length >= 1);
  const scenes = loadScenes('restaurant');
  assert.ok(scenes.length >= 15);
  assert.equal(new Set(scenes.map(s => s.id)).size, scenes.length);
  for (const s of scenes) {
    assert.ok(s.scene && /^[a-z][a-z0-9_]+$/.test(s.id), s.id);
    for (const u of s.sources) assert.ok(siteKey(u), `${s.id} 정책 밖 출처: ${u}`);
    assert.ok(new Set(s.sources.map(u => siteKey(u))).size >= 2, `${s.id} 출처 사이트 2곳 미만`);
  }
  assert.equal(rest.rules.familiarity, true);
  assert.equal(INTERESTS.maplestory.rules.familiarity, undefined);
});

const DOCS = [
  { n: 1, url: 'https://namu.wiki/w/x', site: 'namuwiki', title: '', text: '손님이 몰리면 자리가 모자라 온 순서대로 이름을 적고 기다린다. 앱으로 미리 줄을 설 수도 있다.' },
  { n: 2, url: 'https://v.daum.net/v/a', site: 'daumnews', title: '', text: '인기 가게는 손님이 몰려 순서대로 기다리게 하고, 앱으로 줄을 서게 한다.' },
  { n: 3, url: 'https://v.daum.net/v/b', site: 'daumnews', title: '', text: '같은 사이트의 다른 글이다. 기다리는 손님이 많다.' }
];
const scene = { id: 'waiting', scene: '인기 식당 웨이팅' };
const ans = nodes => JSON.stringify({ nodes });

test('buildScenePrompt: 장면·자료 번호·사이트, 독립 출처·수치·가게 이름 규칙, 출처 주소는 넣지 않음', () => {
  const { system, user } = buildScenePrompt({ domain: '식당', scene, docs: DOCS, tags: graph.tags, existing: [{ id: 'lunch_peak', label: '점심 피크' }] });
  assert.match(system, /서로 다른 자료 두 곳 이상/);
  assert.match(system, /특정 가게·브랜드·앱·회사 이름/);
  assert.match(system, /숫자·가격/);
  assert.match(user, /\[자료 2\] \(daumnews\)/);
  assert.match(user, /lunch_peak \| 점심 피크/);
  assert.equal(user.includes('https://'), false, '주소는 LLM에 주지 않는다(파이프라인이 붙임)');
});

test('sceneCandidates: 핵심 사실 하나가 사이트 2곳 + 전체 2곳이면 남김, 출처는 받친 자료 주소, 같은 사이트 두 글은 한 곳', () => {
  const good = sceneCandidates(ans([{ id: 'waiting_line', label: '맛집 웨이팅', tags: ['scarcity_value', 'nope'],
    facts: [{ text: '손님이 몰리면 온 순서대로 기다린다.', support: [1, 2] }, { text: '앱으로 미리 줄을 선다.', support: [1] }, { text: '받침 없는 사실이다.', support: [] }] }]), { scene, docs: DOCS, tagIds });
  assert.equal(good.candidates.length, 1);
  const c = good.candidates[0];
  assert.deepEqual(c.sources, ['https://namu.wiki/w/x', 'https://v.daum.net/v/a']);
  assert.deepEqual(c.facts, ['손님이 몰리면 온 순서대로 기다린다.', '앱으로 미리 줄을 선다.']);
  assert.equal(c.scene, 'waiting');
  assert.equal(c.weakFactsDropped, 1);
  assert.equal(c.grounding.sceneSupport[0].length, 2);
  assert.ok(c.grounding.sceneSupport[0].every(x => typeof x.overlap === 'number'));
  assert.equal(JSON.stringify(c).includes('같은 사이트의 다른 글'), false, 'D-5');
  // 같은 사이트 두 글(2·3)만 받치면 독립 출처 1곳 → 버림
  const same = sceneCandidates(ans([{ id: 'a_b', label: '가', tags: ['scarcity_value'], facts: [{ text: '가다.', support: [2, 3] }, { text: '나다.', support: [3] }] }]), { scene, docs: DOCS, tagIds });
  assert.equal(same.candidates.length, 0);
  assert.equal(same.dropped[0].reason, 'sceneUncorroborated');
  // 사이트는 둘이지만 2곳이 함께 받친 사실이 없으면 버림
  const split = sceneCandidates(ans([{ id: 'a_c', label: '나', tags: ['scarcity_value'], facts: [{ text: '가다.', support: [1] }, { text: '나다.', support: [2] }] }]), { scene, docs: DOCS, tagIds });
  assert.equal(split.dropped[0].reason, 'sceneUncorroborated');
  // 목록 안 태그 없음 → 버림, 꼴 틀림 → error
  assert.equal(sceneCandidates(ans([{ id: 'x', label: 'x', tags: ['nope'], facts: [] }]), { scene, docs: DOCS, tagIds }).dropped[0].reason, 'noTags');
  assert.equal(sceneCandidates('안 돼요', { scene, docs: DOCS, tagIds }).error, 'parse');
});

test('draftScenes: robots·실패 출처는 빼고, 사이트 2곳이 안 되면 LLM을 부르지 않음, 본문 저장 없음', async () => {
  const para = s => `<p>${s} ${'가'.repeat(220)}</p>`;
  const pages = {
    'https://namu.wiki/w/a': para('손님이 몰리면 순서대로 기다린다.'),
    'https://v.daum.net/v/a': para('인기 가게는 손님을 순서대로 기다리게 한다.'),
    'https://namu.wiki/w/b': para('혼자뿐인 출처다.')
  };
  const fetcher = { get: async url => pages[url] ? { ok: true, status: 200, url, html: pages[url] } : { ok: false, status: 403, url } };
  const users = [];
  const complete = async (system, user) => { users.push(user); return ans([{ id: 'waiting_line', label: '맛집 웨이팅', tags: ['scarcity_value'], facts: [{ text: '손님이 몰리면 순서대로 기다린다.', support: [1, 2] }, { text: '자리가 나면 차례로 들어간다.', support: [2] }] }]); };
  const scenes = [
    { id: 'waiting', scene: '웨이팅', sources: ['https://namu.wiki/w/a', 'https://v.daum.net/v/a', 'https://v.daum.net/v/gone', 'https://blog.naver.com/x/1'] },
    { id: 'lonely', scene: '혼자', sources: ['https://namu.wiki/w/b', 'https://v.daum.net/v/gone2'] }
  ];
  const r = await draftScenes({ cfg: rest, scenes, fetcher, complete, graph, tags: graph.tags, now: () => 'T' });
  assert.equal(users.length, 1, '출처 1곳 장면은 부르지 않음');
  assert.equal(r.candidates.length, 1);
  assert.deepEqual(r.pages.map(p => [p.url, p.status]), [['scene:waiting', 'ok'], ['scene:lonely', 'too-few-sources']]);
  assert.equal(r.pages[0].sources[2].status, 'fetch-403');
  assert.equal(r.pages[0].sources[3].status, 'policy', '정책 밖 주소는 가져오지 않음');
  assert.equal(JSON.stringify(r).includes('가가가가'), false, 'D-5');
});

test('check(T-213): 장면 후보 출처는 출처 정책(ADR 0016)으로 판정, 커뮤니티 사이트 2곳이면 교차 확인 통과·sourceKind community, 1곳이면 실패', async () => {
  const base = { label: '맛집 웨이팅', facts: ['손님이 몰리면 온 순서대로 기다린다.', '앱으로 미리 줄을 선다.'], tags: ['scarcity_value'] };
  const cands = [
    { ...base, id: 'scene_ok', scene: 'waiting', sources: ['https://namu.wiki/w/%EC%9B%A8%EC%9D%B4%ED%8C%85', 'https://v.daum.net/v/EYW2X9rO1I'] },
    { ...base, id: 'one_site', label: '둘째 이름', scene: 'waiting', sources: ['https://v.daum.net/v/a', 'https://v.daum.net/v/b'] },
    { ...base, id: 'off_policy', label: '셋째 이름', scene: 'waiting', sources: ['https://namu.wiki/w/x', 'https://www.mt.co.kr/a'] }
  ];
  const res = await checkBatch(cands, { cfg: rest, graph, tags: graph.tags });
  const by = Object.fromEntries(res.map(r => [r.node.id, r]));
  assert.equal(by.scene_ok.fails.includes('source'), false);
  assert.equal(by.scene_ok.fails.includes('communityUncorroborated'), false);
  assert.equal(by.scene_ok.node.sourceKind, 'community');
  assert.ok(by.one_site.fails.includes('communityUncorroborated'));
  assert.ok(by.off_policy.fails.includes('source'));
  assert.ok(REASONS.unfamiliar && REASONS.storeName && REASONS.familiarPending);
});

test('익숙함: 프롬프트·답 파싱, no면 unfamiliar 실패, 이름 들어가면 storeName, 실패 후보는 묻지 않음, 상한이면 pending', async () => {
  const { system, user } = buildFamiliarPrompt({ domain: '식당', node: { label: '간이과세', facts: ['매출이 기준 아래면 세율이 낮다.'] } });
  assert.match(system, /법 조문·세금 제도·행정 절차/);
  assert.match(system, /"familiar": "yes" 또는 "no"/);
  assert.match(user, /\[개념\] 간이과세/);
  assert.deepEqual(parseFamiliar('```json\n{"familiar":"no","reason":"세금 제도","named":"no"}\n```'), { familiar: 'no', named: 'no', reason: '세금 제도' });
  assert.equal(parseFamiliar('{"familiar":"maybe","named":"no"}'), null);
  const mk = (id, status = 'pass') => ({ status, fails: status === 'fail' ? ['x'] : [], warns: [], notes: [], node: { id, label: id, facts: ['가다.', '나다.'], tags: ['scarcity_value'] } });
  const results = [mk('tax'), mk('waiting'), mk('brand'), mk('failed', 'fail'), mk('later')];
  const answers = { tax: { familiar: 'no', named: 'no', reason: '조문' }, waiting: { familiar: 'yes', named: 'no', reason: '흔함' }, brand: { familiar: 'yes', named: 'yes', reason: '가게 이름' } };
  let calls = 0;
  const complete = async (s, u) => { calls++; const id = u.match(/\[개념\] (\w+)/)[1]; if (id === 'later') throw new BudgetError(); return JSON.stringify(answers[id]); };
  const stat = await applyFamiliar(results, { complete, domain: '식당', model: 'm' });
  assert.equal(calls, 4, '실패 후보는 묻지 않음');
  assert.deepEqual(stat, { asked: 3, yes: 2, no: 1, named: 1, pending: 1 });
  assert.deepEqual([results[0].status, results[0].fails], ['fail', ['unfamiliar']]);
  assert.equal(results[1].status, 'pass');
  assert.deepEqual(results[2].fails, ['storeName']);
  assert.deepEqual([results[4].status, results[4].warns], ['warn', ['familiarPending']]);
  const sheet = renderSheet({ interest: 'restaurant', batch: 1, results, pages: 1, generatedAt: 'T' });
  assert.match(sheet, /익숙함: no — 조문/);
  assert.match(sheet, /익숙함: 못 함\(호출 상한\)/);
});

// T-194 반자동 노드 파이프라인: robots·HTML·초안 파싱·자동 검사(수치·금칙어·태그·중복·출처·구조)·리뷰 시트
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRobots, robotsAllows, htmlToText, extractLinks, extractTitle, contentHash, politeFetcher } from '../../tools/node-pipeline/web.mjs';
import { buildPageDraftPrompt, parsePageDraft, draftCandidates, longestCommonRun, bigramOverlap } from '../../tools/node-pipeline/draft.mjs';
import { changingNumbers, structureFirst, dupIndex, checkBatch, summarize, renderSheet, sourceProber, sourceAllowed, DUP_WARN } from '../../tools/node-pipeline/check.mjs';
import { INTERESTS, contentMarkers } from '../../tools/node-pipeline/sources.mjs';
import { loadInterestGraph } from '../../tools/load-graph.mjs';

const maple = INTERESTS.maplestory, rest = INTERESTS.restaurant;
const graph = loadInterestGraph('maplestory');
const BLOCK = { terms: [{ term: '나쁜말', variants: ['나쁜 말'], status: '승인' }, { term: '보류어', status: '보류' }] };

/* ───── robots ───── */

test('robots: 메이플 실제 꼴 — /Guide 막힘, /Guide/N23GameInformation 허용(더 긴 규칙), /News 허용(규칙 없음)', () => {
  const rules = parseRobots('﻿User-agent: *\nAllow: /Guide/N23GameInformation\nAllow: /guide/n23gameinformation\nDisallow: /guide\nDisallow: /Guide\nDisallow: /Community # 주석\n');
  assert.equal(robotsAllows(rules, '/Guide/N23GameInformation/Articles/412'), true);
  assert.equal(robotsAllows(rules, '/guide/n23gameinformation/articles/Search?page=1&keyword=x'), true);
  assert.equal(robotsAllows(rules, '/Guide/CashShop/Probability'), false);
  assert.equal(robotsAllows(rules, '/Community/N23Free'), false);
  assert.equal(robotsAllows(rules, '/News/Update/816'), true);
});

test('robots: 우리 이름 그룹이 * 보다 우선, 빈 Disallow는 허용, 와일드카드·$, 콜론 앞 공백', () => {
  const txt = 'User-agent : *\nDisallow: /\n\nUser-agent: good-metaphor-node-pipeline\nDisallow: /private/*.pdf$\nDisallow:\n';
  const rules = parseRobots(txt);
  assert.equal(robotsAllows(rules, '/a'), true);
  assert.equal(robotsAllows(rules, '/private/x.pdf'), false);
  assert.equal(robotsAllows(rules, '/private/x.pdf?y'), true);
  assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow: /search.do*\n'), '/search.do?q=1'), false);
  assert.equal(robotsAllows(parseRobots('User-agent: Googlebot\nDisallow: /\n'), '/x'), true, '다른 봇 규칙만 있으면 허용');
});

/* ───── HTML ───── */

test('htmlToText: 표지 사이 본문만, 스크립트·메뉴 빼고 엔티티 풀기, 최대 길이', () => {
  const html = '<nav>메뉴</nav><div class="cv_main"><h4>[장비] 강화</h4><script>x()</script><p>메소를 써서 &amp; 강화&nbsp;한다</p></div><div class="cv_footer">꼬리</div>';
  assert.equal(htmlToText(html, { start: 'class="cv_main"', end: 'class="cv_footer"' }), '[장비] 강화\n메소를 써서 & 강화 한다');
  assert.equal(htmlToText('<p>' + 'ㄱ'.repeat(50) + '</p>', { max: 10 }).length, 10);
  assert.equal(contentHash('a'), contentHash('a'));
  assert.notEqual(contentHash('a'), contentHash('b'));
  assert.deepEqual(contentMarkers(maple, 'https://maplestory.nexon.com/news/update/1'), { start: 'class="new_board_con"', end: 'id="footer"' });
  assert.deepEqual(contentMarkers(rest, 'https://www.ftc.go.kr/x'), {});
});

test('extractLinks·extractTitle: 상대 주소를 절대로, # 조각 제거·중복 한 번, 링크 글 정리', () => {
  const html = '<title>업데이트 | 메이플</title><a href="/news/update/816?page=1"><span>\n 클라이언트 업데이트 </span></a><a href="/news/update/816?page=1#x">다시</a><a href="#top">위</a><a href="javascript:;">x</a>';
  const links = extractLinks(html, 'https://maplestory.nexon.com/News/Update');
  assert.deepEqual(links, [{ url: 'https://maplestory.nexon.com/news/update/816?page=1', text: '클라이언트 업데이트' }]);
  assert.equal(extractTitle(html), '업데이트 | 메이플');
});

test('politeFetcher: 같은 호스트는 간격을 두고, robots가 막으면 요청하지 않고, UA를 밝힌다', async () => {
  let clock = 0;
  const calls = [], sleeps = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, ua: init.headers['user-agent'] });
    if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nDisallow: /secret', { status: 200, headers: { 'content-type': 'text/plain' } });
    return new Response('<p>ok</p>', { status: 200, headers: { 'content-type': 'text/html' } });
  };
  const f = politeFetcher({ fetch: fakeFetch, now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms; }, minIntervalMs: 1000 });
  const a = await f.get('https://a.example/x');
  const b = await f.get('https://a.example/secret/1');
  const c = await f.get('https://a.example/y');
  assert.equal(a.ok, true);
  assert.equal(b.blocked, 'robots');
  assert.equal(c.ok, true);
  assert.deepEqual(calls.map(x => new URL(x.url).pathname), ['/robots.txt', '/x', '/y'], 'robots는 호스트당 한 번, 막힌 주소는 요청 안 함');
  assert.ok(calls.every(x => /good-metaphor-node-pipeline/.test(x.ua)));
  assert.deepEqual(sleeps, [1000, 1000], '호스트당 1초 간격');
  assert.equal(f.stats.robotsBlocked, 1);
});

test('politeFetcher: robots.txt가 HTML(리다이렉트)이거나 404면 규칙 없음 = 허용', async () => {
  const fakeFetch = async url => url.endsWith('/robots.txt')
    ? new Response('<html>moved</html>', { status: 200, headers: { 'content-type': 'text/html' } })
    : new Response('ok', { status: 200 });
  const f = politeFetcher({ fetch: fakeFetch, sleep: async () => {}, minIntervalMs: 0 });
  assert.equal((await f.get('https://b.example/Disallow/x')).ok, true);
});

/* ───── 초안 ───── */

test('buildPageDraftPrompt: 태그 목록·기존 개념·페이지 근거·수치 금지·관심사별 별칭 규칙', () => {
  const p = buildPageDraftPrompt({ domain: '식당', page: { url: 'u', title: '제목', text: '본문' }, tags: [{ id: 'cooldown', label: '쿨', desc: 'd' }], existing: [{ id: 'a', label: '가' }], rules: rest.rules });
  assert.match(p.system, /\[페이지\]에 적힌 내용만/);
  assert.match(p.system, /패치 판본 번호/);
  assert.match(p.system, /aliases는 항상 빈 배열/);
  assert.match(p.user, /- cooldown \| 쿨 — d/);
  assert.match(p.user, /- a \| 가/);
  assert.match(p.user, /\[페이지\] 제목\n본문$/);
  assert.match(buildPageDraftPrompt({ domain: '메이플', page: { text: '' }, tags: [], rules: maple.rules }).system, /중립적인 줄임말/);
});

test('parsePageDraft·draftCandidates: 코드블록·앞뒤 설명을 걷고, 출처는 파이프라인이 붙이고, 본문 대신 지표만', () => {
  assert.equal(parsePageDraft('모름'), null);
  assert.deepEqual(parsePageDraft('```json\n{"nodes":[{"id":"a"}]}\n```'), [{ id: 'a' }]);
  const page = { url: 'https://maplestory.nexon.com/guide/n23gameinformation/articles/1', title: '심볼' };
  const pageText = '심볼은 매일 퀘스트로 성장치를 모아 레벨을 올리는 장비다.';
  const text = '설명: {"nodes":[{"id":"symbol_x","label":"심볼","facts":["매일 퀘스트로 성장치를 모아 레벨을 올린다.",3],"tags":["daily_accumulation","daily_accumulation"],"sources":["https://evil.example"],"edges":[{"to":"meso"},{"to":"meso","rel":"비용"}]}]}';
  const { candidates } = draftCandidates(text, { page, pageText });
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  assert.deepEqual(c.sources, [page.url], 'LLM이 적은 주소는 버린다');
  assert.deepEqual(c.tags, ['daily_accumulation']);
  assert.deepEqual(c.facts, ['매일 퀘스트로 성장치를 모아 레벨을 올린다.']);
  assert.deepEqual(c.edges, [{ to: 'meso', rel: '비용' }]);
  assert.equal(c.grounding.labelInPage, true);
  assert.ok(c.grounding.factOverlap[0] > 0.8);
  assert.ok(c.grounding.copiedRun[0] >= 15);
  assert.equal(JSON.stringify(c).includes('장비다'), false, '페이지 본문 조각을 후보에 남기지 않는다');
  assert.equal(draftCandidates('엉망', { page, pageText }).error, 'parse');
});

test('longestCommonRun·bigramOverlap: 공백 무시 최장 복사 길이, 2그램 겹침 비율', () => {
  assert.equal(longestCommonRun('가나 다라마', 'xx가나다라yy'), 4);
  assert.equal(longestCommonRun('', 'a'), 0);
  assert.equal(bigramOverlap('가나다', '가나다라'), 1);
  assert.equal(bigramOverlap('하하하', '가나다'), 0);
});

/* ───── 수치·구조 ───── */

test('changingNumbers: 확률·판본·날짜·가격·레벨·횟수·그 밖 숫자를 잡고, 메이플 "6차"는 허용', () => {
  const R = maple.rules;
  assert.deepEqual(changingNumbers('성공 확률은 30%다.'), ['percent']);
  assert.deepEqual(changingNumbers('확률표를 따른다.'), ['percent']);
  assert.ok(changingNumbers('클라이언트 1.2.421 패치다.').includes('version'));
  assert.ok(changingNumbers('2026.11.19에 열린다.').includes('date'));
  assert.ok(changingNumbers('5000메소가 든다.').includes('price'));
  assert.ok(changingNumbers('최대 25성까지 오른다.').includes('level'));
  assert.ok(changingNumbers('하루 3회 할 수 있다.').includes('count'));
  assert.deepEqual(changingNumbers('구역 7에 있다.'), ['digit']);
  assert.deepEqual(changingNumbers('6차 전직은 레벨 조건이 있다.', R), []);
  assert.deepEqual(changingNumbers('6차 전직은 260레벨에 한다.', R), ['level']);
  assert.deepEqual(changingNumbers('６차 전직이다.', rest.rules), ['digit'], '식당은 차수도 안 됨(전각 숫자 포함)');
  assert.deepEqual(changingNumbers('숫자가 없다.'), []);
});

test('structureFirst: 움직임 표지가 있으면 구조, 이름 풀이만이면 아님', () => {
  assert.equal(structureFirst('별이 높아질수록 비용이 커진다.'), true);
  assert.equal(structureFirst('조건을 채우면 보상을 얻는다.'), true);
  assert.equal(structureFirst('길드 캐슬은 길드의 공간이다.'), false);
});

/* ───── 중복 ───── */

test('dupIndex: 같은 이름·포함 이름·거의 같은 글을 찾는다(대체 임베더 코사인)', () => {
  const idx = dupIndex(graph.nodes);
  const star = graph.nodes.find(n => n.id === 'starforce');
  const same = idx.nearest({ label: star.label, facts: star.facts });
  assert.equal(same.best.id, 'starforce');
  assert.ok(same.best.score > 0.99);
  assert.equal(same.same.id, 'starforce');
  assert.equal(idx.nearest({ label: '스타포스', facts: ['다른 이야기다.'] }).contains.id, 'starforce');
  const far = idx.nearest({ label: '낚시 대회', facts: ['물고기를 잡아 무게를 겨룬다.'] });
  assert.ok(far.best.score < DUP_WARN, `${far.best.id} ${far.best.score}`);
});

/* ───── 묶음 검사 ───── */

const good = (over = {}) => ({
  id: 'boss_clear_record', label: '보스 격파 기록',
  facts: ['더 강한 보스를 잡으려면 앞 단계 보스를 먼저 격파해야 한다.', '격파 기록은 캐릭터마다 따로 쌓인다.'],
  tags: ['progression_gate'], aliases: [], edges: [{ to: 'boss_entry', rel: '입장 조건과 이어짐' }],
  sources: ['https://maplestory.nexon.com/guide/n23gameinformation/articles/9'],
  grounding: { labelInPage: true, factOverlap: [0.8, 0.7], copiedRun: [6, 5] },
  ...over
});
const run = (cands, cfg = maple, extra = {}) => checkBatch(cands, { cfg, graph, tags: graph.tags, blockTerms: BLOCK, ...extra });

test('checkBatch: 깨끗한 후보는 통과, 노드 꼴(id·label·facts·tags·sources)로 정리', async () => {
  const [r] = await run([good()]);
  assert.equal(r.status, 'pass', JSON.stringify(r));
  assert.deepEqual(Object.keys(r.node), ['id', 'label', 'facts', 'tags', 'sources']);
  assert.deepEqual(r.edges, [{ to: 'boss_entry', rel: '입장 조건과 이어짐' }]);
});

test('checkBatch: 실패 사유 — id 꼴·그래프 id·이름 중복·사실 수·끝맺음·수치·금칙어·태그 없음·출처', async () => {
  const cases = [
    [good({ id: 'Bad Id' }), 'idFormat'],
    [good({ id: 'starforce' }), 'idTaken'],
    [good({ id: 'x_star', label: '스타포스 강화' }), 'labelTaken'],
    [good({ facts: ['하나뿐이다.'] }), 'factCount'],
    [good({ facts: ['더 강한 보스를 잡으려면 먼저 격파해야 함', '둘째다.'] }), 'factEnding'],
    [good({ facts: ['성공 확률은 30%로 정해진다.', '둘째다.'] }), 'number'],
    [good({ facts: ['나쁜 말이 들어가면 바뀐다.', '둘째다.'] }), 'blocked'],
    [good({ aliases: ['나쁜말'] }), 'blocked'],
    [good({ tags: ['made_up_tag'] }), 'noTags'],
    [good({ sources: ['https://namu.wiki/w/x'] }), 'source'],
    [good({ sources: ['http://maplestory.nexon.com/x'] }), 'source'],
    [good({ grounding: { labelInPage: true, factOverlap: [1, 1], copiedRun: [45, 3] } }), 'copiedHeavy']
  ];
  for (const [c, reason] of cases) {
    const [r] = await run([c]);
    assert.equal(r.status, 'fail', reason);
    assert.ok(r.fails.includes(reason), `${reason}: ${r.fails}`);
  }
  // 보류 상태 금칙어 카드는 쓰지 않는다
  assert.equal((await run([good({ facts: ['보류어가 들어가면 바뀐다.', '둘째다.'] })]))[0].fails.includes('blocked'), false);
});

test('checkBatch: 확인 사유 — 목록 밖 태그 뺌·별칭 검토·구조·근거 약함·베낌 의심·없는 엣지 뺌·비슷한 노드', async () => {
  const [r] = await run([good({
    tags: ['progression_gate', 'nope'], aliases: ['보격', 'ㄱ'.repeat(21)],
    facts: ['보스 격파 기록은 캐릭터의 기록이다.', '둘째다.'],
    edges: [{ to: 'ghost', rel: '없음' }],
    grounding: { labelInPage: false, factOverlap: [0.2, 0.9], copiedRun: [30, 2] }
  })]);
  assert.equal(r.status, 'warn', JSON.stringify(r.fails));
  for (const k of ['tagDropped', 'aliasesReview', 'aliasLong', 'structure', 'labelNotInPage', 'weakGrounding', 'copied', 'edgeDropped']) assert.ok(r.warns.includes(k), k);
  assert.deepEqual(r.node.tags, ['progression_gate']);
  assert.deepEqual(r.node.aliases, ['보격']);
  const star = graph.nodes.find(n => n.id === 'starforce');
  const [d] = await run([good({ id: 'star_copy', label: '별 강화', facts: star.facts })]);
  assert.ok(d.fails.includes('dupNear'), '사실이 같으면 거의 같은 노드');
});

test('checkBatch: 묶음 안 id·이름 중복은 뒤쪽 실패, 후보끼리 엣지 허용', async () => {
  const rs = await run([good(), good({ label: '다른 이름' }), good({ id: 'other_one', edges: [{ to: 'boss_clear_record', rel: '이어짐' }] })]);
  assert.equal(rs[0].status, 'pass');
  assert.ok(rs[1].fails.includes('idDupBatch'));
  assert.ok(rs[2].fails.includes('labelDupBatch'));
  assert.deepEqual(rs[2].edges, [{ to: 'boss_clear_record', rel: '이어짐' }]);
});

test('checkBatch 식당 규칙: 숫자·영문·이름 숫자 실패, 별칭은 빼고 확인, 공공 출처만', async () => {
  const rg = loadInterestGraph('restaurant');
  const r0 = good({ id: 'deposit_booking', label: '예약 보증금', facts: ['예약할 때 돈을 미리 맡기면 오지 않을 때 그 돈을 잃는다.', '보증금이 있으면 예약을 가볍게 깨는 손님이 줄어든다.'], tags: ['loss_risk'], edges: [], sources: ['https://www.mafra.go.kr/x'] });
  const ctx = { graph: rg, tags: rg.tags };
  assert.equal((await run([r0], rest, ctx))[0].status, 'pass');
  assert.ok((await run([{ ...r0, facts: ['POS 기계로 계산한다.', '둘째다.'] }], rest, ctx))[0].fails.includes('factLatin'));
  assert.ok((await run([{ ...r0, label: '예약 보증금 2배' }], rest, ctx))[0].fails.includes('labelDigit'));
  assert.ok((await run([{ ...r0, facts: ['예약할 때 돈을 미리 맡기면 오지 않을 때 그 돈을 잃는다.', '둘째는 3번이다.'] }], rest, ctx))[0].fails.includes('number'));
  const al = (await run([{ ...r0, aliases: ['예보금'] }], rest, ctx))[0];
  assert.ok(al.warns.includes('aliasesStripped'));
  assert.equal(al.node.aliases, undefined);
  assert.ok((await run([{ ...r0, sources: ['https://blog.naver.com/x'] }], rest, ctx))[0].fails.includes('source'));
  assert.equal(sourceAllowed('https://www.korea.kr/news/x', rest.allowHost), true);
  assert.equal(sourceAllowed('https://www.sbiz.or.kr/x', rest.allowHost), true);
});

test('sourceProber: 200만 통과, 허용 밖으로 넘어가면 실패, 같은 주소는 한 번만 묻는다', async () => {
  const asked = [];
  const fetcher = { get: async url => { asked.push(url); return url.includes('dead') ? { ok: false, status: 404 } : url.includes('moved') ? { ok: true, status: 200, redirected: true, url: 'https://elsewhere.example/' } : { ok: true, status: 200, url }; } };
  const probe = sourceProber(fetcher, maple.allowHost);
  const rs = await run([good(), good({ id: 'b_one', label: 'ㄴ', sources: ['https://maplestory.nexon.com/dead'] }), good({ id: 'c_one', label: 'ㄷ', sources: ['https://maplestory.nexon.com/moved'] }), good({ id: 'd_one', label: 'ㄹ' })], maple, { probe });
  assert.equal(rs[0].fails.includes('sourceStatus'), false);
  assert.ok(rs[1].fails.includes('sourceStatus'));
  assert.ok(rs[2].fails.includes('sourceRedirect'));
  assert.equal(asked.filter(u => u.endsWith('/9')).length, 1, '같은 출처는 한 번');
});

test('summarize·renderSheet: 상태·사유 집계, 시트에 판정·사유 문구·사실·승인 방법', async () => {
  const other = facts => ({ facts, edges: [] });
  const rs = await run([good(), good({ id: 'Bad', label: 'ㅂ', ...other(['낚시터에서 물고기를 잡으면 점수가 오른다.', '점수가 높으면 상을 받는다.']) }),
    good({ id: 'w_one', label: 'ㅈ', aliases: ['ㅈㅈ'], ...other(['요리를 반복하면 숙련도가 쌓인다.', '숙련도가 오르면 새 요리를 배운다.']) })]);
  const s = summarize(rs);
  assert.deepEqual([s.total, s.pass, s.warn, s.fail], [3, 1, 1, 1]);
  const md = renderSheet({ interest: 'maplestory', batch: 1, results: rs, pages: 2, generatedAt: 't' });
  assert.match(md, /후보 3 \(통과 1 · 확인 1 · 실패 1\)/);
  assert.match(md, /✗ id는 영문 소문자로/);
  assert.match(md, /별칭\(검토\): ㅈㅈ/);
  assert.match(md, /node-pipeline:apply -- --interest maplestory --batch 1 --approve/);
  assert.match(md, /사실 1: 더 강한 보스를/);
});

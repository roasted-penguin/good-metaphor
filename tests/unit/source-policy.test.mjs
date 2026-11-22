// 커뮤니티 출처 정책(T-212, D-8, ADR 0016): 출처 분류·교차 확인·노드 검사, 그래프 검증 sourceKind,
// 노드 파이프라인 check(교차 확인·베낌 검사·가져오기 필수)·apply 방어
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SOURCE_POLICY, classifySource, corroboration, checkNodeSources, isOfficialHost } from '../../tools/source-policy.mjs';
import { validateGraph } from '../../extension/lib/graph.js';
import { checkBatch, sourceProber, sourceTextSignals, renderSheet } from '../../tools/node-pipeline/check.mjs';
import { buildPatch, applyPatch } from '../../tools/node-pipeline/apply.mjs';
import { INTERESTS } from '../../tools/node-pipeline/sources.mjs';
import { loadInterestGraph } from '../../tools/load-graph.mjs';

const OFF = 'https://maplestory.nexon.com/Guide/N23GameInformation/Articles/412';
const NAMU = 'https://namu.wiki/w/%EC%8A%A4%ED%83%80%ED%8F%AC%EC%8A%A4';
const NAMU2 = 'https://namu.wiki/w/%EB%A9%94%EC%86%8C';
const INVEN = 'https://www.inven.co.kr/board/maple/5974/123';

/* ───── 분류 ───── */

test('classifySource: 공식·커뮤니티(허용 경로만)·https만', () => {
  assert.deepEqual(classifySource(OFF, 'maplestory'), { kind: 'official', site: 'official' });
  assert.deepEqual(classifySource(NAMU, 'maplestory'), { kind: 'community', site: 'namuwiki' });
  assert.deepEqual(classifySource(INVEN, 'maplestory'), { kind: 'community', site: 'inven' });
  assert.deepEqual(classifySource('https://www.inven.co.kr/maple/', 'maplestory'), { kind: 'community', site: 'inven' });
  for (const u of [
    'https://namu.wiki/history/x',              // robots·정책 밖 경로
    'https://namu.wiki/Search?q=x',
    'https://www.inven.co.kr/board/lineagem/1', // 다른 게임 게시판
    'https://www.inven.co.kr/search/maple',     // robots Disallow
    'https://m.inven.co.kr/board/maple/1',      // 데스크톱 주소만
    'http://namu.wiki/w/x',                     // https 아님
    'https://blog.naver.com/x',
    '아무거나'
  ]) assert.equal(classifySource(u, 'maplestory'), null, u);
  assert.equal(classifySource('https://www.mafra.go.kr/x', 'restaurant').kind, 'official');
  assert.throws(() => classifySource(OFF, 'nope'), /출처 정책에 없는 관심사/);
});

test('classifySource 식당(2026-11-23 확대): 나무위키·티스토리·브런치·다음 뉴스는 커뮤니티, 네이버 블로그·뉴스·인벤은 밖, 표준국어대사전은 공공', () => {
  const k = u => classifySource(u, 'restaurant');
  assert.deepEqual(k(NAMU), { kind: 'community', site: 'namuwiki' });
  assert.deepEqual(k('https://someone.tistory.com/123'), { kind: 'community', site: 'tistory' });
  assert.deepEqual(k('https://brunch.co.kr/@writer/12'), { kind: 'community', site: 'brunch' });
  assert.deepEqual(k('https://v.daum.net/v/20261101000000000'), { kind: 'community', site: 'daumnews' });
  assert.deepEqual(k('https://stdict.korean.go.kr/search/searchView.do?word_no=1'), { kind: 'official', site: 'official' });
  for (const u of [
    'https://blog.naver.com/someone/1',        // robots: RAG 목적 봇 접근 금지 명시
    'https://n.news.naver.com/article/001/1',  // robots: Disallow /
    'https://cafe.naver.com/x/1',
    'https://brunch.co.kr/search?q=x',         // 글 주소(/@)만
    'https://tistory.com/x',                   // 플랫폼 첫 화면은 블로그 글이 아님
    INVEN                                      // 메이플 전용
  ]) assert.equal(k(u), null, u);
});

test('isOfficialHost: 목록·초안은 공식만(커뮤니티는 수집하지 않음)', () => {
  assert.equal(isOfficialHost('maplestory.nexon.com', 'maplestory'), true);
  assert.equal(isOfficialHost('namu.wiki', 'maplestory'), false);
  assert.equal(isOfficialHost('www.inven.co.kr', 'maplestory'), false);
  assert.equal(INTERESTS.maplestory.allowHost('namu.wiki'), false, 'index가 커뮤니티 링크를 색인하지 않는다');
  assert.equal(INTERESTS.restaurant.allowHost('www.law.go.kr'), true);
  for (const l of INTERESTS.maplestory.listings) assert.ok(isOfficialHost(new URL(l.url).hostname, 'maplestory'), l.url);
});

test('정책 파일: 커뮤니티 항목마다 사이트 id·호스트·경로가 있고, 사이트 id는 겹치지 않는다', () => {
  for (const [id, p] of Object.entries(SOURCE_POLICY.interests)) {
    assert.ok(p.official.length >= 1, id);
    const sites = p.community.map(c => c.site);
    assert.equal(new Set(sites).size, sites.length, id);
    for (const c of p.community) assert.ok(c.site && (c.host || c.suffix?.startsWith('.')), JSON.stringify(c));
  }
});

/* ───── 교차 확인 ───── */

test('corroboration: 공식만 → official, 커뮤니티 + 공식 또는 서로 다른 커뮤니티 2곳 → 통과, 같은 사이트 둘은 안 됨', () => {
  const c = urls => corroboration(urls.map(u => classifySource(u, 'maplestory')));
  assert.deepEqual(c([OFF]), { sourceKind: 'official', corroborated: true, official: 1, communitySites: [] });
  assert.equal(c([NAMU]).corroborated, false);
  assert.equal(c([NAMU]).sourceKind, 'community');
  assert.equal(c([NAMU, OFF]).corroborated, true);
  assert.equal(c([NAMU, INVEN]).corroborated, true);
  assert.equal(c([NAMU, NAMU2]).corroborated, false, '나무위키 두 쪽은 독립 출처가 아니다');
  const r = urls => corroboration(urls.map(u => classifySource(u, 'restaurant')));
  assert.equal(r(['https://a.tistory.com/1', 'https://b.tistory.com/2']).corroborated, false, '티스토리 두 블로그도 한 플랫폼 = 한 곳(보수적 판정)');
  assert.equal(r(['https://a.tistory.com/1', 'https://brunch.co.kr/@w/1']).corroborated, true);
  assert.equal(r(['https://www.korea.kr/x', NAMU]).corroborated, true);
  assert.equal(c([]).corroborated, false);
});

test('checkNodeSources: 허용 밖·교차 확인 없음·sourceKind 표시 누락·잘못 표시를 잡는다', () => {
  const n = (sources, extra = {}) => ({ id: 'x', sources, ...extra });
  assert.deepEqual(checkNodeSources(n([OFF]), 'maplestory'), []);
  assert.deepEqual(checkNodeSources(n([OFF], { sourceKind: 'official' }), 'maplestory'), []);
  assert.deepEqual(checkNodeSources(n([OFF, NAMU], { sourceKind: 'community' }), 'maplestory'), []);
  assert.deepEqual(checkNodeSources(n([NAMU, INVEN], { sourceKind: 'community' }), 'maplestory'), []);
  assert.deepEqual(checkNodeSources(n([NAMU], { sourceKind: 'community' }), 'maplestory'), ['communityUncorroborated']);
  assert.deepEqual(checkNodeSources(n([NAMU, NAMU2], { sourceKind: 'community' }), 'maplestory'), ['communityUncorroborated']);
  assert.deepEqual(checkNodeSources(n([OFF, NAMU]), 'maplestory'), ['sourceKindMissing']);
  assert.deepEqual(checkNodeSources(n([OFF], { sourceKind: 'community' }), 'maplestory'), ['sourceKindMismatch']);
  assert.deepEqual(checkNodeSources(n([OFF], { sourceKind: 'wiki' }), 'maplestory'), ['sourceKindInvalid']);
  assert.deepEqual(checkNodeSources(n([OFF, 'https://blog.example/x']), 'maplestory'), ['sourceNotAllowed:https://blog.example/x']);
  assert.deepEqual(checkNodeSources(n([]), 'maplestory'), ['sourceMissing']);
  assert.deepEqual(checkNodeSources(n(['https://www.korea.kr/a', NAMU], { sourceKind: 'community' }), 'restaurant'), []);
  assert.deepEqual(checkNodeSources(n(['https://www.korea.kr/a', 'https://blog.naver.com/x/1']), 'restaurant'), ['sourceNotAllowed:https://blog.naver.com/x/1']);
});

/* ───── 그래프 검증 ───── */

test('validateGraph: sourceKind는 없거나 official·community만', () => {
  const g = kind => ({ domain: 'd', tags: [{ id: 't', label: 'l' }], nodes: [{ id: 'n', label: '라벨', facts: ['f'], tags: ['t'], sources: [OFF], verifiedAt: '2026-11-23', ...(kind === undefined ? {} : { sourceKind: kind }) }] });
  assert.deepEqual(validateGraph(g()), []);
  assert.deepEqual(validateGraph(g('official')), []);
  assert.deepEqual(validateGraph(g('community')), []);
  assert.match(validateGraph(g('namu')).join(), /sourceKind/);
});

/* ───── 파이프라인 check ───── */

const maple = INTERESTS.maplestory;
const graph = loadInterestGraph('maplestory');
const FACTS = ['길드원이 함께 기여하면 길드 단계가 오르고 혜택이 열린다.', '기여가 모자라면 다음 단계 혜택을 받을 수 없다.'];
const cand = (over = {}) => ({
  id: 'guild_level_test', label: '길드 단계 시험', facts: FACTS, tags: ['progression_gate'], aliases: [], edges: [],
  sources: [OFF], ...over
});
// 가짜 출처 페이지: 사실과 겹치는 우리 말 페이지(지지), 사실을 통째로 담은 페이지(베낌), 상관없는 페이지
const SUPPORT = '<html><body><p>길드원이 함께 기여할수록 길드의 단계가 오른다. 단계마다 혜택이 열리고, 기여가 모자라면 다음 혜택을 받을 수 없게 된다.</p></body></html>';
const COPY = `<html><body><p>${FACTS.join(' ')}</p></body></html>`;
const OTHER = '<html><body><p>요리 대회는 매주 열린다. 우승자는 모자를 받는다.</p></body></html>';
const fakeFetcher = pages => ({ get: async url => (url in pages ? { ok: true, status: 200, url, html: pages[url] } : { ok: false, status: 404, url }) });
const runCheck = (cands, probe) => checkBatch(cands, { cfg: maple, graph, tags: graph.tags, blockTerms: [], probe });

test('check: 커뮤니티 하나만이면 교차 확인 실패, 공식 + 커뮤니티면 통과하고 노드에 sourceKind community', async () => {
  const pages = { [OFF]: SUPPORT, [NAMU]: SUPPORT, [INVEN]: SUPPORT };
  const probe = sourceProber(fakeFetcher(pages), maple);
  const [a, b, c] = await runCheck([
    cand({ sources: [NAMU] }),
    cand({ id: 'guild_level_b', label: '길드 단계 둘', sources: [OFF, NAMU] }),
    cand({ id: 'guild_level_c', label: '길드 단계 셋', sources: [NAMU, INVEN] })
  ], probe);
  assert.ok(a.fails.includes('communityUncorroborated'), a.fails);
  assert.equal(a.node.sourceKind, 'community');
  assert.equal(b.fails.includes('communityUncorroborated'), false, b.fails);
  assert.equal(b.node.sourceKind, 'community');
  assert.equal(c.fails.includes('communityUncorroborated'), false, c.fails);
  assert.deepEqual(b.sourceChecks.map(x => x.kind), ['official', 'community']);
  // 결과에는 숫자·주소만, 페이지 글은 남지 않는다(D-5)
  assert.doesNotMatch(JSON.stringify([a, b, c]), /길드의 단계가 오른다/);
});

test('check: 공식만이면 sourceKind를 붙이지 않는다(기존 그래프 꼴 그대로)', async () => {
  const [r] = await runCheck([cand()], sourceProber(fakeFetcher({ [OFF]: SUPPORT }), maple));
  assert.equal(r.node.sourceKind, undefined);
  assert.equal(r.fails.length, 0, r.fails);
});

test('check: 출처 페이지를 그대로 옮기면 베낌 실패(커뮤니티·공식 모두), 25자 이상이면 확인', async () => {
  const LONG = ['길드원이 함께 기여하면 길드 단계가 차례로 오르고 단계마다 새로운 혜택이 하나씩 열리는 구조다.', FACTS[1]];
  const copyPage = `<html><body><p>${LONG[0]}</p></body></html>`;
  const [r] = await runCheck([cand({ facts: LONG, sources: [OFF, NAMU] })], sourceProber(fakeFetcher({ [OFF]: SUPPORT, [NAMU]: copyPage }), maple));
  assert.ok(r.fails.includes('copiedSourceHeavy'), r.fails);
  const [o] = await runCheck([cand({ facts: LONG })], sourceProber(fakeFetcher({ [OFF]: copyPage }), maple));
  assert.ok(o.fails.includes('copiedSourceHeavy'), '공식 출처도 그대로 옮기면 실패(우리 말로)');
  const [w] = await runCheck([cand({ sources: [OFF, NAMU] })], sourceProber(fakeFetcher({ [OFF]: SUPPORT, [NAMU]: COPY }), maple));
  assert.equal(w.fails.includes('copiedSourceHeavy'), false);
  assert.ok(w.warns.includes('copiedSource'), w.warns);
  assert.equal(sourceTextSignals(LONG, LONG[0]).copiedRun, LONG[0].replace(/\s/g, '').length);
  assert.deepEqual(sourceTextSignals(LONG, ''), { copiedRun: 0, overlap: 0 });
});

test('check: 커뮤니티 출처는 가져오기 필수(--no-probe면 실패), 못 가져오거나 robots에 막히면 실패', async () => {
  const [noProbe] = await runCheck([cand({ sources: [OFF, NAMU] })], null);
  assert.ok(noProbe.fails.includes('communityUnprobed'), noProbe.fails);
  const [officialOnly] = await runCheck([cand()], null);
  assert.equal(officialOnly.fails.includes('communityUnprobed'), false, '공식만이면 예전처럼 --no-probe 가능');
  const robots = { get: async url => (url.includes('namu') ? { ok: false, status: 0, url, blocked: 'robots' } : { ok: true, status: 200, url, html: SUPPORT }) };
  const [blocked] = await runCheck([cand({ sources: [OFF, NAMU] })], sourceProber(robots, maple));
  assert.ok(blocked.fails.includes('sourceStatus'));
  assert.ok(blocked.notes.some(n => /robots/.test(n)));
});

test('check: 사실과 겹치는 출처가 2곳이 안 되면 확인(communityWeak), 커뮤니티 노드만', async () => {
  const [r] = await runCheck([cand({ sources: [OFF, NAMU] })], sourceProber(fakeFetcher({ [OFF]: SUPPORT, [NAMU]: OTHER }), maple));
  assert.ok(r.warns.includes('communityWeak'), r.warns);
  const [ok] = await runCheck([cand({ sources: [OFF, NAMU] })], sourceProber(fakeFetcher({ [OFF]: SUPPORT, [NAMU]: SUPPORT }), maple));
  assert.equal(ok.warns.includes('communityWeak'), false, ok.warns);
  const [off] = await runCheck([cand()], sourceProber(fakeFetcher({ [OFF]: OTHER }), maple));
  assert.equal(off.warns.includes('communityWeak'), false, '공식만이면 묻지 않는다');
});

test('check: 커뮤니티 출처여도 금칙어 검사는 그대로(규칙 11)', async () => {
  const block = { terms: [{ term: '나쁜말', status: '승인' }] };
  const [r] = await checkBatch([cand({ sources: [OFF, NAMU], facts: ['나쁜말을 쓰면 단계가 오른다.', FACTS[1]] })], { cfg: maple, graph, tags: graph.tags, blockTerms: block.terms, probe: sourceProber(fakeFetcher({ [OFF]: SUPPORT, [NAMU]: SUPPORT }), maple) });
  assert.ok(r.fails.includes('blocked'), r.fails);
});

test('check: 커뮤니티 주소로 넘어가는 공식 주소는 허용 안(정책 밖으로 넘어감만 실패)', async () => {
  const f = { get: async url => ({ ok: true, status: 200, redirected: true, url: 'https://blog.example/x', html: SUPPORT }) };
  const [r] = await runCheck([cand()], sourceProber(f, maple));
  assert.ok(r.fails.includes('sourceRedirect'));
});

test('renderSheet: 커뮤니티 후보는 출처 종류와 출처별 베낌·겹침 숫자를 보여 준다', async () => {
  const rs = await runCheck([cand({ sources: [OFF, NAMU] })], sourceProber(fakeFetcher({ [OFF]: SUPPORT, [NAMU]: SUPPORT }), maple));
  const md = renderSheet({ interest: 'maplestory', batch: 1, results: rs, pages: 0, generatedAt: 't' });
  assert.match(md, /출처 종류 community/);
  assert.match(md, /출처 확인\(커뮤니티\): https:\/\/namu\.wiki\/w\/.+최장 복사 \d+자, 겹침/);
});

/* ───── apply 방어 ───── */

test('apply: sourceKind를 노드에 남기고(sources 뒤), 출처 정책을 어긴 노드는 오류로 막는다', () => {
  const tagsFile = JSON.parse(readFileSync('extension/data/common/tags.json', 'utf8'));
  const raw = JSON.parse(readFileSync('extension/data/common/maplestory.json', 'utf8'));
  const r = (id, sources, sourceKind) => ({ status: 'pass', fails: [], node: { id, label: id + ' 이름', facts: FACTS, tags: ['progression_gate'], sources, ...(sourceKind ? { sourceKind } : {}) }, edges: [] });
  const patch = buildPatch([r('comm_ok', [OFF, NAMU], 'community')], ['comm_ok'], { day: '2026-11-23' });
  assert.deepEqual(Object.keys(patch.nodes[0]), ['id', 'label', 'facts', 'tags', 'sources', 'sourceKind', 'verifiedAt']);
  assert.deepEqual(applyPatch(raw, patch, { tagsFile, day: '2026-11-23' }).errors, []);
  const bad = buildPatch([r('comm_bad', [NAMU], 'community')], ['comm_bad'], { day: '2026-11-23' });
  assert.match(applyPatch(raw, bad, { tagsFile, day: '2026-11-23' }).errors.join(), /comm_bad 출처 정책: communityUncorroborated/);
});

test('check 식당: 블로그 + 커뮤니티 교차 확인은 통과(sourceKind community), 가게 이름 확인 경고, 블로그 하나만은 실패', async () => {
  const rest = INTERESTS.restaurant;
  const rg = loadInterestGraph('restaurant');
  const BLOG = 'https://someone.tistory.com/12', BR = 'https://brunch.co.kr/@w/3';
  const facts = ['점심 손님이 한꺼번에 몰리면 자리가 비기를 기다리는 줄이 생긴다.', '자리가 빨리 비면 같은 시간에 더 많은 손님을 받는다.'];
  const page = `<p>점심때 손님이 한꺼번에 몰리면 자리가 비기를 기다리는 줄이 길어진다. 자리가 빨리 비면 같은 시간에 손님을 더 받는다.</p>`;
  const probe = sourceProber(fakeFetcher({ [BLOG]: page, [BR]: page }), rest);
  const c = (id, sources) => ({ id, label: id === 'lunch_wait' ? '점심 대기 줄' : '점심 대기 줄 둘', facts, tags: ['efficiency_metric'], aliases: [], edges: [], sources });
  const [ok, solo] = await checkBatch([c('lunch_wait', [BLOG, BR]), c('lunch_wait_b', [BLOG])], { cfg: rest, graph: rg, tags: rg.tags, blockTerms: [], probe });
  assert.equal(ok.fails.includes('communityUncorroborated'), false, ok.fails);
  assert.equal(ok.node.sourceKind, 'community');
  assert.ok(ok.warns.includes('storeNameReview'), ok.warns);
  assert.ok(solo.fails.includes('communityUncorroborated'), solo.fails);
});

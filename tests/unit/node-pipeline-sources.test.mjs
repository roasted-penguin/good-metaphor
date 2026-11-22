// T-198 식당 출처 늘리기: 법령 껍데기 → 본문 주소, class 제목, 남길 장(keep), 씨앗 확인, 새 씨앗 설정
import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, HEADING_MARK } from '../../tools/node-pipeline/web.mjs';
import { splitSections } from '../../tools/node-pipeline/draft.mjs';
import { INTERESTS, lawBodyUrl, bodyUrlFor, seedFor, contentMarkers } from '../../tools/node-pipeline/sources.mjs';
import { draftPages, probeSeeds, markProbes, pickPages } from '../../tools/node-pipeline/run.mjs';
import { loadInterestGraph } from '../../tools/load-graph.mjs';

const rest = INTERESTS.restaurant;
const LAW_SHELL = `<script>var lsVO = { lsiSeq : '285339', ancYnChk : '0' };\n var efYd = '20261008';</script><h2>식품위생법</h2>`;

test('lawBodyUrl: 껍데기의 lsiSeq·efYd로 lsInfoR 주소, lsiSeq가 없으면 null', () => {
  assert.equal(lawBodyUrl(LAW_SHELL), 'https://www.law.go.kr/LSW/lsInfoR.do?lsiSeq=285339&efYd=20261008&chrClsCd=010202&ancYnChk=0');
  assert.equal(lawBodyUrl("lsiSeq : '1'"), 'https://www.law.go.kr/LSW/lsInfoR.do?lsiSeq=1&chrClsCd=010202&ancYnChk=0');
  assert.equal(lawBodyUrl('<p>없음</p>'), null);
  assert.equal(bodyUrlFor(rest, 'https://www.law.go.kr/x', LAW_SHELL).includes('lsiSeq=285339'), true);
  assert.equal(bodyUrlFor(rest, 'https://www.nts.go.kr/x', LAW_SHELL), null, '다른 호스트는 껍데기 아님');
});

test('htmlToText headingClasses: class 제목(<p class="gtit">)도 절 표지, 없으면 그냥 줄', () => {
  const html = '<p>앞말</p><p class="gtit" style="x">  제1장 총칙 </p><p>목적</p><div class="a gtit">제2장 영업</div><p>허가</p>';
  assert.equal(htmlToText(html, { headings: true, headingClasses: ['gtit'], max: Infinity }), `앞말\n${HEADING_MARK}제1장 총칙\n목적\n${HEADING_MARK}제2장 영업\n허가`);
  assert.equal(htmlToText(html, { headings: true, max: Infinity }).includes(HEADING_MARK), false);
  assert.deepEqual(contentMarkers(rest, 'https://www.law.go.kr/LSW/lsInfoR.do?lsiSeq=1'), { headingClasses: ['gtit'] });
});

test('splitSections keep·keepSub: 맞는 장만, 하위 절은 상위 장을 따름, 제목 없는 앞부분은 버림', () => {
  const M = HEADING_MARK;
  const text = ['머리말', `${M}제1장 총칙`, '목적', `${M}제2장 영업`, '영업 허가', `${M}제1절 신고`, '신고 내용', `${M}제3장 공전`, '공전', `${M}제1절 기준`, '기준 내용'].join('\n');
  const r = splitSections(text, { mark: M, keep: /영업/, keepSub: /^제\d+절/, minChars: 0 });
  assert.deepEqual(r.sections.map(s => s.title), ['제2장 영업', '제1절 신고']);
  assert.deepEqual(r.skipped, ['(앞부분)', '제1장 총칙', '제3장 공전', '제1절 기준']);
  assert.equal(splitSections(text, { mark: M, minChars: 0 }).sections.length, 6, 'keep 없으면 예전처럼');
});

test('식당 씨앗(T-198): 허용 호스트·https·주소 중복 없음, 법령은 keep·장 단위, 출처 규칙 밖 호스트 없음', () => {
  const urls = rest.seeds.map(s => s.url);
  assert.equal(new Set(urls).size, urls.length, '씨앗 주소 중복');
  for (const s of rest.seeds) {
    const u = new URL(s.url);
    assert.equal(u.protocol, 'https:', s.url);
    assert.ok(rest.allowHost(u.hostname), `허용 밖: ${s.url}`);
  }
  const laws = rest.seeds.filter(s => s.url.startsWith('https://www.law.go.kr/'));
  assert.ok(laws.length >= 5);
  assert.ok(laws.every(s => s.kind === 'law' && s.maxSections && s.keepSub));
  assert.equal(seedFor(rest, laws[0].url), laws[0]);
  assert.equal(seedFor(rest, 'https://nope.go.kr/'), null);
  assert.ok(rest.kindOrder.includes('local'));
  assert.ok(rest.sectionSkip.test('컨텐츠 담당자 정보') && rest.sectionSkip.test('제13장 벌칙') && !rest.sectionSkip.test('제7장 영업'));
});

// 가짜 법령 사이트: 껍데기 → lsInfoR 본문(장 제목 class)
function lawFetcher(extra = {}) {
  const ch = (t, n) => `<p class="gtit">${t}</p>` + `<p>${t} 조문: 영업자는 신고를 하고 위생교육을 받은 뒤 문을 연다. ${'ㄱ'.repeat(n)}</p>`;
  const body = `<div>${ch('제1장 총칙', 300)}${ch('제7장 영업', 400)}${ch('제13장 벌칙', 300)}</div>`;
  const seen = [];
  const pages = {
    'https://www.law.go.kr/%EB%B2%95%EB%A0%B9/%EC%8B%9D%ED%92%88%EC%9C%84%EC%83%9D%EB%B2%95': LAW_SHELL,
    'https://www.law.go.kr/LSW/lsInfoR.do?lsiSeq=285339&efYd=20261008&chrClsCd=010202&ancYnChk=0': body,
    ...extra
  };
  return { seen, get: async url => { seen.push(url); return pages[url] ? { ok: true, status: 200, url, html: pages[url] } : { ok: false, status: 503, url, html: '' }; } };
}

test('draftPages(T-198): 법령 껍데기 → 본문을 한 번 더 가져와 keep 장만 초안, 출처는 껍데기 주소, 본문 저장 없음', async () => {
  const fetcher = lawFetcher();
  const url = 'https://www.law.go.kr/%EB%B2%95%EB%A0%B9/%EC%8B%9D%ED%92%88%EC%9C%84%EC%83%9D%EB%B2%95';
  const cfg = { ...rest, seeds: [{ kind: 'law', title: '법령 식품위생법', url, keep: /영업|총칙/, keepSub: /^제\d+절/, maxSections: 4 }] };
  const users = [];
  const complete = async (system, user) => { users.push(user); return JSON.stringify({ nodes: [{ id: 'open_report', label: '영업 신고', facts: ['신고를 해야 문을 연다.', '교육이 먼저다.'], tags: ['progression_gate'] }] }); };
  const graph = loadInterestGraph('restaurant');
  const r = await draftPages({ cfg, pages: [{ url, title: '법령 식품위생법' }], fetcher, complete, graph, tags: graph.tags, now: () => 'T', sectionOpts: { minChars: 100 } });
  assert.equal(fetcher.seen.length, 2, '껍데기 + 본문');
  assert.equal(users.length, 2, '총칙·영업 두 장(벌칙은 keep 밖)');
  assert.ok(users.every(u => !u.includes('벌칙 조문')));
  assert.deepEqual(r.candidates[0].sources, [url]);
  assert.equal(r.pages[0].status, 'ok');
  assert.equal(JSON.stringify(r).includes('ㄱㄱㄱ'), false, 'D-5');
  // 껍데기에 판 번호가 없으면 부르지 않음
  const bad = { get: async u => ({ ok: true, status: 200, url: u, html: '<p>점검 중</p>' }) };
  const r2 = await draftPages({ cfg, pages: [{ url, title: 'x' }], fetcher: bad, complete, graph, tags: graph.tags, now: () => 'T' });
  assert.equal(r2.pages[0].status, 'no-body');
});

test('probeSeeds·markProbes·pickPages: 죽은 씨앗 기록(법령은 본문까지), 색인에 probe, 초안 순서 맨 뒤', async () => {
  const url = 'https://www.law.go.kr/%EB%B2%95%EB%A0%B9/%EC%8B%9D%ED%92%88%EC%9C%84%EC%83%9D%EB%B2%95';
  const fetcher = lawFetcher({ 'https://www.ddm.go.kr/health/contents.do?key=1': '<p>위생</p>' });
  const cfg = { ...rest, seeds: [
    { kind: 'law', title: '식품위생법', url },
    { kind: 'law', title: '생활법령', url: 'https://www.easylaw.go.kr/x' },
    { kind: 'local', title: '보건소', url: 'https://www.ddm.go.kr/health/contents.do?key=1' }
  ] };
  const probes = await probeSeeds({ cfg, fetcher, now: () => 'T' });
  assert.deepEqual(probes.map(p => [p.ok, p.status]), [[true, 200], [false, 503], [true, 200]]);
  assert.deepEqual(probes[0].body, { ok: true, status: 200 });
  assert.ok(probes[0].chars > 500 && probes[2].chars === 2);
  assert.equal(JSON.stringify(probes).includes('ㄱㄱ'), false, '본문은 길이만');
  const entries = markProbes(cfg.seeds.map(s => ({ url: s.url, title: s.title, kind: s.kind })), probes);
  assert.deepEqual(entries[1].probe, { ok: false, status: 503, at: 'T' });
  assert.deepEqual(pickPages(entries, { kindOrder: rest.kindOrder }).map(e => e.title), ['식품위생법', '보건소', '생활법령']);
});

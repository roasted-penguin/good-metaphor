// 노드 파이프라인(T-194) 실행 층: index(목록 → 페이지 색인), draft(페이지 → LLM 후보).
// 네트워크·LLM은 주입받는다(fetcher = web.mjs politeFetcher, complete = (system, user) → 글). 파일 입출력은 cli.mjs가 한다.
import { extractLinks, htmlToText, extractTitle, contentHash, HEADING_MARK } from './web.mjs';
import { contentMarkers, bodyUrlFor, seedFor } from './sources.mjs';
import { buildPageDraftPrompt, draftCandidates, splitSections } from './draft.mjs';

// 색인 키: 메이플 공식 사이트는 경로 대소문자를 가리지 않아(/Guide·/guide) 소문자로 같은 글을 한 번만
export const indexKey = url => {
  const u = new URL(url);
  return u.hostname === 'maplestory.nexon.com' ? (u.origin + u.pathname + u.search).toLowerCase() : u.href;
};

/**
 * 목록 페이지를 읽어 상세 페이지 색인을 만든다. 본문은 읽지 않는다(제목은 목록의 링크 글).
 * @param {{ cfg, fetcher, pages?: number, now?: () => string, prev?: Array, log? }} p
 * @returns {Promise<{ entries: Array<{url,title,kind,listedAt,fetchedAt?,hash?}>, listings: number, failures: Array }>}
 *   prev(이전 색인)에 있던 항목은 fetchedAt·hash·drafted를 그대로 둔다
 */
export async function buildIndex({ cfg, fetcher, pages = 1, now = () => new Date().toISOString(), prev = [], log = () => {} }) {
  const byKey = new Map(prev.map(e => [indexKey(e.url), e]));
  const out = new Map();
  const failures = [];
  const add = (e) => {
    const k = indexKey(e.url);
    if (out.has(k)) return;
    out.set(k, { ...e, ...(byKey.get(k) ? { ...byKey.get(k), kind: e.kind, title: byKey.get(k).title || e.title } : {}) });
  };
  for (const s of cfg.seeds || []) add({ url: s.url, title: s.title || '', kind: s.kind, listedAt: now() });
  let listings = 0;
  for (const l of cfg.listings || []) {
    const n = l.paged === false || !l.url.includes('{page}') ? 1 : pages;
    for (let p = 1; p <= n; p++) {
      const url = l.url.replace('{page}', String(p));
      const r = await fetcher.get(url);
      listings++;
      if (!r.ok) { failures.push({ url, status: r.status, blocked: r.blocked || null }); log(`목록 실패 ${r.status}${r.blocked ? ' robots' : ''}: ${url}`); continue; }
      let found = 0;
      for (const found0 of extractLinks(r.html, r.url || url)) {
        const link = l.stripQuery ? { ...found0, url: found0.url.split('?')[0] } : found0;
        if (!l.linkPattern.test(link.url)) continue;
        if (cfg.titleFilter && !cfg.titleFilter.test(link.text)) continue;
        if (!cfg.allowHost(new URL(link.url).hostname)) continue;
        add({ url: link.url, title: link.text.slice(0, 120), kind: l.kind, listedAt: now() });
        found++;
      }
      log(`목록 ${url} → ${found}개`);
      if (!found) break; // 빈 쪽이면 다음 쪽은 보지 않는다
    }
  }
  return { entries: [...out.values()], listings, failures };
}

// 초안 대상 고르기: 아직 초안 안 한 페이지, kindOrder 순서, 같은 종류 안에서는 색인 순서
// pageSkip = 건너뛸 제목 정규식(T-195: 메이플 "스킬 조정" 패치는 수치 조정 목록뿐이라 절 6개에서 후보 0)
// 씨앗 확인(T-198)에서 응답하지 않은 페이지(probe.ok === false)는 맨 뒤로(다시 살아날 수 있어 빼지는 않는다)
export function pickPages(entries, { kindOrder = [], limit = 10, only, pageSkip = null } = {}) {
  const rank = k => { const i = kindOrder.indexOf(k); return i < 0 ? kindOrder.length : i; };
  const dead = e => (e.probe && e.probe.ok === false ? 1 : 0);
  return entries
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => !e.drafted && (!only || only.includes(e.kind)) && !(pageSkip && pageSkip.test(e.title || '')))
    .sort((a, b) => dead(a.e) - dead(b.e) || rank(a.e.kind) - rank(b.e.kind) || a.i - b.i)
    .slice(0, limit)
    .map(({ e }) => e);
}

/**
 * 페이지마다 본문을 가져와(메모리) 절로 나누고(T-195), 절마다 LLM에 한 번 묻고 후보를 만든다.
 * @param {{ cfg, pages, fetcher, complete, graph, tags, now?, log?, minText?, sectionOpts?, maxCalls? }} p
 *   complete = (system, user) → 글. 캐시를 씌운 함수(cli.mjs cachedComplete)면 complete.calls()가 실제 호출 수다
 *   maxCalls = 이번 실행 LLM 호출 상한(캐시 적중은 안 셈, complete.calls()로 센다. 없으면 절 수로 센다)
 * @returns {Promise<{ candidates, dropped, pages: Array<{url, title, status, hash?, fetchedAt?, count, sections?, skipped?, overflow?, dropped?, error?}> }>}
 *   pages는 색인 갱신용(본문 없음). 본문이 너무 짧으면(minText) LLM을 부르지 않는다(할당량 절약).
 *   status 'budget'은 호출 상한에 걸려 다 못 한 페이지(다음 실행에 다시, 이미 한 절은 캐시로 공짜)
 */
export async function draftPages({ cfg, pages, fetcher, complete, graph, tags, now = () => new Date().toISOString(), log = () => {}, minText = 200, sectionOpts = {}, maxCalls = Infinity }) {
  const candidates = [], dropped = [], report = [];
  const existing = graph.nodes.map(n => ({ id: n.id, label: n.label }));
  const tagIds = new Set((tags || []).map(t => t.id));
  let used = 0;
  const spent = () => (typeof complete.calls === 'function' ? complete.calls() : used);
  let stop = false;
  for (const page of pages) {
    if (stop) break;
    if (spent() >= maxCalls) { log('호출 상한에 닿아 멈춤'); break; }
    let r = await fetcher.get(page.url);
    if (!r.ok) { report.push({ url: page.url, title: page.title, status: r.blocked ? 'robots' : 'fetch-' + r.status, count: 0 }); log(`가져오기 실패: ${page.url}`); continue; }
    const title = page.title || extractTitle(r.html);
    // 껍데기 페이지(법령)는 본문 주소를 한 번 더 가져온다(T-198). 출처는 껍데기 주소 그대로
    const bodyUrl = bodyUrlFor(cfg, page.url, r.html);
    if (!bodyUrl && cfg.bodyFrom?.some(b => b.host === new URL(page.url).hostname)) {
      report.push({ url: page.url, title, status: 'no-body', count: 0 }); log(`본문 주소를 못 찾음: ${page.url}`); continue;
    }
    if (bodyUrl) {
      r = await fetcher.get(bodyUrl);
      if (!r.ok) { report.push({ url: page.url, title, status: r.blocked ? 'robots' : 'body-' + r.status, count: 0 }); log(`본문 가져오기 실패: ${bodyUrl}`); continue; }
    }
    const seed = seedFor(cfg, page.url);
    const seedOpts = seed ? Object.fromEntries(['keep', 'keepSub', 'maxSections'].filter(k => seed[k] != null).map(k => [k, seed[k]])) : {};
    let text = htmlToText(r.html, { ...contentMarkers(cfg, bodyUrl || page.url), headings: true, max: Infinity });
    // 해시는 본문 전체(T-195부터 제목 표지 포함, 잘림 없음)
    const meta = { url: page.url, title, hash: contentHash(text), fetchedAt: now() };
    if (text.length < minText) { report.push({ ...meta, status: 'short', count: 0 }); log(`본문이 짧아 건너뜀(${text.length}자): ${page.url}`); text = null; continue; }
    let { sections, skipped, overflow } = splitSections(text, { mark: HEADING_MARK, skip: cfg.sectionSkip || null, ...sectionOpts, ...seedOpts });
    text = null;
    // 건너뛸 절을 빼고 나니 남은 절이 너무 짧으면 부르지 않는다
    const tiny = sections.filter(x => x.text.length < minText);
    sections = sections.filter(x => x.text.length >= minText);
    skipped = [...skipped, ...tiny.map(x => x.title || '(짧은 절)')];
    const pageRow = { ...meta, status: 'ok', count: 0, sections: sections.length, skipped: skipped.length, overflow, dropped: 0 };
    if (!sections.length) { report.push({ ...pageRow, status: 'short' }); log(`건너뛸 절만 있음: ${page.url}`); continue; }
    for (const sec of sections) {
      if (spent() >= maxCalls) { pageRow.status = 'budget'; log(`호출 상한: ${page.url} 남은 절은 다음에`); stop = true; break; }
      const section = sections.length > 1 || sec.title ? sec.title : '';
      const { system, user } = buildPageDraftPrompt({ domain: cfg.domain, page: { url: page.url, title, section, text: sec.text }, tags, existing, rules: cfg.rules });
      let answer;
      used++;
      try { answer = await complete(system, user); } catch (e) {
        pageRow.status = 'llm-error'; pageRow.error = String(e.message || e).slice(0, 160);
        log(`LLM 오류: ${page.url} ${String(e.message || e).slice(0, 120)}`);
        if (e.status === 429) stop = true; // 할당량이면 더 부르지 않는다
        break;
      }
      const res = draftCandidates(answer, { page: { url: page.url, title, section }, pageText: sec.text, tagIds });
      sec.text = null; // 본문은 여기서 버린다(D-5)
      if (res.error) pageRow.parseErrors = (pageRow.parseErrors || 0) + 1;
      candidates.push(...res.candidates);
      dropped.push(...res.dropped);
      pageRow.count += res.candidates.length;
      pageRow.dropped += res.dropped.length;
      // 같은 페이지 다음 절이 같은 개념을 다시 내지 않게
      for (const c of res.candidates) if (c.id) existing.push({ id: c.id, label: c.label });
      log(`초안 ${res.candidates.length}개(버림 ${res.dropped.length}): ${title}${section ? ' — ' + section.slice(0, 40) : ''}`);
    }
    sections = null;
    if (pageRow.status === 'ok' && pageRow.parseErrors === pageRow.sections) pageRow.status = 'parse-error';
    report.push(pageRow);
  }
  return { candidates, dropped, pages: report };
}

/**
 * 씨앗 확인(T-198): 씨앗마다 한 번 가져와(robots·1초 1번은 fetcher가) 살아 있는지만 본다. 본문은 길이만 세고 버린다(D-5).
 * 껍데기 페이지(법령)는 본문 주소까지 확인한다.
 * @returns {Promise<Array<{ url, title, kind, ok, status, blocked?, body?: { ok, status }, chars?, at }>>}
 */
export async function probeSeeds({ cfg, fetcher, now = () => new Date().toISOString(), log = () => {} }) {
  const out = [];
  for (const s of cfg.seeds || []) {
    const r = await fetcher.get(s.url);
    const row = { url: s.url, title: s.title || '', kind: s.kind, ok: !!r.ok, status: r.status, at: now() };
    if (r.blocked) row.blocked = r.blocked;
    if (r.ok) {
      let html = r.html;
      const bodyUrl = bodyUrlFor(cfg, s.url, html);
      if (bodyUrl) {
        const b = await fetcher.get(bodyUrl);
        row.body = { ok: !!b.ok, status: b.status };
        row.ok = !!b.ok;
        html = b.ok ? b.html : '';
      } else if (cfg.bodyFrom?.some(x => x.host === new URL(s.url).hostname)) {
        row.body = { ok: false, status: 'no-body-url' }; row.ok = false; html = '';
      }
      row.chars = html ? htmlToText(html, { ...contentMarkers(cfg, bodyUrl || s.url), max: Infinity }).length : 0;
    }
    log(`${row.ok ? '살아 있음' : '응답 없음'} ${row.status}${row.body ? ' 본문 ' + row.body.status : ''}${row.blocked ? ' robots' : ''}: ${s.title || s.url}`);
    out.push(row);
  }
  return out;
}

// 확인 결과를 색인 항목에 probe로 붙인다(상태·시각만)
export function markProbes(entries, probes) {
  const by = new Map(probes.map(p => [indexKey(p.url), p]));
  return entries.map(e => {
    const p = by.get(indexKey(e.url));
    return p ? { ...e, probe: { ok: p.ok, status: p.status, ...(p.body ? { body: p.body.status } : {}), ...(p.blocked ? { blocked: p.blocked } : {}), at: p.at } } : e;
  });
}

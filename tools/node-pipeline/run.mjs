// 노드 파이프라인(T-194) 실행 층: index(목록 → 페이지 색인), draft(페이지 → LLM 후보).
// 네트워크·LLM은 주입받는다(fetcher = web.mjs politeFetcher, complete = (system, user) → 글). 파일 입출력은 cli.mjs가 한다.
import { extractLinks, htmlToText, extractTitle, contentHash } from './web.mjs';
import { contentMarkers } from './sources.mjs';
import { buildPageDraftPrompt, draftCandidates } from './draft.mjs';

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
export function pickPages(entries, { kindOrder = [], limit = 10, only } = {}) {
  const rank = k => { const i = kindOrder.indexOf(k); return i < 0 ? kindOrder.length : i; };
  return entries
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => !e.drafted && (!only || only.includes(e.kind)))
    .sort((a, b) => rank(a.e.kind) - rank(b.e.kind) || a.i - b.i)
    .slice(0, limit)
    .map(({ e }) => e);
}

/**
 * 페이지마다 본문을 가져와(메모리) LLM에 한 번 묻고 후보를 만든다.
 * @param {{ cfg, pages, fetcher, complete, graph, tags, now?, log?, minText? }} p
 * @returns {Promise<{ candidates, pages: Array<{url, title, status, hash?, fetchedAt?, count, error?}> }>}
 *   pages는 색인 갱신용(본문 없음). 본문이 너무 짧으면(minText) LLM을 부르지 않는다(할당량 절약)
 */
export async function draftPages({ cfg, pages, fetcher, complete, graph, tags, now = () => new Date().toISOString(), log = () => {}, minText = 200 }) {
  const candidates = [], report = [];
  const existing = graph.nodes.map(n => ({ id: n.id, label: n.label }));
  for (const page of pages) {
    const r = await fetcher.get(page.url);
    if (!r.ok) { report.push({ url: page.url, title: page.title, status: r.blocked ? 'robots' : 'fetch-' + r.status, count: 0 }); log(`가져오기 실패: ${page.url}`); continue; }
    let text = htmlToText(r.html, contentMarkers(cfg, page.url));
    const title = page.title || extractTitle(r.html);
    const meta = { url: page.url, title, hash: contentHash(text), fetchedAt: now() };
    if (text.length < minText) { report.push({ ...meta, status: 'short', count: 0 }); log(`본문이 짧아 건너뜀(${text.length}자): ${page.url}`); text = null; continue; }
    const { system, user } = buildPageDraftPrompt({ domain: cfg.domain, page: { url: page.url, title, text }, tags, existing, rules: cfg.rules });
    let answer;
    try { answer = await complete(system, user); } catch (e) {
      report.push({ ...meta, status: 'llm-error', count: 0, error: String(e.message || e).slice(0, 160) });
      log(`LLM 오류: ${page.url} ${String(e.message || e).slice(0, 120)}`);
      if (e.status === 429) break; // 할당량이면 더 부르지 않는다
      continue;
    }
    const { candidates: cs, error } = draftCandidates(answer, { page: { url: page.url, title }, pageText: text });
    text = null; // 본문은 여기서 버린다(D-5)
    candidates.push(...cs);
    report.push({ ...meta, status: error ? 'parse-error' : 'ok', count: cs.length });
    log(`초안 ${cs.length}개: ${title} (${page.url})`);
  }
  return { candidates, pages: report };
}

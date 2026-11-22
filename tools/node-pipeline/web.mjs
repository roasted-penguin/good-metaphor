// 노드 파이프라인(T-194) 웹 층: robots.txt·예의 바른 가져오기·HTML → 글·링크·제목·해시.
// 원칙(D-5): 페이지 본문은 메모리에만 둔다. 디스크(.tmp)에 남기는 것은 URL·제목·가져온 시각·본문 해시뿐이다.
// fetch는 주입받는다(테스트는 가짜 fetch). 순수 함수는 단위 테스트가 직접 부른다.
import { createHash } from 'node:crypto';

export const USER_AGENT = 'good-metaphor-node-pipeline/0.1 (+https://github.com/roasted-penguin/good-metaphor; analogy-graph research, 1 req/s)';
export const MIN_INTERVAL_MS = 1100; // 호스트마다 1초에 1번 이하(여유 0.1초)
export const MAX_TEXT = 12000;       // LLM에 넘기는 본문 최대 글자 수

/* ───── robots.txt ───── */

// robots.txt 글 → 우리 UA(또는 *)에 걸리는 규칙 목록 [{ allow, path }]. 우리 이름 그룹이 있으면 그것, 없으면 *
export function parseRobots(text, agent = 'good-metaphor-node-pipeline') {
  const groups = [];
  let cur = null, lastWasAgent = false;
  for (const raw of String(text || '').replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === 'allow' || key === 'disallow') {
      // "Disallow:" 빈 값은 아무것도 막지 않는다. 절대 URL로 적은 경로는 경로 부분만
      let path = val;
      if (/^https?:\/\//i.test(path)) { try { path = new URL(path).pathname; } catch { continue; } }
      if (path) cur.rules.push({ allow: key === 'allow', path });
    }
  }
  const mine = groups.filter(g => g.agents.some(a => a !== '*' && agent.toLowerCase().includes(a)));
  const pick = mine.length ? mine : groups.filter(g => g.agents.includes('*'));
  return pick.flatMap(g => g.rules);
}

// 규칙 경로(* 와일드카드, 끝 $)를 정규식으로
function ruleRegex(path) {
  const anchored = path.endsWith('$');
  const body = (anchored ? path.slice(0, -1) : path).split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp('^' + body + (anchored ? '$' : ''));
}

// 가장 긴 규칙이 이긴다. 길이가 같으면 Allow. 맞는 규칙이 없으면 허용 (RFC 9309)
export function robotsAllows(rules, pathWithQuery) {
  let best = null;
  for (const r of rules) {
    if (!ruleRegex(r.path).test(pathWithQuery)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

/* ───── HTML ───── */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// <title> 또는 og:title. 사이트 꼬리(" | 메이플스토리")는 남겨 둔다(목록 제목이 우선)
export function extractTitle(html) {
  const og = String(html).match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i);
  const t = og?.[1] || String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
  return decodeEntities(t).replace(/\s+/g, ' ').trim();
}

// 본문 구역 자르기: start 표지 뒤 ~ end 표지 앞. 표지가 없으면 전체
export function sliceBetween(html, start, end) {
  let s = String(html);
  if (start) {
    const i = s.indexOf(start);
    if (i >= 0) {
      s = s.slice(i);
      // 표지가 태그 속성(class="…")이면 그 태그 끝(>) 뒤부터
      if (!start.startsWith('<')) { const gt = s.indexOf('>'); if (gt >= 0) s = s.slice(gt + 1); }
    }
  }
  if (end) {
    let j = s.indexOf(end);
    // 표지가 태그 속성이면 그 태그 시작(<) 앞까지
    if (j > 0 && !end.startsWith('<')) { const lt = s.lastIndexOf('<', j); if (lt >= 0) j = lt; }
    if (j > 0) s = s.slice(0, j);
  }
  return s;
}

// HTML → 읽을 글. script·style·nav·header·footer·form을 통째로 빼고 블록 태그는 줄바꿈
// headings면 h1~h3 제목을 "§§ 제목" 한 줄로 남긴다(T-195: 긴 패치 노트를 절 단위로 나누는 표지, draft.mjs splitSections)
export const HEADING_MARK = '§§ ';
// headingClasses: h 태그 대신 class로 제목을 다는 사이트(T-198: 국가법령정보센터 장 제목 <p class="gtit">)도 같은 표지로
export function htmlToText(html, { start, end, max = MAX_TEXT, headings = false, headingClasses = [] } = {}) {
  let s = sliceBetween(html, start, end)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|nav|header|footer|form|select|svg|iframe)\b[\s\S]*?<\/\1>/gi, ' ');
  if (headings && headingClasses.length) {
    const cls = headingClasses.map(c => c.replace(/[^\w-]/g, '')).join('|');
    const re = new RegExp(`<(p|div|span|strong)\\b[^>]*class=["'][^"']*\\b(?:${cls})\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/\\1>`, 'gi');
    s = s.replace(re, (m, tag, inner) => `<h2>${inner}</h2>`);
  }
  if (headings) {
    s = s.replace(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (m, n, inner) => {
      const t = decodeEntities(inner.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
      return t ? `\n${HEADING_MARK}${t}\n` : ' ';
    });
  }
  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|dt|dd|section|article|table|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s).replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();
  return s.length > max ? s.slice(0, max) : s;
}

// 링크 [{ url, text }]. base로 절대 주소, # 조각 제거, 같은 주소는 한 번
export function extractLinks(html, base) {
  const out = [], seen = new Set();
  const re = /<a\b[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (let m; (m = re.exec(String(html))); ) {
    let url;
    try { url = new URL(decodeEntities(m[1]), base); } catch { continue; }
    if (!/^https?:$/.test(url.protocol)) continue;
    url.hash = '';
    const key = url.href;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url: key, text: decodeEntities(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() });
  }
  return out;
}

export const contentHash = text => 'sha256:' + createHash('sha256').update(String(text)).digest('hex').slice(0, 16);

/* ───── 예의 바른 가져오기 ───── */

/**
 * 호스트마다 간격을 두고, robots.txt를 지키고, 우리 UA를 밝히는 가져오기.
 * @param {{ fetch?, sleep?, now?, minIntervalMs?, userAgent?, log? }} opts  테스트는 fetch·sleep·now를 바꾼다
 * @returns {{ get(url) → { ok, status, url, html, redirected, blocked? }, allowed(url), stats }}
 */
export function politeFetcher({ fetch: f = globalThis.fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now,
  minIntervalMs = MIN_INTERVAL_MS, userAgent = USER_AGENT, log = () => {} } = {}) {
  const last = new Map();      // host → 마지막 요청 시각
  const robots = new Map();    // origin → Promise<rules>
  const stats = { requests: 0, robotsBlocked: 0 };

  async function wait(host) {
    const t = last.get(host);
    if (t !== undefined) {
      const gap = t + minIntervalMs - now();
      if (gap > 0) await sleep(gap);
    }
    last.set(host, now());
  }

  async function raw(url) {
    const u = new URL(url);
    await wait(u.host);
    stats.requests++;
    const res = await f(url, { headers: { 'user-agent': userAgent, accept: 'text/html,text/plain;q=0.9,*/*;q=0.5' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    return res;
  }

  function rulesFor(origin) {
    if (!robots.has(origin)) {
      robots.set(origin, (async () => {
        try {
          const res = await raw(origin + '/robots.txt');
          const type = res.headers?.get?.('content-type') || '';
          // 없거나(404) robots가 아닌 HTML이 오면(리다이렉트 등) 규칙 없음 = 허용
          if (!res.ok || /html/i.test(type)) return [];
          return parseRobots(await res.text());
        } catch (e) { log(`robots.txt 실패(${origin}): ${e.message} → 규칙 없음으로`); return []; }
      })());
    }
    return robots.get(origin);
  }

  async function allowed(url) {
    const u = new URL(url);
    return robotsAllows(await rulesFor(u.origin), u.pathname + u.search);
  }

  async function get(url) {
    if (!(await allowed(url))) { stats.robotsBlocked++; return { ok: false, status: 0, url, blocked: 'robots', html: '' }; }
    try {
      const res = await raw(url);
      const html = res.ok ? await res.text() : '';
      return { ok: res.ok, status: res.status, url: res.url || url, redirected: !!res.redirected, html };
    } catch (e) {
      return { ok: false, status: 0, url, error: e.message, html: '' };
    }
  }

  return { get, allowed, stats };
}

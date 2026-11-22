// 노드 파이프라인(T-194) 초안 층: 공식 페이지 한 장 → LLM → 후보 개념 목록.
// T-301 AI 초안 프롬프트(lib/prompt.js buildDraftPrompt)와 같은 꼴(번호 규칙 + 태그 목록 + JSON 형식)에,
// "이 페이지에 적힌 것만" 규칙과 영문 id·별칭·엣지 칸을 더했다. 결과는 믿지 않고 check가 다시 검사한다.
// 페이지 본문은 이 호출 동안 메모리에만 있다(D-5). 후보에 남기는 것은 우리 문장(사실)과 겹침 지표(숫자)뿐이다.

export const PAGE_DRAFT_LIMITS = { min: 1, max: 6, label: 40, facts: [2, 3], fact: 200, tags: 3, aliases: 3, edges: 2 };

/**
 * @param {{ domain, page: { url, title, text }, tags: Array<{id,label,desc}>, existing: Array<{id,label}>, rules }} p
 * @returns {{ system, user }}
 */
export function buildPageDraftPrompt({ domain, page, tags, existing = [], rules = {} }) {
  const L = PAGE_DRAFT_LIMITS;
  const system = [
    `너는 "${domain}"의 공식 자료 한 페이지를 읽고, 그 페이지가 설명하는 개념을 개념 노드로 정리하는 도우미다. 이 노드는 나중에 낯선 문장을 ${domain}에 빗대 설명할 때 근거로 쓰인다.`,
    '규칙:',
    `1. [페이지]에 실제로 설명된 개념만 0~${L.max}개 고른다. 한 페이지(또는 절)가 여러 시스템·규칙·재화·제약을 설명하면 빠뜨리지 말고 각각 따로 고른다(보통 2~5개, 큰 시스템 하나보다 움직이는 규칙 단위로). 이벤트 일정·점검 시간·보상 목록처럼 금방 사라지는 내용은 개념이 아니다. 고를 게 없으면 빈 목록을 낸다.`,
    `2. 개념마다 id(영문 소문자·숫자·밑줄, 2~40자), label(한국어 이름, ${L.label}자 이내), facts(사실 ${L.facts[0]}~${L.facts[1]}개, 각 ${L.fact}자 이내), tags(추상 태그 id 1~${L.tags}개)를 적는다.`,
    '3. tags에는 아래 [추상 태그] 목록의 id만 쓴다. 목록 밖 태그는 쓰지 않는다. 맞는 태그가 없는 개념은 넣지 않는다.',
    '4. 사실은 [페이지]에 적힌 내용만 근거로 한다. 페이지에 없는 것은 아무리 널리 알려졌어도 쓰지 않는다.',
    '5. 페이지 문장을 그대로 옮기지 말고 우리 말로 다시 쓴다(원문 복사 금지).',
    '6. 자주 바뀌는 수치(확률·가격·최대 단계·레벨·횟수·날짜·패치 판본 번호)는 쓰지 않는다. 숫자 대신 구조와 규칙을 쓴다.',
    '7. 첫 사실은 그 개념이 어떻게 움직이는지(무엇이 무엇에 따라 어떻게 바뀌는가, 무엇을 해야 무엇이 되는가)를 쓴다. 이름만 풀어 쓴 정의로 시작하지 않는다.',
    '8. facts는 한국어 평서문("~다.") 한 문장씩 쓴다.',
    '9. 실존 인물의 이름·별명과 커뮤니티 멸칭은 쓰지 않는다.',
    rules.allowAliases
      ? `10. aliases에는 사람들이 그 개념을 부르는 중립적인 줄임말·은어를 페이지와 상관없이 0~${L.aliases}개 적을 수 있다(사람이 검토한다). 모르면 빈 배열.`
      : '10. aliases는 항상 빈 배열이다.',
    `11. edges에는 [이미 있는 개념] 또는 이번 목록의 다른 개념과의 관계를 0~${L.edges}개, {"to": id, "rel": "짧은 동사구"}로 적는다.`,
    '12. [이미 있는 개념]과 같은 개념은 다시 내지 않는다.',
    '13. JSON 객체만 출력한다. 형식: {"nodes": [{"id": string, "label": string, "facts": [string], "tags": [string], "aliases": [string], "edges": [{"to": string, "rel": string}]}]}'
  ].join('\n');
  const user = [
    `관심사: ${domain}`,
    '',
    '[추상 태그]',
    ...(tags || []).map(t => `- ${t.id} | ${t.label} — ${t.desc || ''}`),
    '',
    '[이미 있는 개념]',
    ...existing.map(n => `- ${n.id} | ${n.label}`),
    '',
    `[페이지] ${page.title || ''}${page.section ? ` — [절] ${page.section}` : ''}`,
    page.text
  ].join('\n');
  return { system, user };
}

// 코드블록·앞뒤 설명을 걷어 내고 nodes 배열을 뽑는다. 못 읽으면 null
export function parsePageDraft(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const tries = [cleaned];
  for (const [o, c] of [['{', '}'], ['[', ']']]) {
    const a = cleaned.indexOf(o), b = cleaned.lastIndexOf(c);
    if (a >= 0 && b > a) tries.push(cleaned.slice(a, b + 1));
  }
  for (const t of tries) {
    try {
      const v = JSON.parse(t);
      if (Array.isArray(v)) return v;
      if (Array.isArray(v?.nodes)) return v.nodes;
    } catch {}
  }
  return null;
}

/* ───── 페이지 근거 지표 (본문은 남기지 않고 숫자만) ───── */

const norm = s => String(s ?? '').normalize('NFKC').replace(/\s+/g, '');

// 두 글의 가장 긴 공통 부분 문자열 길이(공백 뺀 기준). 사실이 원문을 베꼈는지 본다(D-5)
export function longestCommonRun(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  let best = 0;
  let prev = new Uint16Array(y.length + 1);
  for (let i = 1; i <= x.length; i++) {
    const cur = new Uint16Array(y.length + 1);
    for (let j = 1; j <= y.length; j++) {
      if (x[i - 1] === y[j - 1]) { cur[j] = prev[j - 1] + 1; if (cur[j] > best) best = cur[j]; }
    }
    prev = cur;
  }
  return best;
}

// 사실의 글자 2그램 중 페이지에도 있는 비율(0~1). 낮으면 페이지 밖 지식일 수 있다
export function bigramOverlap(fact, pageText) {
  const f = norm(fact), p = norm(pageText);
  if (f.length < 2) return 0;
  const pg = new Set();
  for (let i = 0; i + 2 <= p.length; i++) pg.add(p.slice(i, i + 2));
  let hit = 0, all = 0;
  for (let i = 0; i + 2 <= f.length; i++) { all++; if (pg.has(f.slice(i, i + 2))) hit++; }
  return all ? Math.round((hit / all) * 100) / 100 : 0;
}

/* ───── 이름 핵심 낱말 (T-205, 조문 꼴 본문) ───── */

// 법령 본문은 "제40조(건강진단)"처럼 짧은 조 제목 + 조문이라, LLM이 지은 이름("건강진단과 종사 자격 제한")이 그대로 나오는 일이
// 거의 없다(T-198 법령 후보 38개 중 30개가 "이름이 본문에 없음"). 그래서 이름을 핵심 낱말로 쪼개 본문·장 제목·조 제목에서 따로 찾는다.
// 끝 조사는 이름에 흔한 것만 뗀다(과·와·의·및·을·를·에서·으로). 이·가·은·는·로·에는 낱말 끝(평가·회의·경로)과 헷갈려 두지 않는다
const LABEL_PARTICLE = /(과|와|의|을|를|에서|으로)$/;
// "의"·"과"로 끝나는 흔한 낱말(심의·협의·부과·초과…)은 조사가 아니다
const LABEL_KEEP_END = /(심의|협의|회의|합의|동의|주의|정의|논의|건의|이의|결의|부과|통과|초과|경과|결과|효과|성과|마을)$/;
const LABEL_STOP = new Set(['및', '등', '또는', '그', '이', '저']);
export function labelNouns(label) {
  const toks = String(label ?? '').normalize('NFKC').split(/[\s·・,，/()（）[\]「」'"“”]+/).filter(Boolean);
  const out = [];
  for (let t of toks) {
    if (t.length >= 3 && !LABEL_KEEP_END.test(t)) t = t.replace(LABEL_PARTICLE, '');
    if (t.length < 2 || LABEL_STOP.has(t) || out.includes(t)) continue;
    out.push(t);
  }
  return out;
}

// 낱말이 글에 있는가(공백 무시). 붙여 쓴 긴 낱말(4자 이상)은 앞뒤 반쪽이 모두 있으면 있다고 본다("갱신요구권" ↔ "계약갱신 요구권")
export function nounIn(noun, normText) {
  const n = norm(noun);
  if (!n) return false;
  if (normText.includes(n)) return true;
  if (n.length < 4) return false;
  const h = Math.floor(n.length / 2);
  return normText.includes(n.slice(0, h)) && normText.includes(n.slice(h));
}

// 조 제목: "제40조(건강진단)", "제12조의2 (영업지역의 보호)" → [{ no: '제40조', title: '건강진단' }]
const ARTICLE_RE = /제\s*(\d+)\s*조(?:\s*의\s*(\d+))?\s*[(（]([^)）]{1,40})[)）]/g;
export function articleTitles(text) {
  const out = [];
  for (const m of String(text ?? '').normalize('NFKC').matchAll(ARTICLE_RE)) out.push({ no: `제${m[1]}조${m[2] ? '의' + m[2] : ''}`, title: m[3].trim() });
  return out;
}

/**
 * 이름 핵심 낱말이 본문·제목(절·장 제목 + 조 제목)에 얼마나 있는가. 숫자와 조 번호만 남긴다(D-5)
 * @returns {{ nouns:number, inPage:number, inTitles:number, article:string|null, articleHits:number }}
 *   article = 이름 낱말을 가장 많이 담은 조 제목의 조 번호(1개 이상일 때), articleHits = 그 조 제목에 든 낱말 수
 */
export function labelSignals(label, pageText, sectionTitle = '') {
  const nouns = labelNouns(label);
  const body = norm(pageText);
  const arts = articleTitles(pageText);
  const titles = norm([sectionTitle, ...arts.map(a => a.title)].join(' '));
  let article = null, articleHits = 0;
  for (const a of arts) {
    const t = norm(a.title);
    const hits = nouns.filter(n => nounIn(n, t)).length;
    if (hits > articleHits) { article = a.no; articleHits = hits; }
  }
  return {
    nouns: nouns.length,
    inPage: nouns.filter(n => nounIn(n, body)).length,
    inTitles: nouns.filter(n => nounIn(n, titles)).length,
    article,
    articleHits
  };
}

// 후보 하나의 근거 지표. 본문 없이도 check가 판단할 수 있게 숫자만 담는다
export function groundingSignals(item, pageText, sectionTitle = '') {
  const label = String(item?.label ?? '');
  const facts = Array.isArray(item?.facts) ? item.facts.filter(f => typeof f === 'string') : [];
  return {
    labelInPage: !!label && norm(pageText).includes(norm(label)),
    labelNouns: labelSignals(label, pageText, sectionTitle),
    factOverlap: facts.map(f => bigramOverlap(f, pageText)),
    copiedRun: facts.map(f => longestCommonRun(f, pageText))
  };
}

/**
 * LLM 답 → 후보 목록(아직 검사 전). 모양만 정리하고 판정은 check가 한다(버리지 않고 실패 사유로 보여 준다)
 * @returns {{ candidates: Array, error? }}
 */
export function draftCandidates(text, { page, pageText, tagIds = null }) {
  const raw = parsePageDraft(text);
  if (!raw) return { candidates: [], dropped: [], error: 'parse' };
  const str = v => (typeof v === 'string' ? v.trim() : '');
  const strs = v => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
  const candidates = raw.filter(x => x && typeof x === 'object' && !Array.isArray(x)).map(x => ({
    id: str(x.id),
    label: str(x.label),
    facts: strs(x.facts),
    tags: [...new Set(strs(x.tags))],
    aliases: [...new Set(strs(x.aliases))],
    edges: (Array.isArray(x.edges) ? x.edges : []).filter(e => e && typeof e === 'object').map(e => ({ to: str(e.to), rel: str(e.rel) })).filter(e => e.to && e.rel),
    // 출처는 LLM이 아니라 파이프라인이 붙인다(지어낸 주소 방지)
    sources: [page.url],
    pageTitle: page.title || '',
    ...(page.section ? { section: page.section } : {}),
    grounding: groundingSignals(x, pageText, page.section || '')
  }));
  // 맞는 태그 없음(T-194 실패 사유 1위)은 check까지 가지 않고 여기서 버린다. 사유는 기록(T-195)
  if (!tagIds) return { candidates, dropped: [] };
  const dropped = [];
  const kept = candidates.filter(c => {
    if (c.tags.some(t => tagIds.has(t))) return true;
    dropped.push({ id: c.id, label: c.label, tags: c.tags, reason: 'noTags', source: page.url, ...(page.section ? { section: page.section } : {}) });
    return false;
  });
  return { candidates: kept, dropped };
}

/* ───── 절 나누기 (T-195) ───── */

// 긴 패치 노트는 12,000자에서 잘리면 앞쪽 목차·이벤트만 남는다. h1~h3 제목(web.mjs HEADING_MARK)으로 절을 나누고,
// 건너뛸 절(이벤트·점검·오류 수정 등, cfg.sectionSkip)을 빼고, 작은 절은 이웃과 합치고, 큰 절은 줄 단위로 자른다.
// 제목이 없는 긴 글은 줄 단위로 maxChars씩 자른다. 반환하는 글은 메모리에서만 쓴다(D-5)
export const SECTION_LIMITS = { maxChars: 12000, minChars: 1500, maxSections: 10 };

/**
 * @param {string} text  htmlToText(..., { headings: true, max: Infinity }) 결과
 * @param {{ mark?, maxChars?, minChars?, maxSections?, skip?: RegExp }} opts
 * @returns {{ sections: Array<{ title, text }>, skipped: string[], overflow: number }}
 *   skipped = 건너뛴 절 제목, overflow = maxSections를 넘어 버린 덩어리 수
 */
// keep(T-198): 남길 절 제목 정규식(법령처럼 긴 글에서 식당 운영에 닿는 장만). 있으면 제목 없는 앞부분과 맞지 않는 절은 skipped.
// keepSub: 하위 제목(예: 법령 "제1절") 꼴 — 이 꼴의 절은 바로 앞 상위 절이 남았으면 함께 남는다
export function splitSections(text, { mark = '§§ ', maxChars = SECTION_LIMITS.maxChars, minChars = SECTION_LIMITS.minChars, maxSections = SECTION_LIMITS.maxSections, skip = null, keep = null, keepSub = null } = {}) {
  const raw = [];
  let cur = { title: '', lines: [] };
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith(mark)) { raw.push(cur); cur = { title: line.slice(mark.length).trim(), lines: [] }; continue; }
    cur.lines.push(line);
  }
  raw.push(cur);
  const skipped = [];
  const kept = [];
  let parentKept = false;
  for (const r of raw) {
    if (keep) {
      const isSub = !!(keepSub && r.title && keepSub.test(r.title));
      const ok = isSub ? parentKept : !!(r.title && keep.test(r.title));
      if (!isSub) parentKept = ok;
      if (!ok) { if (r.lines.join('').trim()) skipped.push(r.title || '(앞부분)'); continue; }
    }
    const body = r.lines.join('\n').trim();
    if (!body) continue;
    if (skip && r.title && skip.test(r.title)) { skipped.push(r.title); continue; }
    kept.push({ title: r.title, text: r.title ? `■ ${r.title}\n${body}` : body });
  }
  // 큰 절은 줄 단위로 자른다
  const parts = [];
  for (const k of kept) {
    if (k.text.length <= maxChars) { parts.push(k); continue; }
    let buf = [], len = 0, n = 1;
    const flush = () => { if (buf.length) parts.push({ title: `${k.title || '본문'} (${n++})`, text: buf.join('\n') }); buf = []; len = 0; };
    for (const line of k.text.split('\n')) {
      const l = line.length > maxChars ? line.slice(0, maxChars) : line;
      if (len + l.length + 1 > maxChars) flush();
      buf.push(l); len += l.length + 1;
    }
    flush();
  }
  // 작은 절은 뒤 절과 합친다(LLM 호출 수 절약)
  const merged = [];
  for (const p of parts) {
    const last = merged.at(-1);
    if (last && last.text.length < minChars && last.text.length + p.text.length + 1 <= maxChars) {
      last.title = [last.title, p.title].filter(Boolean).join(' · ').slice(0, 120);
      last.text += '\n' + p.text;
    } else merged.push({ ...p });
  }
  const last = merged.at(-1), prev = merged.at(-2);
  if (last && prev && last.text.length < minChars && prev.text.length + last.text.length + 1 <= maxChars) {
    prev.title = [prev.title, last.title].filter(Boolean).join(' · ').slice(0, 120);
    prev.text += '\n' + last.text;
    merged.pop();
  }
  return { sections: merged.slice(0, maxSections), skipped, overflow: Math.max(0, merged.length - maxSections) };
}

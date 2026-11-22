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
    `1. [페이지]에 실제로 설명된 개념만 0~${L.max}개 고른다. 한 페이지가 여러 시스템·규칙을 설명하면 각각 따로 고른다(보통 1~4개). 이벤트 일정·점검 시간·보상 목록처럼 금방 사라지는 내용은 개념이 아니다. 고를 게 없으면 빈 목록을 낸다.`,
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
    `[페이지] ${page.title || ''}`,
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

// 후보 하나의 근거 지표. 본문 없이도 check가 판단할 수 있게 숫자만 담는다
export function groundingSignals(item, pageText) {
  const label = String(item?.label ?? '');
  const facts = Array.isArray(item?.facts) ? item.facts.filter(f => typeof f === 'string') : [];
  return {
    labelInPage: !!label && norm(pageText).includes(norm(label)),
    factOverlap: facts.map(f => bigramOverlap(f, pageText)),
    copiedRun: facts.map(f => longestCommonRun(f, pageText))
  };
}

/**
 * LLM 답 → 후보 목록(아직 검사 전). 모양만 정리하고 판정은 check가 한다(버리지 않고 실패 사유로 보여 준다)
 * @returns {{ candidates: Array, error? }}
 */
export function draftCandidates(text, { page, pageText }) {
  const raw = parsePageDraft(text);
  if (!raw) return { candidates: [], error: 'parse' };
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
    grounding: groundingSignals(x, pageText)
  }));
  return { candidates };
}

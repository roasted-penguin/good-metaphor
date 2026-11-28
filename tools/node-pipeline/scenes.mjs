// 노드 파이프라인 장면 초안(T-213): 누구나 겪어 본 식당 장면(웨이팅·브레이크 타임·품절 마감 등) 하나 + 그 장면을 설명한 출처 2곳 이상 → LLM → 후보.
// 사용자 결정(2026-11-23): 비유의 받는 쪽은 사용자에게 익숙해야 한다. 법령 조문(간이과세·소액부징수)은 그 자체가 낯설어 버리고,
// 손님·사장 입장의 일상 장면을 고른다. 출처는 공공 밖(뉴스·블로그·커뮤니티·사전)도 되지만 독립 출처 두 곳 이상이 같은 사실을 말해야 한다.
//
// 지키는 것(D-5·D-8과 같은 규칙):
//   - 원문 저장 금지: 출처 본문은 이 호출 동안 메모리에만. 후보에 남기는 것은 우리 문장·출처 주소·숫자 지표뿐
//   - 출처 주소는 LLM이 아니라 파이프라인이 붙인다(LLM은 자료 번호만 고른다)
//   - 독립 출처 2곳 이상 일치(직접 정함): 후보 전체가 서로 다른 사이트 2곳 이상을 쓰고, 적어도 한 사실(장면의 핵심)은 사이트 2곳 이상이 받쳐야 한다.
//     받침(LLM이 고른 자료 번호)이 하나도 없는 사실은 버리고, 남은 사실이 2개 안 되면 후보를 버린다. 처음엔 사실마다 2곳을 요구했는데
//     flash-lite가 정직하게 한 곳만 적어 장면 3개 중 0개만 남았다(2026-11-23). 사실별 겹침은 check가 경고(sceneWeakSupport)로 다시 본다
//   - 특정 가게·브랜드·앱 이름, 실존 인물, 멸칭, 수치·가격은 쓰지 않는다(프롬프트 + check·익숙함 판정이 다시 본다)
//   - robots·1초 1번은 fetcher(web.mjs politeFetcher)가 지킨다. 출처 정책 밖 주소는 가져오지 않는다. 목록·검색 순회는 하지 않고 장면 파일에 적은 쪽만(ADR 0016)
//   - 허용·교차 확인·베낌의 최종 판정은 check가 출처 정책(checkNodeSources 같은 기준)으로 다시 한다
import { htmlToText, contentHash } from './web.mjs';
import { classifySource } from '../source-policy.mjs';
import { parsePageDraft, groundingSignals, bigramOverlap, PAGE_DRAFT_LIMITS } from './draft.mjs';

export const SCENE_LIMITS = { maxNodes: 2, sourceChars: 6000, minSources: 2 };

// 독립 출처를 셀 때 쓰는 사이트 키 = 출처 정책(tools/source-policy.json, ADR 0016)의 사이트 id(공식은 'official' 한 곳, 다음 뉴스는 언론사가 달라도 한 곳).
// 정책 밖 주소(네이버 블로그·뉴스 등)는 null → 초안에 쓰지 않는다
export function siteKey(url, interest = 'restaurant') {
  return classifySource(url, interest)?.site || null;
}

// 뉴스·블로그 페이지 글에서 메뉴·꼬리(짧은 줄)를 걷어 내고 문단 줄만 남긴다(본문 표지가 사이트마다 달라서). 메모리에서만 쓴다
export function articleText(text, minLine = 30) {
  return String(text || '').split('\n').map(l => l.trim()).filter(l => l.length >= minLine).join('\n');
}

/**
 * @param {{ domain, scene: { id, scene }, docs: Array<{ n, site, title, text }>, tags, existing }} p
 * @returns {{ system, user }}
 */
export function buildScenePrompt({ domain, scene, docs, tags, existing = [] }) {
  const L = PAGE_DRAFT_LIMITS;
  const system = [
    `너는 "${domain}"에서 누구나 한 번쯤 겪어 본 장면을 개념 노드로 정리하는 도우미다. 이 노드는 낯선 문장을 ${domain} 장면에 빗대 설명할 때 근거로 쓰인다. 그래서 보통 사람이 이름만 듣고 바로 떠올릴 수 있는 장면이어야 한다.`,
    '규칙:',
    `1. [장면]에 대한 개념을 0~${SCENE_LIMITS.maxNodes}개 고른다. 장면 하나에 움직이는 규칙이 둘이면 나눠도 되지만, 보통은 하나다. 손님이나 사장이 실제로 겪는 장면이 아니면(법 조문·행정 절차·업계 통계) 고르지 않는다.`,
    `2. 개념마다 id(영문 소문자·숫자·밑줄, 2~40자), label(한국어 장면 이름, ${L.label}자 이내, 영문·숫자 없이), facts(사실 ${L.facts[0]}~${L.facts[1]}개), tags(추상 태그 id 1~${L.tags}개)를 적는다.`,
    '3. 사실은 [자료]에 적힌 내용만 근거로 하고, 사실마다 그 내용을 말한 자료 번호를 모두 support에 적는다. 장면의 핵심(첫 사실)은 서로 다른 자료 두 곳 이상이 같은 내용을 말해야 한다. 나머지 사실도 자료에 있는 것만 쓴다. 자료에 없는 내용은 아무리 널리 알려졌어도 쓰지 않는다.',
    '4. 자료 문장을 그대로 옮기지 말고 우리 말로 다시 쓴다(원문 복사 금지). 한국어 평서문("~다.") 한 문장씩, 각 200자 이내.',
    '5. 숫자·가격·시간·비율·날짜는 쓰지 않는다. 숫자 대신 구조와 규칙을 쓴다.',
    '6. 특정 가게·브랜드·앱·회사 이름, 실존 인물의 이름, 멸칭은 쓰지 않는다. "어떤 가게", "배달앱"처럼 일반 명사로 쓴다.',
    '7. 첫 사실은 그 장면이 어떻게 움직이는지(무엇이 무엇에 따라 어떻게 바뀌는가, 무엇을 해야 무엇이 되는가)를 쓴다. 이름만 풀어 쓴 정의로 시작하지 않는다.',
    '8. tags에는 아래 [추상 태그] 목록의 id만 쓴다. 태그를 먼저 고르고, 첫 사실은 그 태그의 구조(설명과 예문이 보여 주는 "무엇이 무엇에 따라 어떻게 되는가")를 이 장면의 말로 직접 드러내야 한다. 예문은 다른 분야라 낱말은 베끼지 말고 구조만 맞춘다. 장면이 그 구조를 실제로 갖지 않으면 태그를 달지 않고, 맞는 태그가 하나도 없으면 그 개념은 넣지 않는다(억지로 끌어대지 않는다).',
    `9. edges에는 [이미 있는 개념]과의 관계를 0~${L.edges}개, {"to": id, "rel": "짧은 동사구"}로 적는다.`,
    '10. [이미 있는 개념]과 같은 개념은 다시 내지 않는다.',
    '11. JSON 객체만 출력한다. 형식: {"nodes": [{"id": string, "label": string, "facts": [{"text": string, "support": [number]}], "tags": [string], "edges": [{"to": string, "rel": string}]}]}'
  ].join('\n');
  const user = [
    `관심사: ${domain}`,
    '',
    '[추상 태그]',
    ...(tags || []).map(t => `- ${t.id} | ${t.label} — ${t.desc || ''}${(t.examples || []).length ? ` (예: ${t.examples.slice(0, 2).join(' / ')})` : ''}`),
    '',
    '[이미 있는 개념]',
    ...existing.map(n => `- ${n.id} | ${n.label}`),
    '',
    `[장면] ${scene.scene}`,
    // 장면 파일의 hint(선택): 사람이 이 장면에서 볼 만하다고 적은 태그 구조. 자료가 받쳐 줄 때만 쓰게 한다(억지 태그 방지는 check 태그 적합성이 다시 본다)
    ...((scene.hint || []).length ? [`[볼 만한 구조] ${(scene.hint || []).map(id => { const t = (tags || []).find(x => x.id === id); return t ? `${id}(${t.desc})` : id; }).join(', ')} — 자료가 이 구조를 받쳐 줄 때만 이 태그를 쓰고, 첫 사실에 그 구조를 장면의 말로 드러낸다. 받쳐 주지 않으면 쓰지 않는다.`] : []),
    '',
    ...docs.flatMap(d => [`[자료 ${d.n}] (${d.site}) ${d.title || ''}`, d.text, ''])
  ].join('\n');
  return { system, user };
}

/**
 * LLM 답 → 후보(사실마다 서로 다른 사이트 2곳 이상 받침만 남김). 판정은 check가 다시 한다
 * @param {string} answer
 * @param {{ scene, docs: Array<{ n, url, site, text }>, tagIds: Set }} ctx  docs = 가져오기에 성공한 자료(본문은 메모리)
 * @returns {{ candidates: Array, dropped: Array, error? }}
 */
export function sceneCandidates(answer, { scene, docs, tagIds }) {
  const raw = parsePageDraft(answer);
  if (!raw) return { candidates: [], dropped: [], error: 'parse' };
  const byN = new Map(docs.map(d => [d.n, d]));
  const str = v => (typeof v === 'string' ? v.trim() : '');
  const allText = docs.map(d => d.text).join('\n');
  const candidates = [], dropped = [];
  for (const x of raw.slice(0, SCENE_LIMITS.maxNodes)) {
    if (!x || typeof x !== 'object') continue;
    const base = { id: str(x.id), label: str(x.label), scene: scene.id };
    const tags = [...new Set((Array.isArray(x.tags) ? x.tags : []).map(str).filter(Boolean))];
    if (!tags.some(t => tagIds.has(t))) { dropped.push({ ...base, tags, reason: 'noTags' }); continue; }
    const kept = [], weak = [];
    for (const f of Array.isArray(x.facts) ? x.facts : []) {
      const text = str(typeof f === 'string' ? f : f?.text);
      if (!text) continue;
      const ns = [...new Set((Array.isArray(f?.support) ? f.support : []).map(Number))].filter(n => byN.has(n));
      const sites = [...new Set(ns.map(n => byN.get(n).site))];
      (sites.length ? kept : weak).push({ text, ns, sites: sites.length });
    }
    const facts = kept.slice(0, PAGE_DRAFT_LIMITS.facts[1]);
    const used = [...new Set(facts.flatMap(f => f.ns))].sort((a, b) => a - b).map(n => byN.get(n));
    const ok = facts.length >= PAGE_DRAFT_LIMITS.facts[0] && new Set(used.map(d => d.site)).size >= SCENE_LIMITS.minSources && facts.some(f => f.sites >= SCENE_LIMITS.minSources);
    if (!ok) { dropped.push({ ...base, tags, reason: 'sceneUncorroborated', facts: facts.length, weakFacts: weak.length, maxSites: Math.max(0, ...facts.map(f => f.sites)) }); continue; }
    const node = { label: base.label, facts: facts.map(f => f.text) };
    candidates.push({
      ...base,
      facts: node.facts,
      tags,
      aliases: [],
      edges: (Array.isArray(x.edges) ? x.edges : []).filter(e => e && typeof e === 'object').map(e => ({ to: str(e.to), rel: str(e.rel) })).filter(e => e.to && e.rel),
      // 출처는 받침으로 쓰인 자료 주소(파이프라인이 붙임). 사이트가 다른 것 2곳 이상
      sources: used.map(d => d.url),
      pageTitle: `장면: ${scene.scene}`,
      grounding: {
        ...groundingSignals(node, allText),
        // 사실마다: LLM이 고른 자료의 사이트, 그 자료와 사실의 2그램 겹침(숫자만, D-5)
        sceneSupport: facts.map(f => f.ns.map(n => ({ site: byN.get(n).site, overlap: bigramOverlap(f.text, byN.get(n).text) })))
      },
      ...(weak.length ? { weakFactsDropped: weak.length } : {})
    });
  }
  return { candidates, dropped };
}

/**
 * 장면마다 출처를 가져와(메모리) LLM에 한 번 묻고 후보를 만든다
 * @param {{ cfg, scenes, fetcher, complete, graph, tags, now?, log?, maxCalls? }} p
 * @returns {Promise<{ candidates, dropped, pages: Array<{ url, title, status, hash?, fetchedAt?, count, sources? }> }>}
 *   pages는 장면마다 한 줄(url = 장면 id 꼴 'scene:<id>', 출처마다 상태·해시)
 */
export async function draftScenes({ cfg, scenes, fetcher, complete, graph, tags, now = () => new Date().toISOString(), log = () => {}, maxCalls = Infinity }) {
  const candidates = [], dropped = [], report = [];
  const existing = graph.nodes.map(n => ({ id: n.id, label: n.label }));
  const tagIds = new Set((tags || []).map(t => t.id));
  const spent = () => (typeof complete.calls === 'function' ? complete.calls() : 0);
  for (const scene of scenes) {
    if (spent() >= maxCalls) { log('호출 상한에 닿아 멈춤'); break; }
    const docs = [], srcRows = [];
    for (const url of scene.sources || []) {
      const site = siteKey(url, cfg.id);
      if (!site) { srcRows.push({ url, status: 'policy' }); continue; } // 출처 정책 밖은 가져오지도 않는다
      const r = await fetcher.get(url);
      if (!r.ok) { srcRows.push({ url, status: r.blocked ? 'robots' : 'fetch-' + r.status }); continue; }
      let text = articleText(htmlToText(r.html, { max: Infinity }));
      srcRows.push({ url, status: 'ok', hash: contentHash(text), fetchedAt: now() });
      if (text.length < 200) { srcRows.at(-1).status = 'short'; continue; }
      docs.push({ n: docs.length + 1, url, site, text: text.slice(0, SCENE_LIMITS.sourceChars) });
      text = null;
    }
    const row = { url: `scene:${scene.id}`, title: scene.scene, status: 'ok', count: 0, sources: srcRows };
    if (new Set(docs.map(d => d.site)).size < SCENE_LIMITS.minSources) {
      row.status = 'too-few-sources'; report.push(row); log(`출처가 2곳이 안 돼 건너뜀: ${scene.id}`); continue;
    }
    const { system, user } = buildScenePrompt({ domain: cfg.domain, scene, docs, tags, existing });
    let answer;
    try { answer = await complete(system, user); } catch (e) {
      row.status = e.budget ? 'budget' : 'llm-error'; row.error = String(e.message || e).slice(0, 160);
      report.push(row); log(`LLM 오류: ${scene.id} ${row.error}`);
      if (e.status === 429 || e.budget) break;
      continue;
    }
    const res = sceneCandidates(answer, { scene, docs, tagIds });
    docs.length = 0; // 본문은 여기서 버린다(D-5)
    if (res.error) row.status = 'parse-error';
    candidates.push(...res.candidates);
    dropped.push(...res.dropped.map(d => ({ ...d, source: row.url })));
    row.count = res.candidates.length;
    for (const c of res.candidates) if (c.id) existing.push({ id: c.id, label: c.label });
    log(`장면 ${scene.id}: 후보 ${res.candidates.length}개(버림 ${res.dropped.length})`);
    report.push(row);
  }
  return { candidates, dropped, pages: report };
}

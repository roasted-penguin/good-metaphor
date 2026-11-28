// 노드 파이프라인(T-194) 자동 검사: 후보 개념마다 실패(fail)·확인 필요(warn) 사유를 붙인다.
// 판정 기준은 기존 규칙에서 왔다: 규칙 2(자주 바뀌는 수치), 규칙 9(태그 통제 어휘), 규칙 11(금칙어),
// T-118·D-5(공식 출처)·D-8(커뮤니티 출처는 교차 확인·베낌 검사, ADR 0016), 기존 그래프 단위 테스트(사실 2~3개 "다."로 끝, 식당은 숫자·영문·별칭 없음).
// 순수 함수(출처 응답 확인만 fetcher 주입). 리뷰 시트(md + json)도 여기서 만든다.
import { findBlocked } from '../../extension/lib/blocklist.js';
// 수치·구조 먼저·중복 검사는 확장 새 관심사 도우미(T-225)와 같이 쓰는 순수 함수라 확장 lib에 둔다(번들 안, 규칙 4)
import { changingNumbers, structureFirst, dupIndex, normLabel, DUP_WARN, DUP_FAIL } from '../../extension/lib/node-checks.js';
export { changingNumbers, structureFirst, dupIndex, DUP_WARN, DUP_FAIL };
import { PAGE_DRAFT_LIMITS, longestCommonRun, bigramOverlap } from './draft.mjs';
import { isArticleSource, contentMarkers } from './sources.mjs';
import { htmlToText } from './web.mjs';
import { corroboration } from '../source-policy.mjs';

export const COPY_WARN = 25;   // 원문과 공백 뺀 글자 25자 이상 그대로면 "베낌 의심"(D-5: 우리 말로)
export const COPY_FAIL = 40;
export const OVERLAP_WARN = 0.5; // 사실 2그램 중 페이지에 있는 비율이 이보다 낮으면 페이지 밖 지식일 수 있다
const ALIAS_MAX = 20;
// 출처 페이지 글(베낌·겹침 검사용, 메모리에만) 최대 글자 수. 나무위키 문서는 길어서 초안용 MAX_TEXT(12,000)보다 넉넉히
export const SOURCE_TEXT_MAX = 120000;

export const REASONS = {
  idFormat: 'id는 영문 소문자로 시작하는 소문자·숫자·밑줄 2~40자여야 해요.',
  idTaken: '같은 id가 그래프에 이미 있어요.',
  idDupBatch: '같은 id가 이 묶음에 먼저 나왔어요.',
  label: `이름은 1~${PAGE_DRAFT_LIMITS.label}자여야 해요.`,
  labelTaken: '같은 이름의 노드가 그래프에 있어요.',
  labelDupBatch: '같은 이름이 이 묶음에 먼저 나왔어요.',
  labelDigit: '식당 노드 이름에는 숫자를 쓰지 않아요.',
  factCount: `사실은 ${PAGE_DRAFT_LIMITS.facts[0]}~${PAGE_DRAFT_LIMITS.facts[1]}개여야 해요.`,
  factLong: `${PAGE_DRAFT_LIMITS.fact}자를 넘는 사실이 있어요.`,
  factEnding: '사실은 "다."로 끝나야 해요.',
  factLatin: '사실에 영문이 있어요(식당은 브랜드일 수 있어 안 써요).',
  number: '자주 바뀌는 수치로 보이는 숫자가 있어요(규칙 2).',
  blocked: '쓸 수 없는 표현(금칙어)이 있어요(규칙 11).',
  noTags: '목록에 있는 태그가 없어요(규칙 9).',
  tagDropped: '목록 밖 태그를 뺐어요(규칙 9).',
  tooManyTags: `태그는 ${PAGE_DRAFT_LIMITS.tags}개까지라 뒤를 뺐어요.`,
  source: '출처 주소가 허용 목록 밖이거나 https가 아니에요.',
  sourceStatus: '출처 주소가 200으로 응답하지 않아요.',
  sourceRedirect: '출처 주소가 허용 목록 밖으로 넘어가요.',
  // 커뮤니티 출처(D-8, ADR 0016)
  communityUncorroborated: '커뮤니티 출처만 있고 교차 확인이 안 돼요(공식 출처 1개 이상 또는 서로 다른 커뮤니티 2곳, ADR 0016).',
  communityUnprobed: '커뮤니티 출처는 페이지를 가져와 베낌 검사를 해야 해요(--no-probe로는 통과 못 해요).',
  communityWeak: '사실과 겹치는 출처 페이지가 2곳이 안 돼요. 두 출처가 정말 같은 사실을 말하는지 봐 주세요.',
  copiedSource: '출처 페이지 문장을 거의 그대로 옮긴 사실이 있어요(D-5·D-8: 우리 말로).',
  copiedSourceHeavy: '출처 페이지 문장을 길게 그대로 옮겼어요(D-5·D-8).',
  storeNameReview: '커뮤니티·블로그·뉴스에서 온 식당 사실이에요. 특정 가게·브랜드 이름이 없는지 봐 주세요(ADR 0016).',
  dupNear: '거의 같은 노드가 그래프에 있어요.',
  dupSimilar: '비슷한 노드가 있어요. 같은 개념인지 봐 주세요.',
  structure: '첫 사실이 구조(무엇에 따라 어떻게 바뀌는가)보다 정의에 가까워요.',
  aliasesReview: '별칭(은어)은 사람이 확인해야 해요.',
  aliasesStripped: '이 관심사는 별칭을 쓰지 않아 뺐어요.',
  aliasLong: `${ALIAS_MAX}자를 넘는 별칭을 뺐어요.`,
  labelNotInPage: '이름이 페이지 본문에 그대로 나오지 않아요.',
  weakGrounding: '페이지 글과 겹침이 적은 사실이 있어요(페이지 밖 지식일 수 있어요).',
  copied: '페이지 문장을 거의 그대로 옮긴 사실이 있어요(D-5: 우리 말로).',
  copiedHeavy: '페이지 문장을 길게 그대로 옮겼어요(D-5).',
  edgeDropped: '없는 노드를 가리키는 엣지를 뺐어요.',
  // 태그 적합성(T-197, tag-fit.mjs)
  tagFitDropped: '사실이 태그 구조를 드러내지 않아(LLM no) 그 태그를 뺐어요.',
  tagFitNone: '사실이 드러내는 태그가 하나도 없어요(LLM 태그 적합성 모두 no).',
  tagFitPending: '태그 적합성 검사를 아직 못 했어요(호출 상한·오류, 다시 돌리면 캐시로 이어 가요).',
  // 근접 중복·태그 밀도(T-197, ADR 0015 제안 2·3, near-dup.mjs)
  nearDup: '기존 노드(또는 앞선 후보)와 기존 노드끼리 가장 가까운 쌍보다 더 가까워요(근접 중복).',
  nearDupClose: '기존 노드와 꽤 가까워요(근접 중복 바닥 − 0.03 이상). 다른 개념인지 봐 주세요.',
  factReused: '기존 노드(또는 앞선 후보)의 사실 문장을 그대로 다시 썼어요.',
  tagDense: '이 태그를 단 노드가 상한(노드 수의 10%, 최소 5)을 넘어요(ADR 0015 제안 3, 경고).',
  // 묶음 사이 중복(T-205, dedupe.mjs)
  dupCross: '같은 id나 이름이 다른 묶음에도 있어 그쪽 하나만 남겨요(묶음 사이 중복).',
  // 익숙함(T-213, familiar.mjs)
  unfamiliar: '보통 사람이 바로 떠올리는 장면이 아니에요(LLM 익숙함 no). 비유의 받는 쪽은 익숙해야 해요.',
  storeName: '특정 가게·브랜드·앱 이름이나 실존 인물이 들어 있어요.',
  familiarPending: '익숙함 검사를 아직 못 했어요(호출 상한·오류, 다시 돌리면 캐시로 이어 가요).'
};

/* ───── 조문 꼴 출처의 이름 근거 (T-205) ───── */

export { isArticleSource };

/**
 * 조문 꼴 본문에서 "이름이 본문에 없음"을 풀어 줄 근거. 이름 핵심 낱말 신호(draft labelSignals)로 판정한다(직접 정함, T-205):
 *   - body: 핵심 낱말이 모두 본문(조문·제목 포함)에 있음
 *   - titles: 장·조 제목에 하나 이상 있고, 본문에 2/3 이상 있음
 *   - article: 조 제목 하나가 핵심 낱말 절반 이상을 담음(그 조를 가리키는 이름)
 *   - cites: 후보 이름·사실이 "제N조"를 직접 가리킴
 * 낱말이 하나도 없거나(이름이 한 글자 낱말뿐) 신호가 없으면(예전 초안, --no-probe) null = 경고 그대로
 * @returns {string|null}
 */
export function lawLabelGrounded(sig, { label = '', facts = [] } = {}) {
  if (/제\s*\d+\s*조/.test([label, ...facts].join(' '))) return 'cites';
  if (!sig || !sig.nouns) return null;
  if (sig.inPage >= sig.nouns) return 'body';
  if (sig.inTitles >= 1 && sig.inPage >= Math.ceil(sig.nouns * 2 / 3)) return 'titles';
  if (sig.article && sig.articleHits >= Math.ceil(sig.nouns / 2)) return 'article';
  return null;
}
const LAW_WHY = { body: '핵심 낱말이 모두 조문에 있음', titles: '핵심 낱말이 장·조 제목과 조문에 있음', article: '조 제목과 맞음', cites: '조를 직접 가리킴' };

/* ───── 수치(규칙 2)·구조 먼저·중복: extension/lib/node-checks.js (위에서 다시 내보냄) ───── */

/* ───── 출처 ───── */

// 허용 호스트·https만 보는 정적 검사
export function sourceAllowed(url, allowHost) {
  try { const u = new URL(url); return u.protocol === 'https:' && allowHost(u.hostname); } catch { return false; }
}

// 출처 주소 분류 { kind:'official'|'community', site } 또는 null. cfg.allowSource(source-policy)가 없으면 allowHost = 공식(테스트용 설정)
export function sourceClass(url, cfg) {
  if (cfg?.allowSource) return cfg.allowSource(url);
  return sourceAllowed(url, cfg.allowHost) ? { kind: 'official', site: 'official' } : null;
}

// 실제 응답 확인(같은 주소는 한 번만). fetcher = web.mjs politeFetcher(robots·1초 간격).
// text = 출처 페이지 글(베낌·겹침 검사용). 메모리에만 두고 결과·디스크에는 숫자만 남긴다(D-5)
export function sourceProber(fetcher, cfg) {
  const memo = new Map();
  return url => {
    if (!memo.has(url)) {
      memo.set(url, (async () => {
        const r = await fetcher.get(url);
        if (!r.ok) return { ok: false, reason: 'sourceStatus', status: r.status, blocked: r.blocked };
        if (r.redirected && !sourceClass(r.url, cfg)) return { ok: false, reason: 'sourceRedirect', status: r.status };
        let text = '';
        try { text = htmlToText(r.html || '', { ...contentMarkers(cfg, r.url || url), max: SOURCE_TEXT_MAX }); } catch { text = ''; }
        return { ok: true, status: r.status, text };
      })());
    }
    return memo.get(url);
  };
}

/**
 * 출처 페이지 글과 사실 비교(숫자만): 사실마다 최장 복사(공백 뺀 글자)·2그램 겹침
 * @returns {{ copiedRun:number, overlap:number }}  copiedRun = 사실 중 최댓값, overlap = 사실 평균
 */
export function sourceTextSignals(facts, text) {
  if (!text || !facts.length) return { copiedRun: 0, overlap: 0 };
  const runs = facts.map(f => longestCommonRun(f, text));
  const ovs = facts.map(f => bigramOverlap(f, text));
  return { copiedRun: Math.max(...runs), overlap: Math.round(ovs.reduce((a, b) => a + b, 0) / ovs.length * 100) / 100 };
}

/* ───── 후보 하나 검사 ───── */

/**
 * @param {object} c  draft 후보
 * @param {{ cfg, tagIds:Set, graphIds:Set, batchIds:Set, batchLabels:Set, graphLabels:Map, dups, blockTerms, probe?, edgeTargets:Set }} ctx
 * @returns {Promise<{ status:'pass'|'warn'|'fail', fails:string[], warns:string[], node, nearest }>}
 */
export async function checkCandidate(c, ctx) {
  const { cfg, tagIds, graphIds, batchIds, graphLabels, batchLabels, dups, blockTerms = [], probe } = ctx;
  const rules = cfg.rules || {};
  const L = PAGE_DRAFT_LIMITS;
  const fails = new Set(), warns = new Set(), notes = [];

  // id
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(c.id || '')) fails.add('idFormat');
  else if (graphIds.has(c.id)) fails.add('idTaken');
  else if (batchIds.has(c.id)) fails.add('idDupBatch');

  // 이름
  const label = c.label || '';
  if (!label || label.length > L.label) fails.add('label');
  if (graphLabels.has(normLabel(label))) fails.add('labelTaken');
  else if (batchLabels.has(normLabel(label))) fails.add('labelDupBatch');
  if (rules.labelNoDigits && /\d/.test(label)) fails.add('labelDigit');
  const labelNums = changingNumbers(label, rules).filter(k => k !== 'digit');
  if (labelNums.length) { fails.add('number'); notes.push(`이름 수치: ${labelNums.join(',')}`); }

  // 사실
  const facts = c.facts || [];
  if (facts.length < L.facts[0] || facts.length > L.facts[1]) fails.add('factCount');
  facts.forEach((f, i) => {
    if (f.length > L.fact) fails.add('factLong');
    if (!f.endsWith('다.')) fails.add('factEnding');
    if (!rules.allowLatin && /[A-Za-z]/.test(f)) fails.add('factLatin');
    const kinds = changingNumbers(f, rules);
    if (kinds.length) { fails.add('number'); notes.push(`사실 ${i + 1} 수치: ${kinds.join(',')}`); }
  });
  if (facts.length && !structureFirst(facts[0])) warns.add('structure');

  // 금칙어(이름·사실·별칭·엣지 관계). 걸린 말 자체는 시트에 쓰지 않는다
  const texts = [label, ...facts, ...(c.aliases || []), ...(c.edges || []).map(e => e.rel)];
  if (texts.some(t => findBlocked(t, blockTerms))) fails.add('blocked');

  // 태그(규칙 9): 목록 밖은 버리고, 남은 게 없으면 실패
  let tags = (c.tags || []).filter(t => tagIds.has(t));
  if (tags.length < (c.tags || []).length) warns.add('tagDropped');
  if (tags.length > L.tags) { tags = tags.slice(0, L.tags); warns.add('tooManyTags'); }
  if (!tags.length) fails.add('noTags');

  // 별칭
  let aliases = (c.aliases || []).filter(a => a.length <= ALIAS_MAX);
  if (aliases.length < (c.aliases || []).length) warns.add('aliasLong');
  if (aliases.length && !rules.allowAliases) { warns.add('aliasesStripped'); aliases = []; }
  else if (aliases.length) warns.add('aliasesReview');
  aliases = aliases.slice(0, L.aliases);

  // 출처: 허용 주소(공식·커뮤니티) → 교차 확인(D-8) → 실제 응답 + 출처 글과 베낌·겹침(숫자만 남김)
  const sources = c.sources || [];
  const classes = sources.map(u => sourceClass(u, cfg));
  let sourceKind = 'official';
  const sourceChecks = [];
  if (!sources.length || classes.some(x => !x)) fails.add('source');
  else {
    const cor = corroboration(classes);
    sourceKind = cor.sourceKind;
    if (!cor.corroborated) fails.add('communityUncorroborated');
    if (probe) {
      for (const [i, u] of sources.entries()) {
        const r = await probe(u);
        if (!r.ok) { fails.add(r.reason); notes.push(`출처 응답: ${r.status}${r.blocked ? ' (robots)' : ''}`); continue; }
        if (r.text) sourceChecks.push({ url: u, kind: classes[i].kind, ...sourceTextSignals(facts, r.text) });
      }
      const run = Math.max(0, ...sourceChecks.map(x => x.copiedRun));
      if (run >= COPY_FAIL) fails.add('copiedSourceHeavy');
      else if (run >= COPY_WARN) warns.add('copiedSource');
      // 두 출처가 같은 사실을 말하는가(휴리스틱): 사실과 겹침이 충분한 출처 페이지 수
      if (sourceKind === 'community' && sourceChecks.filter(x => x.overlap >= OVERLAP_WARN).length < 2) warns.add('communityWeak');
    } else if (sourceKind === 'community') fails.add('communityUnprobed');
  }
  if (sourceKind === 'community' && rules.storeNameReview) warns.add('storeNameReview');

  // 중복
  const near = dups.nearest({ label, facts });
  if (near.best && near.best.score >= DUP_FAIL) fails.add('dupNear');
  else if (near.best && near.best.score >= DUP_WARN) warns.add('dupSimilar');
  if (near.contains) warns.add('dupSimilar');

  // 페이지 근거 지표(draft가 본문 없이 숫자로 남김)
  const g = c.grounding;
  if (g) {
    if (!g.labelInPage) {
      // 조문 꼴 출처는 이름 핵심 낱말이 본문·제목에 있거나 조를 가리키면 경고 없이 근거만 적는다(T-205)
      const why = isArticleSource(sources[0], cfg) ? lawLabelGrounded(g.labelNouns, { label, facts }) : null;
      if (why) notes.push(`이름 근거(조문): ${LAW_WHY[why]}${g.labelNouns?.article ? ` · ${g.labelNouns.article}` : ''} (낱말 ${g.labelNouns?.inPage ?? '-'}/${g.labelNouns?.nouns ?? '-'})`);
      else warns.add('labelNotInPage');
    }
    if ((g.factOverlap || []).some(x => x < OVERLAP_WARN)) warns.add('weakGrounding');
    const run = Math.max(0, ...(g.copiedRun || []));
    if (run >= COPY_FAIL) fails.add('copiedHeavy');
    else if (run >= COPY_WARN) warns.add('copied');
  }

  // 엣지: 있는 노드(그래프·묶음)만
  const edges = (c.edges || []).filter(e => ctx.edgeTargets?.has(e.to) && e.to !== c.id).slice(0, L.edges);
  if (edges.length < (c.edges || []).length) warns.add('edgeDropped');

  // 출처 종류는 LLM·사람이 아니라 파이프라인이 붙인다(커뮤니티 출처가 하나라도 있으면 community)
  const node = { id: c.id, label, ...(aliases.length ? { aliases } : {}), facts, tags, sources, ...(sourceKind === 'community' ? { sourceKind } : {}) };
  const status = fails.size ? 'fail' : warns.size ? 'warn' : 'pass';
  return { status, fails: [...fails], warns: [...warns], notes, node, edges, nearest: near, sourceChecks };
}

/**
 * 묶음 전체 검사. 같은 묶음 안 id·이름 중복은 먼저 나온 것이 이긴다
 * @param {Array} candidates  draft 후보(여러 페이지)
 * @param {{ cfg, graph, tags, blockTerms, probe? }} opts  graph = 해석된 공통 그래프(loadInterestGraph)
 */
export async function checkBatch(candidates, { cfg, graph, tags, blockTerms = [], probe } = {}) {
  const tagIds = new Set((tags || graph.tags || []).map(t => t.id));
  const graphIds = new Set(graph.nodes.map(n => n.id));
  const graphLabels = new Map(graph.nodes.map(n => [normLabel(n.label), n.id]));
  const dups = dupIndex(graph.nodes);
  const batchIds = new Set(), batchLabels = new Set();
  const edgeTargets = new Set([...graphIds, ...candidates.map(c => c.id).filter(Boolean)]);
  const results = [];
  for (const c of candidates) {
    const r = await checkCandidate(c, { cfg, tagIds, graphIds, batchIds, graphLabels, batchLabels, dups, blockTerms, probe, edgeTargets });
    results.push({ ...r, source: c.sources?.[0] || '', pageTitle: c.pageTitle || '', grounding: c.grounding || null });
    if (c.id) batchIds.add(c.id);
    if (c.label) batchLabels.add(normLabel(c.label));
    if (r.status !== 'fail') dups.add({ id: c.id, label: c.label, facts: c.facts });
  }
  return results;
}

// 집계: 상태별 수, 사유별 수(많은 순)
export function summarize(results) {
  const count = { pass: 0, warn: 0, fail: 0 };
  const reasons = {};
  for (const r of results) {
    count[r.status]++;
    for (const k of r.fails) reasons['fail:' + k] = (reasons['fail:' + k] || 0) + 1;
    for (const k of r.warns) reasons['warn:' + k] = (reasons['warn:' + k] || 0) + 1;
  }
  const top = Object.entries(reasons).sort((a, b) => b[1] - a[1]);
  return { total: results.length, ...count, reasons: top };
}

/* ───── 리뷰 시트 ───── */

const esc = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const mark = { pass: '통과', warn: '확인', fail: '실패' };

export function renderSheet({ interest, batch, results, pages, generatedAt, nearDup = null, density = null }) {
  const sum = summarize(results);
  const lines = [
    `# 노드 후보 리뷰 시트: ${interest} 묶음 ${batch}`,
    '',
    `만든 때 ${generatedAt} · 페이지 ${pages} · 후보 ${sum.total} (통과 ${sum.pass} · 확인 ${sum.warn} · 실패 ${sum.fail})`,
    '',
    '승인하려면 id 목록을 JSON 배열로 저장해 `npm run node-pipeline:apply -- --interest ' + interest + ' --batch ' + batch + ' --approve <파일>`. 실패 후보는 apply가 받지 않아요.',
    '',
    '## 사유 집계',
    '',
    ...(sum.reasons.length ? sum.reasons.map(([k, n]) => `- ${k.startsWith('fail:') ? '실패' : '확인'} ${n}건: ${REASONS[k.split(':')[1]] || k}`) : ['- 없음']),
    '',
    ...(nearDup ? ['## 근접 중복 관문', '', `임베더 ${nearDup.embedderId} · 바닥(기존 노드끼리 가장 가까운 쌍) ${nearDup.floor.score} (${nearDup.floor.a} ~ ${nearDup.floor.b}) · 실패 ${nearDup.failed} · 가까움 ${nearDup.close} · 같은 사실 ${nearDup.reused}`, ''] : []),
    ...(density ? ['## 태그 밀도', '', `상한 ${density.cap} (노드 ${density.total}개의 10%, 최소 5) · 넘는 태그: ${density.counts.filter(c => c[2] > density.cap).map(c => `${c[0]} ${c[1]}→${c[2]}`).join(', ') || '없음'}`, ''] : []),
    '## 후보',
    '',
    '| 판정 | id | 이름 | 태그 | 가장 비슷한 노드 | 사유 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...results.map(r => `| ${mark[r.status]} | ${esc(r.node.id)} | ${esc(r.node.label)} | ${esc(r.node.tags.join(', '))} | ${r.nearest?.best ? `${esc(r.nearest.best.id)} ${r.nearest.best.score}` : ''} | ${esc([...r.fails.map(k => '✗ ' + (REASONS[k] || k)), ...r.warns.map(k => '△ ' + (REASONS[k] || k)), ...r.notes].join(' / '))} |`),
    '',
    '## 후보 자세히',
    ''
  ];
  for (const r of results) {
    lines.push(`### ${mark[r.status]} · ${r.node.id} · ${r.node.label}`, '');
    lines.push(`- 출처: ${r.source}${r.pageTitle ? ` (${esc(r.pageTitle)})` : ''}${r.node.sourceKind === 'community' ? ' · 출처 종류 community(교차 확인 대상)' : ''}`);
    for (const x of r.sourceChecks || []) lines.push(`- 출처 확인(${x.kind === 'community' ? '커뮤니티' : '공식'}): ${x.url} (최장 복사 ${x.copiedRun}자, 겹침 ${x.overlap})`);
    if (r.node.aliases?.length) lines.push(`- 별칭(검토): ${r.node.aliases.join(', ')}`);
    lines.push(`- 태그: ${r.node.tags.join(', ') || '(없음)'}`);
    if (r.nearDup) lines.push(`- 근접 중복: 가장 가까운 ${r.nearDup.best.id} ${r.nearDup.best.score} (바닥 ${r.nearDup.floor.score}, ${r.nearDup.embedderId})${r.nearDup.reusedFrom ? ` · 같은 사실: ${r.nearDup.reusedFrom.join(', ')}` : ''}`);
    if (r.tagFit?.status === 'done') for (const v of r.tagFit.verdicts) lines.push(`- 태그 적합성 ${v.id}: ${v.verdict === 'yes' ? 'yes' : v.verdict === 'no' ? 'no(뺌)' : '답 없음'}${v.reason ? ` — ${esc(v.reason)}` : ''}`);
    else if (r.tagFit?.status === 'pending') lines.push(`- 태그 적합성: 못 함(${r.tagFit.note || ''})`);
    if (r.familiar?.status === 'done') lines.push(`- 익숙함: ${r.familiar.familiar}${r.familiar.named === 'yes' ? ' · 가게·인물 이름 있음' : ''}${r.familiar.reason ? ` — ${esc(r.familiar.reason)}` : ''}`);
    else if (r.familiar?.status === 'pending') lines.push(`- 익숙함: 못 함(${r.familiar.note || ''})`);
    if (r.node.sources?.length > 1) lines.push(`- 출처 전체: ${r.node.sources.join(' · ')}`);
    r.node.facts.forEach((f, i) => lines.push(`- 사실 ${i + 1}: ${f}${r.grounding ? ` (겹침 ${r.grounding.factOverlap?.[i] ?? '-'}, 최장 복사 ${r.grounding.copiedRun?.[i] ?? '-'}자)` : ''}`));
    if (r.edges?.length) lines.push(`- 엣지: ${r.edges.map(e => `→ ${e.to} (${e.rel})`).join(', ')}`);
    lines.push('');
  }
  return lines.join('\n');
}

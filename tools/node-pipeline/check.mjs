// 노드 파이프라인(T-194) 자동 검사: 후보 개념마다 실패(fail)·확인 필요(warn) 사유를 붙인다.
// 판정 기준은 기존 규칙에서 왔다: 규칙 2(자주 바뀌는 수치), 규칙 9(태그 통제 어휘), 규칙 11(금칙어),
// T-118·D-5(공식 출처), 기존 그래프 단위 테스트(사실 2~3개 "다."로 끝, 식당은 숫자·영문·별칭 없음).
// 순수 함수(출처 응답 확인만 fetcher 주입). 리뷰 시트(md + json)도 여기서 만든다.
import { findBlocked } from '../../extension/lib/blocklist.js';
import { hashEmbed } from '../../extension/lib/fallback-embed.js';
import { PAGE_DRAFT_LIMITS } from './draft.mjs';

// 대체 임베더(글자 n-그램) 코사인. 기존 그래프의 서로 다른 노드끼리 최고값은 메이플 0.47·식당 0.40(2026-11-22 측정)
export const DUP_WARN = 0.5;   // 이 이상이면 "비슷한 노드가 있어요"(사람이 보고 판단)
export const DUP_FAIL = 0.75;  // 이 이상이면 사실상 같은 노드
export const COPY_WARN = 25;   // 원문과 공백 뺀 글자 25자 이상 그대로면 "베낌 의심"(D-5: 우리 말로)
export const COPY_FAIL = 40;
export const OVERLAP_WARN = 0.5; // 사실 2그램 중 페이지에 있는 비율이 이보다 낮으면 페이지 밖 지식일 수 있다
const ALIAS_MAX = 20;

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
  tagDense: '이 태그를 단 노드가 상한(노드 수의 10%, 최소 5)을 넘어요(ADR 0015 제안 3, 경고).'
};

/* ───── 수치(규칙 2) ───── */

// 숫자 종류별 패턴. 숫자가 남아 있는데 아무 패턴에도 안 맞으면 'digit'
const NUMBER_KINDS = [
  ['percent', /\d\s*(%|％|퍼센트|프로)|퍼센트|확률표/],
  ['version', /\d+\.\d+(\.\d+)?|v\d+|ver\.?\s*\d+/i],
  ['date', /\d{2,4}\s*[.\-/년]\s*\d{1,2}|\d{1,2}\s*월\s*\d{1,2}\s*일|\d{1,2}\s*시\s*\d{0,2}/],
  ['price', /\d[\d,]*\s*(원|메소|억|만|천|포인트|캐시)/],
  ['level', /\d+\s*(레벨|lv|단계|성|강|등급|단|층)|(레벨|lv\.?|최대)\s*\d+/i],
  ['count', /\d+\s*(회|번|개|명|배|시간|분|초|일|주|개월|칸|마리|장)/]
];

// 글 → 걸린 수치 종류 목록(빈 배열이면 통과). allow 패턴(예: "6차")은 먼저 지운다
export function changingNumbers(text, { numberAllow = [] } = {}) {
  let s = String(text ?? '').normalize('NFKC');
  for (const re of numberAllow) s = s.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'), ' ');
  const kinds = NUMBER_KINDS.filter(([, re]) => re.test(s)).map(([k]) => k);
  if (!kinds.length && /\d/.test(s)) kinds.push('digit');
  return kinds;
}

/* ───── 구조 먼저(휴리스틱) ───── */

// 움직임을 드러내는 표지: 조건·비례·변화·대가·제약. 하나도 없으면 "정의에 가깝다"고 본다
const STRUCTURE_MARKERS = /수록|(으)?면[ ,]|하려면|해야|따라|만큼|대신|위해|때문|늘어|줄어|커지|작아|오르|내리|높아|낮아|바뀌|달라|생기|사라|쌓|모아|소모|소비|들인|든다|드는|비용|얻|잃|나누|나눠|정해|제한|넘으|넘기|이상|이하|조건|되면|하면|올리|올라|떨어|깎|돌려|반복|다시|기다|막|풀리|열리|잠기/;
export function structureFirst(fact) {
  return STRUCTURE_MARKERS.test(String(fact ?? ''));
}

/* ───── 중복 ───── */

const normLabel = s => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[\s·・\-_()（）[\]]/g, '');
const nodeVecText = n => `${n.label} ${(n.facts || []).join(' ')}`;
const cosine = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

// 기존 노드 색인(대체 임베더 벡터 + 이름). 후보끼리도 같은 색인에 넣어 묶음 안 중복을 잡는다
export function dupIndex(nodes = []) {
  const items = nodes.map(n => ({ id: n.id, label: n.label, key: normLabel(n.label), vec: hashEmbed(nodeVecText(n)) }));
  return {
    items,
    add(n) { items.push({ id: n.id, label: n.label, key: normLabel(n.label), vec: hashEmbed(nodeVecText(n)) }); },
    // 가장 비슷한 노드 { id, label, score, sameLabel, contains }
    nearest(n) {
      const v = hashEmbed(nodeVecText(n)), key = normLabel(n.label);
      let best = null;
      for (const it of items) {
        const score = cosine(v, it.vec);
        if (!best || score > best.score) best = { id: it.id, label: it.label, score: Math.round(score * 1000) / 1000 };
      }
      const same = items.find(it => it.key && it.key === key);
      const contains = items.find(it => it.key.length >= 2 && key.length >= 2 && it.key !== key && (it.key.includes(key) || key.includes(it.key)));
      return { best, same: same ? { id: same.id, label: same.label } : null, contains: contains ? { id: contains.id, label: contains.label } : null };
    }
  };
}

/* ───── 출처 ───── */

// 허용 호스트·https만 보는 정적 검사
export function sourceAllowed(url, allowHost) {
  try { const u = new URL(url); return u.protocol === 'https:' && allowHost(u.hostname); } catch { return false; }
}

// 실제 응답 확인(같은 주소는 한 번만). fetcher = web.mjs politeFetcher
export function sourceProber(fetcher, allowHost) {
  const memo = new Map();
  return url => {
    if (!memo.has(url)) {
      memo.set(url, (async () => {
        const r = await fetcher.get(url);
        if (!r.ok) return { ok: false, reason: 'sourceStatus', status: r.status, blocked: r.blocked };
        if (r.redirected && !sourceAllowed(r.url, allowHost)) return { ok: false, reason: 'sourceRedirect', status: r.status };
        return { ok: true, status: r.status };
      })());
    }
    return memo.get(url);
  };
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

  // 출처
  const sources = c.sources || [];
  if (!sources.length || !sources.every(u => sourceAllowed(u, cfg.allowHost))) fails.add('source');
  else if (probe) {
    for (const u of sources) {
      const r = await probe(u);
      if (!r.ok) { fails.add(r.reason); notes.push(`출처 응답: ${r.status}${r.blocked ? ' (robots)' : ''}`); }
    }
  }

  // 중복
  const near = dups.nearest({ label, facts });
  if (near.best && near.best.score >= DUP_FAIL) fails.add('dupNear');
  else if (near.best && near.best.score >= DUP_WARN) warns.add('dupSimilar');
  if (near.contains) warns.add('dupSimilar');

  // 페이지 근거 지표(draft가 본문 없이 숫자로 남김)
  const g = c.grounding;
  if (g) {
    if (!g.labelInPage) warns.add('labelNotInPage');
    if ((g.factOverlap || []).some(x => x < OVERLAP_WARN)) warns.add('weakGrounding');
    const run = Math.max(0, ...(g.copiedRun || []));
    if (run >= COPY_FAIL) fails.add('copiedHeavy');
    else if (run >= COPY_WARN) warns.add('copied');
  }

  // 엣지: 있는 노드(그래프·묶음)만
  const edges = (c.edges || []).filter(e => ctx.edgeTargets?.has(e.to) && e.to !== c.id).slice(0, L.edges);
  if (edges.length < (c.edges || []).length) warns.add('edgeDropped');

  const node = { id: c.id, label, ...(aliases.length ? { aliases } : {}), facts, tags, sources };
  const status = fails.size ? 'fail' : warns.size ? 'warn' : 'pass';
  return { status, fails: [...fails], warns: [...warns], notes, node, edges, nearest: near };
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
    lines.push(`- 출처: ${r.source}${r.pageTitle ? ` (${esc(r.pageTitle)})` : ''}`);
    if (r.node.aliases?.length) lines.push(`- 별칭(검토): ${r.node.aliases.join(', ')}`);
    lines.push(`- 태그: ${r.node.tags.join(', ') || '(없음)'}`);
    if (r.nearDup) lines.push(`- 근접 중복: 가장 가까운 ${r.nearDup.best.id} ${r.nearDup.best.score} (바닥 ${r.nearDup.floor.score}, ${r.nearDup.embedderId})${r.nearDup.reusedFrom ? ` · 같은 사실: ${r.nearDup.reusedFrom.join(', ')}` : ''}`);
    if (r.tagFit?.status === 'done') for (const v of r.tagFit.verdicts) lines.push(`- 태그 적합성 ${v.id}: ${v.verdict === 'yes' ? 'yes' : v.verdict === 'no' ? 'no(뺌)' : '답 없음'}${v.reason ? ` — ${esc(v.reason)}` : ''}`);
    else if (r.tagFit?.status === 'pending') lines.push(`- 태그 적합성: 못 함(${r.tagFit.note || ''})`);
    r.node.facts.forEach((f, i) => lines.push(`- 사실 ${i + 1}: ${f}${r.grounding ? ` (겹침 ${r.grounding.factOverlap?.[i] ?? '-'}, 최장 복사 ${r.grounding.copiedRun?.[i] ?? '-'}자)` : ''}`));
    if (r.edges?.length) lines.push(`- 엣지: ${r.edges.map(e => `→ ${e.to} (${e.rel})`).join(', ')}`);
    lines.push('');
  }
  return lines.join('\n');
}

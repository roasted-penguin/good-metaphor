// 노드 검사 순수 함수(T-225): 공통 그래프 노드 파이프라인(tools/node-pipeline, T-194·T-197)과
// 확장의 새 관심사 만들기 도우미(lib/interest-helper.js, ADR 0017 에이전트 2)가 같이 쓴다.
// chrome.*·Node 전용 API를 쓰지 않는다(확장 번들 안, 규칙 4). tools 쪽은 이 파일을 다시 내보내기만 한다.
import { hashEmbed } from './fallback-embed.js';

// 대체 임베더(글자 n-그램) 코사인. 기존 그래프의 서로 다른 노드끼리 최고값은 메이플 0.47·식당 0.40(2026-11-22 측정)
export const DUP_WARN = 0.5;   // 이 이상이면 "비슷한 노드가 있어요"(사람이 보고 판단)
export const DUP_FAIL = 0.75;  // 이 이상이면 사실상 같은 노드

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


export const normLabel = s => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[\s·・\-_()（）[\]]/g, '');
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

/* ───── 태그 적합성(T-197) ───── */

// 태그 적합성 판정 기준 세 줄(노드 파이프라인 태그 적합성·도우미 평가자가 같은 기준을 쓴다)
export const TAG_FIT_RULES = [
  '너는 비유 검색용 개념 그래프의 태그를 검수하는 도우미다. 추상 태그는 "무엇이 무엇에 따라 어떻게 바뀌는가"라는 구조를 뜻하고, 예문은 그 구조를 다른 분야에서 보인 것이다.',
  '아래 개념의 사실만 읽고, 태그마다 그 구조가 사실에 실제로 드러나는지 판단한다.',
  '규칙: 사실에 없는 내용을 보태지 않는다. 겉으로 비슷한 낱말이 아니라 구조가 같은지 본다. 구조의 일부만 겨우 맞거나 억지로 끌어대야 하면 no.'
];

const TAG_EXAMPLES = 3;

/**
 * @param {{ node: { id, label, facts }, tags: Array<{ id, label, desc, examples? }> }} p  tags = 이 후보가 단 태그(목록 안)의 정의
 * @returns {{ system: string, user: string }}
 */
export function buildTagFitPrompt({ node, tags }) {
  const system = [
    ...TAG_FIT_RULES,
    'JSON 객체만 출력한다. 형식: {"tags": [{"id": "태그 id", "verdict": "yes" 또는 "no", "reason": "한국어 한 문장, 80자 이내"}]}'
  ].join('\n');
  const user = [
    `[개념] ${node.label || node.id}`,
    ...(node.facts || []).map(f => `- ${f}`),
    '',
    '[태그]',
    ...tags.map(t => [
      `${t.id} | ${t.label || ''} — ${t.desc || ''}`,
      ...(t.examples || []).slice(0, TAG_EXAMPLES).map(e => `  예: ${e}`)
    ].join('\n'))
  ].join('\n');
  return { system, user };
}

/**
 * @param {string} text  LLM 답
 * @param {string[]} ids  물은 태그 id
 * @returns {Map<string, { verdict: 'yes'|'no', reason: string }> | null}  꼴이 틀리면 null, 답이 없는 태그는 Map에 없음
 */
export function parseTagFit(text, ids) {
  try {
    const t = String(text || '').replace(/```(?:json)?/gi, '').trim();
    // 모델이 {"tags": [...]} 대신 배열만 내는 일이 있다(2026-11-22 gemini-3.5-flash-lite 3번). 배열도 받는다
    const v = t.startsWith('[') ? JSON.parse(t.slice(0, t.lastIndexOf(']') + 1)) : JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
    const list = Array.isArray(v) ? v : Array.isArray(v.tags) ? v.tags : null;
    if (!list) return null;
    const want = new Set(ids);
    const out = new Map();
    for (const x of list) {
      if (!x || !want.has(x.id) || out.has(x.id)) continue;
      if (x.verdict !== 'yes' && x.verdict !== 'no') continue;
      out.set(x.id, { verdict: x.verdict, reason: String(x.reason || '').slice(0, 160) });
    }
    return out;
  } catch { return null; }
}


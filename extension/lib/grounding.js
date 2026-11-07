// 근거 검사 (T-123): 비유가 고른 노드 facts 밖의 사실(지어낸 수치·규칙)을 쓰는지 본다.
// 순수 함수만 둔다. 서버(server/app/pipeline.py)에도 같은 규칙·문구·reason으로 이식한다.

export const GROUNDING_REJECTED_TEXT = '근거에 없는 내용이 섞여 있어서 비유를 숨겼어요.';

// usedFact와 fact를 "같은 문장"으로 볼 글자 3-gram 자카드 하한
const FACT_JACCARD_MIN = 0.6;

// 공백·문장부호·기호를 지운다 (비교용)
export function normalizeText(text) {
  return String(text ?? '').normalize('NFC').replace(/[\s\p{P}\p{S}]/gu, '');
}

// ── 숫자 추출 (T-123, T-143) ──
// 서버 server/app/grounding.py와 같은 상수·같은 정규식이어야 한다(공유 사례 tests/fixtures/grounding-numbers.json).
// 한글 수는 오탐이 가장 큰 위험이라("한국", "세계", "일주일") 세는 말 바로 앞이거나 자리 단위와 결합할 때만 바꾼다.

// 세는 말. 정규식에서는 긴 것부터 맞춘다(주일 > 주, 시간 > 시)
export const COUNTERS = ['번', '회', '개', '명', '마리', '장', '권', '판', '차례', '가지', '시간', '시', '분', '초', '일', '주',
  '주일', '달', '개월', '년', '해', '살', '배', '층', '단계', '등', '위', '칸', '줄', '통', '잔', '대', '곳', '군데', '사람',
  '세트', '묶음', '바퀴'];
// 한자어 수 뒤에만 오는 단위
export const SINO_UNITS = ['원', '메소', '포인트', '퍼센트', '%'];
// 수와 붙여 쓰면(공백 0개) 다른 낱말이 되는 세는 말: 세일·세대·두통·열등·열위·석회·넉살·세분·세배·십분·만회
const ATTACHED_BLOCK = ['일', '대', '통', '등', '위', '분', '판', '회', '살', '배', '주', '년'];
// 세는 말 바로 뒤에 와도 되는 글자(조사·접미사 첫 글자). 그 밖의 한글이 오면 다른 낱말("두 대상", "네 주인")
const AFTER_COUNTER = '이가을를은는에의도만씩째쯤과와로으까부마밖뿐나랑짜동간께요엔예';
const NATIVE_TENS = { 열: 10, 스물: 20, 스무: 20, 서른: 30, 마흔: 40, 쉰: 50 };
const NATIVE_UNITS = { 하나: 1, 한: 1, 둘: 2, 두: 2, 셋: 3, 세: 3, 석: 3, 넷: 4, 네: 4, 넉: 4,
  다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9 };
const SINO_DIGITS = { 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9 };
const SMALL_UNITS = { 십: 10, 백: 100, 천: 1000 };
const BIG_UNITS = { 만: 10000, 억: 100000000 };

const alt = (words) => [...words].sort((a, b) => b.length - a.length).join('|');
const COUNTER_ALT = alt(COUNTERS);
const AFTER = `(?=$|[^가-힣]|[${AFTER_COUNTER}])`;
const SP = '[ \\t\\r\\n]';
const NUMBER_RE = new RegExp([
  // 아라비아 숫자 + 자리 단위: 1만, 3천, 1만 2천, 1.5만, 1천만
  `(?<au>\\d+(?:\\.\\d+)?[억만천백](?:${SP}?\\d+(?:\\.\\d+)?[억만천백]|[억만천백])*)`,
  `(?<d>\\d+)`,
  // 고유어 수 + 세는 말: 두 번, 열한 번째, 스물두 살
  `(?<![가-힣])(?:(?<tens>${alt(Object.keys(NATIVE_TENS))})(?<u1>${alt(Object.keys(NATIVE_UNITS))})?` +
    `|(?<u2>${alt(Object.keys(NATIVE_UNITS))}))(?<sp1>${SP}?)(?<c1>${COUNTER_ALT})${AFTER}`,
  // 한자어 수 + 세는 말·단위. 한자어 글자 연속은 통째로만 본다("만일"을 "만"+"일"로 쪼개지 않음)
  `(?<![가-힣])(?=(?<run>[일이삼사오육칠팔구십백천만억]+))\\k<run>(?<sp2>${SP}?)(?<c2>${alt([...COUNTERS, ...SINO_UNITS])})${AFTER}`
].join('|'), 'g');
const PIECE_RE = /(\d+(?:\.\d+)?)?[ \t\r\n]?([억만천백])/g;

// 자리 단위 계산: [[수(문자열)|null, 단위|null], ...] → 정수 문자열, 정수가 아니면 null.
// 소수("1.5만")가 있어도 정확하도록 10^소수자리를 곱한 BigInt로 센다.
function evalPieces(pieces) {
  const dec = Math.max(0, ...pieces.map(([n]) => (n?.split('.')[1] ?? '').length));
  const D = 10n ** BigInt(dec);
  const scaled = (n) => { const [i, f = ''] = n.split('.'); return BigInt(i + f.padEnd(dec, '0')); };
  let total = 0n, section = 0n, current = 0n;
  for (const [num, unit] of pieces) {
    if (num != null) current = scaled(num);
    if (unit in SMALL_UNITS) { section += (current || D) * BigInt(SMALL_UNITS[unit]); current = 0n; }
    else if (unit in BIG_UNITS) { total += ((section + current) || D) * BigInt(BIG_UNITS[unit]); section = current = 0n; }
  }
  const sum = total + section + current;
  return sum % D === 0n ? String(sum / D) : null;
}

// 한자어 수 글자 연속: 자리 단위가 들어간 2음절 이상, 또는 단독 십·백·천·만일 때만 수로 본다
function sinoValue(run) {
  const hasPlace = [...run].some(ch => ch in SMALL_UNITS || ch in BIG_UNITS);
  if (!(run.length >= 2 ? hasPlace : '십백천만'.includes(run))) return null;
  return evalPieces([...run].map(ch => ch in SINO_DIGITS ? [String(SINO_DIGITS[ch]), null] : [null, ch]));
}

// 숫자를 등장 순으로 뽑아 정수의 10진 표기 배열로 돌려준다.
// - 아라비아 숫자 연속. "1,000"처럼 천 단위 쉼표는 붙여 하나로 본다. NFKC로 전각 숫자("１０")도 같게 본다.
// - 아라비아 숫자 + 자리 단위("1만 2천" → 12000). 바뀐 수 하나만 낸다("1만"이 "1"을 따로 내지 않음).
// - 고유어 수 + 세는 말("두 번" → 2). 단독 "한/하나"는 관용 표현("한 번에")이 많아 바꾸지 않는다.
// - 한자어 수 + 세는 말·원·메소 등("삼천 원" → 3000).
export function numbersIn(text) {
  const s = String(text ?? '').normalize('NFKC').replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
  const out = [];
  for (const m of s.matchAll(NUMBER_RE)) {
    const g = m.groups;
    if (g.au) {
      const v = evalPieces([...g.au.matchAll(PIECE_RE)].map(p => [p[1] ?? null, p[2]]));
      out.push(...(v != null ? [v] : g.au.match(/\d+/g)));
    } else if (g.d) {
      out.push(g.d);
    } else if (g.c1) {
      if (!g.sp1 && ATTACHED_BLOCK.includes(g.c1)) continue;
      if (!g.tens && NATIVE_UNITS[g.u2] === 1) continue;
      out.push(String((NATIVE_TENS[g.tens] ?? 0) + (NATIVE_UNITS[g.u1 ?? g.u2] ?? 0)));
    } else if (g.c2) {
      if (!g.sp2 && ATTACHED_BLOCK.includes(g.c2)) continue;
      const v = sinoValue(g.run);
      if (v != null) out.push(v);
    }
  }
  return out;
}

function trigrams(text) {
  const t = normalizeText(text), grams = new Set();
  for (let i = 0; i + 3 <= t.length; i++) grams.add(t.slice(i, i + 3));
  return grams;
}

// 글자 3-gram 자카드 유사도 (정규화 후). 둘 다 비면 0
export function charJaccard(a, b) {
  const A = trigrams(a), B = trigrams(b);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

// usedFact가 facts 중 하나와 일치하는지: 정규화 후 부분 문자열이거나 자카드 ≥ 0.6
function matchesFact(usedFact, facts) {
  const used = normalizeText(usedFact);
  return facts.some(f => {
    const fact = normalizeText(f);
    return (fact && fact.includes(used)) || charJaccard(usedFact, f) >= FACT_JACCARD_MIN;
  });
}

// { analogy, usedFact, facts, sentence, context, labels = [] } → { ok: true } | { ok: false, reason }
// - labels: 고른 노드 label과 이웃 label. 숫자 검사의 허용 숫자에만 쓰고 usedFact 대조에는 쓰지 않는다.
// - 비유가 비었으면 검사하지 않는다.
// - usedFact가 있으면 고른 노드 facts 중 하나와 일치해야 한다(아니면 fact-mismatch).
// - usedFact가 없거나 비었으면 숫자 검사만 한다(옛 모델·데모 호환, 오탐 방지).
// - 비유의 숫자가 facts·labels·원문 문장·앞 문장 어디에도 없으면 number-outside.
export function checkGrounding({ analogy, usedFact, facts, sentence, context, labels = [] } = {}) {
  if (!normalizeText(analogy)) return { ok: true };
  const factList = Array.isArray(facts) ? facts.filter(f => typeof f === 'string') : [];

  if (normalizeText(usedFact) && !matchesFact(usedFact, factList)) {
    return { ok: false, reason: 'fact-mismatch' };
  }

  const labelList = Array.isArray(labels) ? labels.filter(l => typeof l === 'string') : [];
  const known = new Set([...factList, ...labelList, sentence, context].flatMap(numbersIn));
  if (numbersIn(analogy).some(n => !known.has(n))) {
    return { ok: false, reason: 'number-outside' };
  }
  return { ok: true };
}

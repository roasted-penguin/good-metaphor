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
// 수와 붙여 쓰면(공백 0개) 다른 낱말이 되는 세는 말: 세일·세대·두통·열등·열위·석회·세분·십분·만회
const ATTACHED_BLOCK = ['일', '대', '통', '등', '위', '분', '판', '회', '살', '배', '주', '년'];
// 고유어 수에는 붙여 써도 되는 세는 말(T-145): 두배·세살·열살. 단, 아래 낱말은 수가 아니다
const NATIVE_ATTACHED_OK = ['배', '살'];
// 고유어 수 + 붙여 쓴 세는 말이 다른 낱말일 때: 넉살은 수가 아님(null), 세배(새해 인사)는 수가 아닐 수도 있음(optional)
const NATIVE_ATTACHED_WORDS = { 넉살: null, 세배: 'optional' };
// "네"가 "너의"일 수도 있는 세는 말(T-145): 네 차례, 네 일
const NE_YOUR_COUNTERS = ['차례', '일'];
// 세는 말 바로 뒤에 와도 되는 글자(조사·접미사 첫 글자). 그 밖의 한글이 오면 다른 낱말("두 대상", "네 주인")
const AFTER_COUNTER = '이가을를은는에의도만씩째쯤과와로으까부마밖뿐나랑짜동간께요엔예';
const NATIVE_TENS = { 열: 10, 스물: 20, 스무: 20, 서른: 30, 마흔: 40, 쉰: 50 };
const NATIVE_UNITS = { 하나: 1, 한: 1, 둘: 2, 두: 2, 셋: 3, 세: 3, 석: 3, 넷: 4, 네: 4, 넉: 4,
  다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9 };
const SINO_DIGITS = { 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9 };
const SMALL_UNITS = { 십: 10, 백: 100, 천: 1000 };
const BIG_UNITS = { 만: 10000, 억: 100000000 };

// 정규식 특수문자는 이스케이프한다(Python re.escape와 같게)
const esc = (w) => w.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');
const alt = (words) => [...words].sort((a, b) => b.length - a.length).map(esc).join('|');
const COUNTER_ALT = alt(COUNTERS);
const AFTER = `(?=$|[^가-힣]|[${AFTER_COUNTER}])`;
const SP = '[ \\t\\r\\n]';
// 자리 단위. "200만큼"의 만은 단위가 아니다
const UNIT = '(?:[억천백]|만(?!큼))';
const NUMBER_RE = new RegExp([
  // 아라비아 숫자 + 자리 단위: 1만, 3천, 1만 2천, 1.5만, 1천만
  `(?<au>\\d+(?:\\.\\d+)?${UNIT}(?:${SP}?\\d+(?:\\.\\d+)?${UNIT}|${UNIT})*)`,
  `(?<d>\\d+)`,
  // 고유어 수 + 세는 말: 두 번, 열한 번째, 스물두 살, 열 두 번
  `(?<![가-힣])(?:(?<tens>${alt(Object.keys(NATIVE_TENS))})(?:${SP}?(?<u1>${alt(Object.keys(NATIVE_UNITS))}))?` +
    `|(?<u2>${alt(Object.keys(NATIVE_UNITS))}))(?<sp1>${SP}?)(?<c1>${COUNTER_ALT})${AFTER}`,
  // 한자어 수 + 세는 말·단위. 한자어 글자 연속은 통째로만 본다("만일"을 "만"+"일"로 쪼개지 않음)
  // 세는 말이 없어도 "이십일"처럼 일로 끝나면 잡아 두고 코드에서 가린다(T-145)
  `(?<![가-힣])(?=(?<run>[일이삼사오육칠팔구십백천만억]+))\\k<run>(?:(?<sp2>${SP}?)(?<c2>${alt([...COUNTERS, ...SINO_UNITS])}))?${AFTER}`
].join('|'), 'g');
// 단독 "N만" 뒤에 세는 말·화폐가 오는지(오면 N×10000 하나, 아니면 "N만(=N뿐)"일 수도 있음)
const COUNTED_AFTER_RE = new RegExp(`^${SP}?(?:${alt([...COUNTERS, ...SINO_UNITS])})${AFTER}`);
const LONE_MAN_RE = /^(\d+)만$/;
const PIECE_RE = /(\d+(?:\.\d+)?)?[ \t\r\n]?([억만천백])/g;

// 자리 단위 계산: [[수(문자열)|null, 단위|null], ...] → 정수 문자열, 정수가 아니면 null.
// 소수("1.5만")가 있어도 정확하도록 10^소수자리를 곱한 BigInt로 센다.
function evalPieces(pieces) {
  const dec = Math.max(0, ...pieces.map(([n]) => (n?.split('.')[1] ?? '').length));
  const D = 10n ** BigInt(dec);
  const scaled = (n) => { const [i, f = ''] = n.split('.'); return BigInt(i + f.padEnd(dec, '0')); };
  // current가 null이면 "수가 없음"(단독 "만" = 1만). 0은 수가 있는 것이다("0만" = 0)
  let total = 0n, section = 0n, current = null, hasSection = false;
  for (const [num, unit] of pieces) {
    if (num != null) current = scaled(num);
    if (unit in SMALL_UNITS) {
      section += (current ?? D) * BigInt(SMALL_UNITS[unit]); current = null; hasSection = true;
    } else if (unit in BIG_UNITS) {
      total += (current != null || hasSection ? section + (current ?? 0n) : D) * BigInt(BIG_UNITS[unit]);
      section = 0n; current = null; hasSection = false;
    }
  }
  const sum = total + section + (current ?? 0n);
  return sum % D === 0n ? String(sum / D) : null;
}

// 한자어 수 글자 연속: 자리 단위가 들어간 2음절 이상, 또는 단독 십·백·천·만일 때만 수로 본다
function sinoValue(run) {
  const hasPlace = [...run].some(ch => ch in SMALL_UNITS || ch in BIG_UNITS);
  if (!(run.length >= 2 ? hasPlace : '십백천만'.includes(run))) return null;
  return evalPieces([...run].map(ch => ch in SINO_DIGITS ? [String(SINO_DIGITS[ch]), null] : [null, ch]));
}

// 수 표현을 등장 순으로 읽기 후보 묶음 { readings, optional }으로 돌려준다(T-145).
// - readings: 정수의 10진 표기. 확실하면 하나, 뜻이 둘이면 둘("200만 쓰면" → 2000000 또는 200).
// - optional: 숫자가 아닐 수도 있음("네 차례" = 너의 차례, "세배" = 새해 인사).
// 규칙(T-143):
// - 아라비아 숫자 연속. "1,000"처럼 천 단위 쉼표는 붙여 하나로 본다. NFKC로 전각 숫자("１０")도 같게 본다.
// - 아라비아 숫자 + 자리 단위("1만 2천" → 12000). 바뀐 수 하나만 낸다("1만"이 "1"을 따로 내지 않음).
// - 고유어 수 + 세는 말("두 번" → 2). 단독 "한/하나"는 관용 표현("한 번에")이 많아 바꾸지 않는다.
// - 한자어 수 + 세는 말·원·메소 등("삼천 원" → 3000).
export function numberGroups(text) {
  const s = String(text ?? '').normalize('NFKC').replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
  const out = [];
  const push = (readings, optional = false) => out.push({ readings, optional });
  for (const m of s.matchAll(NUMBER_RE)) {
    const g = m.groups;
    if (g.au) {
      const v = evalPieces([...g.au.matchAll(PIECE_RE)].map(p => [p[1] ?? null, p[2]]));
      if (v == null) { for (const d of g.au.match(/\d+/g)) push([d]); continue; }
      // 단독 "N만" 뒤에 세는 말·화폐가 없으면 "N뿐"일 수도 있다("레벨 200만 입장")
      const lone = g.au.match(LONE_MAN_RE);
      const counted = COUNTED_AFTER_RE.test(s.slice(m.index + g.au.length));
      push(lone && !counted ? [v, String(BigInt(lone[1]))] : [v]);
    } else if (g.d) {
      push([g.d]);
    } else if (g.c1) {
      const unit = g.u1 ?? g.u2;
      if (!g.tens && NATIVE_UNITS[g.u2] === 1) continue;
      let optional = false;
      if (!g.sp1 && ATTACHED_BLOCK.includes(g.c1)) {
        if (!NATIVE_ATTACHED_OK.includes(g.c1)) continue;
        const word = NATIVE_ATTACHED_WORDS[(g.tens ?? '') + (g.u1 ?? g.u2 ?? '') + g.c1];
        if (word === null) continue;
        optional = word === 'optional';
      }
      if (!g.tens && g.u2 === '네' && NE_YOUR_COUNTERS.includes(g.c1)) optional = true;
      push([String((NATIVE_TENS[g.tens] ?? 0) + (NATIVE_UNITS[unit] ?? 0))], optional);
    } else if (g.c2) {
      if (!g.sp2 && ATTACHED_BLOCK.includes(g.c2)) continue;
      const v = sinoValue(g.run);
      if (v != null) push([v]);
    } else if (g.run) {
      // 세는 말 없이 "이십일·삼십일·백일": 21(수 전체) 또는 20+일(날짜 세는 말). 앞 글자가 십·백·천일 때만
      // ("만일"은 "만약"의 뜻이라 빼고, 단독 "일"도 수가 아니다)
      const run = g.run;
      if (run.length < 2 || !run.endsWith('일') || !(run[run.length - 2] in SMALL_UNITS)) continue;
      const whole = sinoValue(run), day = sinoValue(run.slice(0, -1));
      if (whole != null && day != null) push([whole, day]);
    }
  }
  return out;
}

// 숫자를 등장 순으로 뽑아 정수의 10진 표기 배열로 돌려준다. 모든 묶음의 readings를 펼친 것(허용 숫자 쪽에 쓴다)
export function numbersIn(text) {
  return numberGroups(text).flatMap(g => g.readings);
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
//   뜻이 둘인 수는 둘 중 하나만 있으면 되고, 숫자가 아닐 수도 있는 표현(optional)은 통과(T-145).
export function checkGrounding({ analogy, usedFact, facts, sentence, context, labels = [] } = {}) {
  if (!normalizeText(analogy)) return { ok: true };
  const factList = Array.isArray(facts) ? facts.filter(f => typeof f === 'string') : [];

  if (normalizeText(usedFact) && !matchesFact(usedFact, factList)) {
    return { ok: false, reason: 'fact-mismatch' };
  }

  const labelList = Array.isArray(labels) ? labels.filter(l => typeof l === 'string') : [];
  const known = new Set([...factList, ...labelList, sentence, context].flatMap(numbersIn));
  // 비유 쪽은 묶음마다: 읽기 후보 하나라도 허용 숫자에 있거나 숫자가 아닐 수도 있으면(optional) 통과
  if (numberGroups(analogy).some(g => !g.optional && !g.readings.some(n => known.has(n)))) {
    return { ok: false, reason: 'number-outside' };
  }
  return { ok: true };
}

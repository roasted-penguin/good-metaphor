// 금칙어 필터(T-114, 규칙 11). 커뮤니티 멸칭·실존 인물 이름이 말풍선에 나오지 않게 출력 직전에 검사한다.
// 목록 원본은 data/common/blocklist.json(ADR 0007 용어 카드). status가 '승인'인 카드만 쓴다.
// 서버 server/app/blocklist.py 와 같은 규칙이다(공유 사례 tests/fixtures/blocklist-cases.json).
// chrome.* 를 쓰지 않는다(Node 평가 도구도 같이 씀).

export const BLOCKED_REJECTED_TEXT = '부적절한 표현이 섞여 있어서 비유를 숨겼어요.';

// 지우는 글자: 공백, 문장부호, 기호, 제로폭 문자, 소프트 하이픈·단어 결합자, 한글 채움 문자(ㅤ 등)
// \p{P}·\p{S} 범주는 런타임의 Unicode 버전을 따른다. Node(ICU)와 Python unicodedata 버전이 달라 새로 배정된 기호 몇 개만 다르게 지워질 수 있다(실제 글에서는 차이 0, T-114)
const STRIP = /[\s\p{P}\p{S}​-‍﻿­⁠ᅟᅠㅤﾠ]/gu;

// NFKC → 소문자 → 사이에 끼워 넣은 공백·점·기호 제거. "리.선 족" 같은 우회 표기를 붙여 쓴 꼴로 만든다
export function normalizeForBlock(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().replace(STRIP, '');
}

// 배열이나 { terms } 를 받아 승인된 카드만 돌려준다
export function activeTerms(list) {
  const terms = Array.isArray(list) ? list : Array.isArray(list?.terms) ? list.terms : [];
  return terms.filter(c => c && c.status === '승인');
}

// 정규화한 text 안에 승인된 term 또는 variant(정규화)가 있으면 그 term, 없으면 null.
// 정규화하면 빈 문자열이 되는 항목은 건너뛴다(모든 글에 걸리지 않게)
export function findBlocked(text, terms) {
  const t = normalizeForBlock(text);
  if (!t) return null;
  for (const card of activeTerms(terms)) {
    for (const w of [card.term, ...(card.variants || [])]) {
      const n = normalizeForBlock(w);
      if (n && t.includes(n)) return card.term;
    }
  }
  return null;
}

// 답(LLM 답 또는 서버 결과)의 meaning·analogy·mapping 을 검사한다. 원본은 바꾸지 않고 사본을 돌려준다.
// 어느 필드든 걸리면 analogy·mapping 을 비우고 evidence = null, rejected 에 숨김 문구. meaning 에서 걸리면 meaning 도 비운다.
// blocked = 처음 걸린 필드 { field, term: '(가림)' } 또는 null(금칙어 자체는 담지 않는다)
export function applyBlocklist(answer, terms) {
  let blocked = null;
  const out = { ...answer };
  for (const field of ['meaning', 'analogy', 'mapping']) {
    if (!findBlocked(out[field], terms)) continue;
    blocked ||= { field, term: '(가림)' };
    if (field === 'meaning') out.meaning = '';
  }
  if (!blocked) return { answer, blocked: null };
  out.analogy = '';
  out.mapping = '';
  out.evidence = null;
  out.rejected = BLOCKED_REJECTED_TEXT;
  return { answer: out, blocked };
}

// 프롬프트. 핵심 규칙: 관심사 쪽 내용은 [근거]에 있는 사실만 쓴다.

// 추상화 규칙(정밀 모드). 글 응답(buildAbstractPrompt)과 판정 합침(buildAbstractJudgePrompt, T-184)이 같이 쓴다
const ABSTRACT_RULES = [
  '너는 문장의 핵심 개념을 분야와 무관한 추상 구조로 바꿔 적는 도우미다.',
  '고유명사나 전문용어를 쓰지 말고, "무엇이 무엇에 따라 어떻게 변하는가" 같은 구조로 1~2문장 한국어로 적는다.',
  '원문에 나온 전문용어·외래어(예: 레버리지, 인플레이션, rate limit)는 그대로 옮기지 말고 그 뜻을 쉬운 우리말로 풀어 쓴다.',
  '예: "인플레이션이 심해지면 같은 돈으로 살 수 있는 물건이 줄어든다" → "전체 가격이 오르면 같은 양의 돈이 가진 가치가 줄어든다"'
];

const abstractUser = ({ sentence, word, pageTitle }) =>
  `페이지: ${pageTitle || '(제목 없음)'}\n문장: ${sentence}\n${word ? `커서가 가리킨 단어: ${word}\n` : ''}`;

export function buildAbstractPrompt({ sentence, word, pageTitle }) {
  const system = [...ABSTRACT_RULES, '설명이나 머리말 없이 그 문장만 출력한다.'].join('\n');
  return { system, user: abstractUser({ sentence, word, pageTitle }) };
}

// 판정에서 "맞는 태그 없음"을 뜻하는 예약 선택지(T-184). 태그 파일(tags.json)의 id와 겹치지 않는다
export const NONE_TAG = { id: 'none', label: '해당 구조 없음', desc: '원리·규칙·인과 구조가 없는 단순한 사건 묘사나 감상이라 위 태그 어느 것도 맞지 않음' };

/**
 * 정밀 모드 추상화 + 태그 판정을 한 번에 묻는 프롬프트(T-184, ADR 0014). 호출 수는 그대로다.
 * choices는 tags.json에서 만든 선택지(judges.js tagChoices). 목록·개수를 여기서 정하지 않는다(규칙 9). "없음"은 맨 뒤에 붙인다
 */
export function buildAbstractJudgePrompt({ sentence, word, pageTitle, choices = [] }) {
  const list = [...choices, NONE_TAG].map(c => `- ${c.id}: ${c.label}${c.desc ? ' — ' + c.desc : ''}`).join('\n');
  const system = [
    ...ABSTRACT_RULES,
    '그다음 그 추상 구조가 아래 태그 중 무엇에 해당하는지 판정한다. 문장의 단어나 주제가 아니라 구조로 판단한다.',
    '해당하는 태그마다 맞을 확률(0~1)을 서로 독립적으로 매기고, 확률이 높은 순으로 최대 5개만 적는다.',
    `원리·규칙·인과 구조가 없는 단순한 사건 묘사나 감상이라 맞는 태그가 없으면 "${NONE_TAG.id}"에 높은 확률을 준다. 억지로 태그를 고르지 않는다.`,
    '태그 목록에 없는 id를 만들지 않는다.',
    '태그:',
    list,
    '출력은 JSON 객체 하나만: {"abstract":"<추상 구조 1~2문장>","tags":[{"id":"<태그 id>","p":<0~1>}]}'
  ].join('\n');
  return { system, user: abstractUser({ sentence, word, pageTitle }) };
}

// 검색 질의 문자열. 'precise'(정밀 모드) = 추상 구조 + 원문, 'abstract' = 추상 구조만. 추상이 비면 원문
export function rewriteQueryText(abstractText, sentence, mode = 'precise') {
  const a = (abstractText || '').trim();
  if (!a) return sentence;
  return mode === 'abstract' ? a : `${a} ${sentence}`;
}

export function buildAnalogyPrompt({ sentence, context, word, pageTitle, domain, analogyPrefix, candidates }) {
  const system = [
    `너는 사용자가 이해하기 어려워하는 문장을, 사용자가 잘 아는 "${domain}"에 빗대 짧게 설명하는 도우미다.`,
    '규칙:',
    `1. ${domain}에 관한 내용은 아래 [근거] 후보의 사실(facts)과 연결(neighbors)만 쓴다. 근거에 없는 ${domain}의 수치, 이름, 규칙을 지어내지 않는다.`,
    '2. 후보 중 원문 개념과 추상 구조(태그)가 가장 잘 맞는 하나를 고른다. 겉보기 단어가 비슷한 것보다 구조가 같은 것을 우선한다.',
    '3. 구조가 맞는 후보가 없으면 analogy를 빈 문자열로 두고 nodeId를 null로 둔다. 억지 비유는 틀린 설명보다 나쁘다.',
    `4. analogy는 "${analogyPrefix}" 문구로 시작하는 1~2문장, 120자 안쪽. 원문과 ${domain}의 어떤 부분이 대응하는지 드러나게 쓴다.`,
    '5. meaning은 원문 문장의 뜻을 중학생도 알 쉬운 말로 1문장. 원문이 영어여도 한국어로 쓴다.',
    '6. meaning과 analogy의 모든 문장은 해요체(~요)로 끝낸다. ~습니다·~ㅂ니다(합쇼체)나 ~다(해라체)는 어떤 경우에도 쓰지 않는다. JSON 객체만 출력한다. 필드는 meaning, analogy, nodeId, tagId, usedFact, mapping 순서로 쓴다.',
    `7. analogy에 쓴 ${domain} 쪽 사실은 고른 후보의 facts 문장 하나를 usedFact에 글자 그대로 옮긴다. 비유가 없으면 usedFact는 빈 문자열이다.`,
    '8. 커뮤니티 멸칭이나 실존 인물 이름·별명은 쓰지 않는다.',
    '출력 형식: {"meaning": string, "analogy": string, "nodeId": string|null, "tagId": string|null, "usedFact": string, "mapping": string}',
    'mapping은 "원문 개념 ↔ 관심사 개념" 형태의 짧은 대응 한 줄이다.',
    '끝맺음 예: "보상이 줄어들어요."(O) / "보상이 줄어듭니다."(X) / "보상이 줄어든다."(X)'
  ].join('\n');

  const cand = candidates.map((c, i) => [
    `[${i + 1}] id=${c.id} | ${c.label}`,
    c.tag ? `  맞은 추상 태그: ${c.tag.label} (id=${c.tag.id}) — ${c.tag.desc}` : '',
    c.otherTags.length ? `  다른 태그: ${c.otherTags.join(', ')}` : '',
    '  facts:',
    ...c.facts.map(f => `   - ${f}`),
    c.neighbors.length ? `  neighbors: ${c.neighbors.map(n => `${n.label}(${n.rel})`).join('; ')}` : ''
  ].filter(Boolean).join('\n')).join('\n');

  const user = [
    `페이지 제목: ${pageTitle || '(제목 없음)'}`,
    context ? `앞 문장: ${context}` : '',
    `설명할 문장: ${sentence}`,
    word ? `커서가 가리킨 단어: ${word}` : '',
    '',
    '[근거]',
    cand
  ].filter(s => s !== '').join('\n');

  return { system, user };
}

// 스트리밍 중인 부분 JSON에서 meaning 값이 닫혔으면 돌려준다. 덜 왔거나 비었으면 null
export function extractMeaning(partial) {
  const m = /"meaning"\s*:\s*"/.exec(partial || '');
  if (!m) return null;
  for (let i = m.index + m[0].length; i < partial.length; i++) {
    if (partial[i] === '\\') { i++; continue; }
    if (partial[i] === '"') {
      try { return JSON.parse(partial.slice(m.index + m[0].length - 1, i + 1)) || null; } catch { return null; }
    }
  }
  return null;
}

// 받침 유무로 조사 고르기: withJosa('경매장', '과', '와') → '경매장과'
export function withJosa(word, batchim, noBatchim) {
  const ch = String(word).trim().replace(/[)"'\]]+$/, '').slice(-1);
  const code = ch.charCodeAt(0) - 0xac00;
  const has = code >= 0 && code <= 11171 ? code % 28 !== 0 : false;
  return word + (has ? batchim : noBatchim);
}

// "(으)로": 받침이 있으면 "으로", ㄹ 받침·받침 없음(영문 포함)이면 "로". withRo('원신') → '원신으로'
export function withRo(word) {
  const w = String(word).trim();
  const code = w.replace(/[)"'\]]+$/, '').slice(-1).charCodeAt(0) - 0xac00;
  const jong = code >= 0 && code <= 11171 ? code % 28 : 0;
  return w + (jong === 0 || jong === 8 ? '로' : '으로');
}

// AI 관심사 그래프 초안(T-301). tags는 공통 태그 사전(data/common/tags.json)에서 그대로 온다(규칙 9: 같은 원본).
// 예문(examples)은 다른 분야 문장이라 싣지 않는다. 결과는 lib/draft.js parseDraft가 다시 검사한다
export function buildDraftPrompt({ name, tags }) {
  const system = [
    '너는 사용자가 잘 아는 관심사를 개념 노드 목록으로 정리하는 도우미다. 이 노드는 나중에 낯선 문장을 그 관심사에 빗대 설명할 때 근거로 쓰인다.',
    '규칙:',
    `1. "${name}"에서 사람들이 잘 아는 개념을 10~20개 고른다. 개념마다 label(40자 이내), facts(사실 1~3개, 각 200자 이내), tags(추상 태그 id 1~3개)를 적는다.`,
    '2. tags에는 아래 [추상 태그] 목록의 id만 쓴다. 이 목록 밖 태그는 쓰지 않는다. 맞는 태그가 없는 개념은 넣지 않는다.',
    '3. 사실을 지어내지 않는다. 널리 알려진 확실한 것만 쓰고, 모르면 그 개념을 뺀다.',
    '4. 자주 바뀌는 수치(가격·확률·날짜·최대 단계)는 쓰지 않는다. 숫자 대신 구조와 규칙을 쓴다.',
    '5. 실존 인물의 이름·별명과 커뮤니티 멸칭은 쓰지 않는다.',
    '6. facts는 한국어 평서문("~다") 한 문장씩, 그 개념이 어떻게 움직이는지(무엇이 무엇에 따라 어떻게 변하는가)가 드러나게 쓴다.',
    '7. JSON 객체만 출력한다. 형식: {"nodes": [{"label": string, "facts": [string], "tags": [string]}]}'
  ].join('\n');
  const user = [
    `관심사: ${name}`,
    '',
    '[추상 태그]',
    ...(tags || []).map(t => `- ${t.id} | ${t.label} — ${t.desc || ''}`)
  ].join('\n');
  return { system, user };
}

// ── 끝맺음 검사(T-122) ──
// 규칙 5(UI 문구는 ~요). 모델이 합쇼체(~습니다)나 해라체(~다)로 끝내면 잡는다.
// 명사로 끝난 조각("…스타포스 강화.")은 잡지 않는다(오탐보다 놓치는 쪽이 낫다).
const TRAIL = /[\s.!?。…~"'”’)\]」』>*]+$/u;
const hasJong = (ch, jong) => {
  const code = (ch || '').charCodeAt(0) - 0xac00;
  return code >= 0 && code <= 11171 && code % 28 === jong;
};
const JONG_B = 17; // ㅂ 받침(습·합·입·됩…)

// 한 문장 끝의 문체: 'formal'(합쇼체) | 'plain'(해라체) | null(해요체·그 밖)
function sentenceEnding(sentence) {
  const s = sentence.replace(TRAIL, '');
  if (!s) return null;
  if (/[요죠]$/.test(s)) return null;
  if (/니[다까]$/.test(s) && hasJong(s.at(-3), JONG_B)) return 'formal';
  if (/시오$/.test(s)) return 'formal';
  if (/[다냐]$/.test(s)) return 'plain';
  return null;
}

// 글 전체에서 어긴 문체 하나(합쇼체 우선). 다 해요체면 null. 숫자 소수점("3.5")에서는 끊지 않는다
export function impoliteEnding(text) {
  if (!text) return null;
  const styles = String(text).split(/(?<=[.!?。])\s+|\n+/).map(sentenceEnding).filter(Boolean);
  return styles.includes('formal') ? 'formal' : styles[0] || null;
}

// 말풍선에 보이는 문장 필드(meaning·analogy)만 본다. mapping 은 "A ↔ B" 조각이라 보지 않는다
export function endingIssues(answer) {
  if (!answer) return [];
  return ['meaning', 'analogy']
    .map(field => ({ field, style: impoliteEnding(answer[field]) }))
    .filter(x => x.style);
}

// 다시 부를 때 user 끝에 붙이는 짧은 교정 문구. 직전 답을 함께 줘서 내용은 두고 끝맺음만 고치게 한다
export function endingRetryNote(issues, prev) {
  const fields = issues.map(i => i.field).join('·');
  return [
    '',
    `[고쳐 주세요] 직전 답의 ${fields}이(가) ~습니다·~다로 끝났어요. 내용은 그대로 두고 meaning과 analogy의 모든 문장을 해요체(~요)로 끝내 같은 JSON 형식으로만 다시 출력해요.`,
    `직전 답: ${JSON.stringify(prev)}`
  ].join('\n');
}

// 추상화 결과에 원문 전문용어가 그대로 남았는지(스모크용). 대소문자·띄어쓰기·하이픈 무시
export function leakedTerms(text, terms) {
  const norm = s => String(s || '').toLowerCase().replace(/[\s\-_]+/g, '');
  const t = norm(text);
  if (!t) return [];
  return (terms || []).filter(term => t.includes(norm(term)));
}

// LLM 없이 검색 결과만으로 만드는 데모 응답
export function demoAnswer({ candidates, analogyPrefix }) {
  const top = candidates[0];
  if (!top) return { meaning: '', analogy: '', nodeId: null, tagId: null, mapping: '' };
  return {
    meaning: '(데모 모드: LLM을 부르지 않아 뜻 풀이는 생략돼요)',
    analogy: `${analogyPrefix} ${withJosa(top.label, '과', '와')} 비슷한 구조예요. ${top.tag ? `둘 다 '${top.tag.label}'에 해당해요. ` : ''}(${top.facts[0]})`,
    nodeId: top.id,
    tagId: top.tag?.id || null,
    mapping: top.tag ? `원문 ↔ ${top.label} (${top.tag.label})` : ''
  };
}

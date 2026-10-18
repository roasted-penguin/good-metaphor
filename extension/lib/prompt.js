// 프롬프트. 핵심 규칙: 관심사 쪽 내용은 [근거]에 있는 사실만 쓴다.

export function buildAbstractPrompt({ sentence, word, pageTitle }) {
  const system = [
    '너는 문장의 핵심 개념을 분야와 무관한 추상 구조로 바꿔 적는 도우미다.',
    '고유명사나 전문용어를 쓰지 말고, "무엇이 무엇에 따라 어떻게 변하는가" 같은 구조로 1~2문장 한국어로 적는다.',
    '설명이나 머리말 없이 그 문장만 출력한다.'
  ].join('\n');
  const user = `페이지: ${pageTitle || '(제목 없음)'}\n문장: ${sentence}\n${word ? `커서가 가리킨 단어: ${word}\n` : ''}`;
  return { system, user };
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
    '6. 존댓말(~요)을 쓴다. JSON 객체만 출력한다. 필드는 meaning, analogy, nodeId, tagId, mapping 순서로 쓴다.',
    '출력 형식: {"meaning": string, "analogy": string, "nodeId": string|null, "tagId": string|null, "mapping": string}',
    'mapping은 "원문 개념 ↔ 관심사 개념" 형태의 짧은 대응 한 줄이다.'
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

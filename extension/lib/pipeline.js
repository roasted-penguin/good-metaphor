// 비유 생성 핵심(T-104). 확장(background.js)과 Node 평가 도구가 같은 코드를 쓴다.
// chrome.* 를 쓰지 않는다. LLM 호출(ask)·단계 알림(onStage)·뜻 먼저(onPartial)는 모두 주입받는다.
// 저장소·캐시·서버 모드·임베딩·검색·체인 구성은 부르는 쪽 몫이다.
import { parseJSONLoose } from './providers.js';
import { REJECTED_TEXT } from './analogy-server.js';
import { checkGrounding, GROUNDING_REJECTED_TEXT } from './grounding.js';
import { activeTerms, findBlocked, applyBlocklist } from './blocklist.js';
import { tagChoices, parseAbstractJudge, judgeTagProbs } from './judges.js';
import { buildAbstractPrompt, buildAbstractJudgePrompt, buildAnalogyPrompt, demoAnswer, extractMeaning, rewriteQueryText, endingIssues, endingRetryNote } from './prompt.js';

// 정밀 모드의 추상화 단계. 검색 전에 부른다(질의 문장을 바꾸므로).
// ask(system, user, opts) → 응답 문자열. 돌려주는 값: { abstractText, queryText, judge }
// tagJudge({ tags, floor })를 주면 같은 한 번의 호출로 태그 판정도 받는다(T-184, 호출 수·지연 그대로).
//   tags는 그래프의 통제 어휘(tags.json에서 온 graph.tags, 규칙 9). judge = { answers, probs }:
//   answers는 없음 포함 전체 확률(debug용), probs는 judgeTagProbs(없음·하한 적용) 결과로 retrieve tagJudge.p에 넘긴다.
//   응답에 판정이 없으면 probs null(검색은 판정 없이). tagJudge가 없으면 예전 글 응답 그대로, judge null
export async function runAbstract({ sentence, word, pageTitle, ask, onStage = () => {}, tagJudge = null }) {
  onStage('abstract');
  if (!tagJudge) {
    const p = buildAbstractPrompt({ sentence, word, pageTitle });
    const abstractText = (await ask(p.system, p.user, { json: false })).trim();
    return { abstractText, queryText: rewriteQueryText(abstractText, sentence), judge: null };
  }
  const choices = tagChoices(tagJudge.tags || []);
  const p = buildAbstractJudgePrompt({ sentence, word, pageTitle, choices });
  const { abstractText, answers } = parseAbstractJudge(await ask(p.system, p.user, { json: true }), choices);
  return {
    abstractText,
    queryText: rewriteQueryText(abstractText, sentence),
    judge: { answers, probs: judgeTagProbs(answers, { floor: tagJudge.floor ?? 0 }) }
  };
}

// 후보 → 비유 프롬프트 → LLM → 파싱 → 규칙 1 nodeId 검증 → 근거 검사(T-123) → 금칙어 검사(T-114).
// - providerKind 가 'demo' 면 LLM 없이 demoAnswer.
// - onPartial({ meaning }) 은 스트리밍 중 meaning 이 처음 완성될 때 한 번. 비유는 넣지 않는다(검증 전이라서).
//   뜻에 금칙어가 있으면 보내지 않는다
// - blocklist: 금칙어 용어 카드 배열(data/common/blocklist.json 의 terms). 부르는 쪽이 읽어 준다. 없으면 빈 목록
// - JSON 이 아니면 '모델 응답을 해석하지 못했어요: …' 오류를 던진다.
// - 끝맺음 검사(T-122): meaning·analogy가 합쇼체·해라체로 끝나면 교정 문구로 한 번만 다시 부른다(endingRetry=false면 표시만).
//   어긴 경우에만 호출이 하나 늘고, 다시 불러도 어기거나 실패하면 결과는 그대로 두고 ending.ok=false로 표시한다.
//   다시 부른 답도 아래 규칙 1·근거·금칙어 검사를 똑같이 거친다
// 돌려주는 값: { answer, chosen, rejected, grounding, groundingHidden, evidence, blocked, ending }
//   ending: { ok, retried, issues: [{ field, style }] } (데모는 null). issues는 마지막에 본 답 기준
//   answer: 검증 뒤의 모델 답(규칙 1·근거·금칙어 위반이면 analogy '', rejected 문구)
//   chosen: 검증을 통과한 후보(없으면 null), grounding: 근거 검사 결과(검사 안 했으면 null)
//   groundingHidden: 근거 검사로 숨긴 비유 { analogy, nodeId } 또는 null(T-146 기기 안 기록용, 결과에 싣지 않는다)
//   blocked: 금칙어에 걸린 첫 필드 { field, term: '(가림)' } 또는 null. 금칙어 자체는 담지 않는다
export async function runAnalogy({ sentence, word, context, pageTitle, graph, candidates, ask, providerKind, onStage = () => {}, onPartial = null, blocklist = [], endingRetry = true }) {
  onStage('generate');
  const terms = activeTerms(blocklist);
  let answer;
  let ending = null;
  if (providerKind === 'demo') {
    answer = demoAnswer({ candidates, analogyPrefix: graph.analogyPrefix });
  } else {
    const p = buildAnalogyPrompt({ sentence, context, word, pageTitle, domain: graph.domain, analogyPrefix: graph.analogyPrefix, candidates });
    let sentMeaning = false;
    const onText = onPartial && (text => {
      if (sentMeaning) return;
      const meaning = extractMeaning(text);
      if (!meaning) return;
      sentMeaning = true;
      // 금칙어가 섞인 뜻은 먼저 보내지 않는다(최종 결과에서 지운다)
      if (!findBlocked(meaning, terms)) onPartial({ meaning });
    });
    const raw = await ask(p.system, p.user, { json: true, onText });
    answer = parseJSONLoose(raw);
    if (!answer) throw new Error('모델 응답을 해석하지 못했어요: ' + raw.slice(0, 120));

    // 끝맺음 검사(T-122). 다시 부를 때는 뜻 먼저(onText)를 다시 보내지 않는다(이미 말풍선에 있음).
    // 규칙 1로 어차피 숨겨질 비유(후보 밖 nodeId)는 보지 않는다(헛 호출을 막는다)
    const shown = a => endingIssues(a).filter(i => i.field !== 'analogy' || candidates.some(c => c.id === a.nodeId));
    const issues = shown(answer);
    ending = { ok: !issues.length, retried: false, issues };
    if (issues.length && endingRetry) {
      ending.retried = true;
      try {
        const fixed = parseJSONLoose(await ask(p.system, p.user + endingRetryNote(issues, answer), { json: true }));
        if (fixed) {
          const again = shown(fixed);
          answer = fixed;
          ending.ok = !again.length;
          if (again.length) ending.issues = again;
        }
      } catch {
        // 다시 부르기 실패(429 등)나 JSON 아님은 첫 답을 그대로 쓴다
      }
    }
  }

  // 근거 검증(규칙 1): 후보에 없는 노드를 댔으면 비유를 버린다
  let chosen = candidates.find(c => c.id === answer.nodeId) || null;
  if (answer.analogy && !chosen) {
    answer.analogy = '';
    answer.rejected = REJECTED_TEXT;
  }
  // 근거 검사(T-123): 고른 노드 facts 밖의 사실(usedFact 불일치, 지어낸 숫자)이면 비유를 버린다
  let grounding = null;
  let groundingHidden = null;
  if (answer.analogy && chosen) {
    const labels = [chosen.label, ...(chosen.neighbors || []).map(n => n.label)];
    grounding = checkGrounding({ analogy: answer.analogy, usedFact: answer.usedFact, facts: chosen.facts, sentence, context, labels });
    if (!grounding.ok) {
      // 숨긴 비유는 기기 안 오탐률 기록(T-146)에만 넘긴다. 말풍선·결과 캐시에는 싣지 않는다
      groundingHidden = { analogy: answer.analogy, nodeId: chosen.id };
      answer.analogy = '';
      answer.rejected = GROUNDING_REJECTED_TEXT;
      chosen = null;
    }
  }

  // 금칙어 검사(T-114, 규칙 11): 규칙 1·근거 검사 뒤 출력 직전. 어느 필드든 걸리면 비유·대응을 숨기고,
  // 뜻에서 걸리면 뜻도 지운다. debug 에는 필드 이름만 남긴다
  let blocked;
  ({ answer, blocked } = applyBlocklist(answer, terms));
  if (blocked) chosen = null;

  const evidence = chosen ? {
    nodeId: chosen.id,
    nodeLabel: chosen.label,
    source: chosen.source,
    tagLabel: graph.tags.find(t => t.id === answer.tagId)?.label || chosen.tag?.label || null,
    // 공통 노드의 검수 날짜(T-118). 말풍선이 "검수 YYYY-MM"으로 보인다. 사용자 노드·날짜 없음은 null
    verifiedAt: chosen.source === 'common' ? (graph.nodes || []).find(n => n.id === chosen.id)?.verifiedAt || null : null
  } : null;
  return { answer, chosen, rejected: answer.rejected || null, grounding, groundingHidden, evidence, blocked, ending };
}

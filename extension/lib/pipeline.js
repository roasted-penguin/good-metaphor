// 비유 생성 핵심(T-104). 확장(background.js)과 Node 평가 도구가 같은 코드를 쓴다.
// chrome.* 를 쓰지 않는다. LLM 호출(ask)·단계 알림(onStage)·뜻 먼저(onPartial)는 모두 주입받는다.
// 저장소·캐시·서버 모드·임베딩·검색·체인 구성은 부르는 쪽 몫이다.
import { parseJSONLoose } from './providers.js';
import { REJECTED_TEXT } from './analogy-server.js';
import { checkGrounding, GROUNDING_REJECTED_TEXT } from './grounding.js';
import { buildAbstractPrompt, buildAnalogyPrompt, demoAnswer, extractMeaning, rewriteQueryText } from './prompt.js';

// 정밀 모드의 추상화 단계. 검색 전에 부른다(질의 문장을 바꾸므로).
// ask(system, user, opts) → 응답 문자열. 돌려주는 값: { abstractText, queryText }
export async function runAbstract({ sentence, word, pageTitle, ask, onStage = () => {} }) {
  onStage('abstract');
  const p = buildAbstractPrompt({ sentence, word, pageTitle });
  const abstractText = (await ask(p.system, p.user, { json: false })).trim();
  return { abstractText, queryText: rewriteQueryText(abstractText, sentence) };
}

// 후보 → 비유 프롬프트 → LLM → 파싱 → 규칙 1 nodeId 검증 → 근거 검사(T-123).
// - providerKind 가 'demo' 면 LLM 없이 demoAnswer.
// - onPartial({ meaning }) 은 스트리밍 중 meaning 이 처음 완성될 때 한 번. 비유는 넣지 않는다(검증 전이라서)
// - JSON 이 아니면 '모델 응답을 해석하지 못했어요: …' 오류를 던진다.
// 돌려주는 값: { answer, chosen, rejected, grounding, evidence }
//   answer: 검증 뒤의 모델 답(규칙 1·근거 위반이면 analogy '', rejected 문구)
//   chosen: 검증을 통과한 후보(없으면 null), grounding: 근거 검사 결과(검사 안 했으면 null)
export async function runAnalogy({ sentence, word, context, pageTitle, graph, candidates, ask, providerKind, onStage = () => {}, onPartial = null }) {
  onStage('generate');
  let answer;
  if (providerKind === 'demo') {
    answer = demoAnswer({ candidates, analogyPrefix: graph.analogyPrefix });
  } else {
    const p = buildAnalogyPrompt({ sentence, context, word, pageTitle, domain: graph.domain, analogyPrefix: graph.analogyPrefix, candidates });
    let sentMeaning = false;
    const onText = onPartial && (text => {
      if (sentMeaning) return;
      const meaning = extractMeaning(text);
      if (meaning) { sentMeaning = true; onPartial({ meaning }); }
    });
    const raw = await ask(p.system, p.user, { json: true, onText });
    answer = parseJSONLoose(raw);
    if (!answer) throw new Error('모델 응답을 해석하지 못했어요: ' + raw.slice(0, 120));
  }

  // 근거 검증(규칙 1): 후보에 없는 노드를 댔으면 비유를 버린다
  let chosen = candidates.find(c => c.id === answer.nodeId) || null;
  if (answer.analogy && !chosen) {
    answer.analogy = '';
    answer.rejected = REJECTED_TEXT;
  }
  // 근거 검사(T-123): 고른 노드 facts 밖의 사실(usedFact 불일치, 지어낸 숫자)이면 비유를 버린다
  let grounding = null;
  if (answer.analogy && chosen) {
    const labels = [chosen.label, ...(chosen.neighbors || []).map(n => n.label)];
    grounding = checkGrounding({ analogy: answer.analogy, usedFact: answer.usedFact, facts: chosen.facts, sentence, context, labels });
    if (!grounding.ok) {
      answer.analogy = '';
      answer.rejected = GROUNDING_REJECTED_TEXT;
      chosen = null;
    }
  }

  const evidence = chosen ? {
    nodeId: chosen.id,
    nodeLabel: chosen.label,
    source: chosen.source,
    tagLabel: graph.tags.find(t => t.id === answer.tagId)?.label || chosen.tag?.label || null
  } : null;
  return { answer, chosen, rejected: answer.rejected || null, grounding, evidence };
}

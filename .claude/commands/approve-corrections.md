---
description: 사용자 교정 내보내기(JSON)를 검토해 공통 태그 예문·평가셋·회귀 가드에 반영한다 (T-131, ADR 0010 3단계)
argument-hint: "<내보낸 JSON 경로, 예: ~/Downloads/good-metaphor-corrections-2026-11-09.json>"
---

설정 "내 피드백" → **운영자용 교정 내보내기**로 받은 파일 "$ARGUMENTS"를 공통 그래프에 반영한다. 공통 그래프는 모든 사용자의 검색 근거이므로, 사람이 읽고 고른 것만 넣고 회귀 0을 확인한 뒤에만 새 판본을 낸다(ADR 0010 "운영자 승인 뒤", T-113 원칙). 코드는 공통 그래프·`tags.json`을 고치지 않는다(규칙 3). 반영은 이 절차로 운영자가 손으로 한다.

먼저 `git fetch origin && git switch -c task/data-corrections-<날짜> origin/dev`로 브랜치를 만든다.

1. **파일 확인** `kind`가 `good-metaphor-corrections`이고 `version`이 1인지 본다. `commonGraphVersion`·`tagsVersion`이 지금 `extension/data/common/maplestory.json`·`tags.json`의 `version`과 다르면 그 사이 바뀐 태그·노드를 감안해 읽는다(없어진 태그 id 후보는 버린다).
2. **평가 문장 베끼기 거르기** `npm run check:corrections -- "$ARGUMENTS"`. 평가셋·검증셋·가드 문장과 글자 3-gram 자카드 0.5 이상인 예문 후보는 `copies-eval`로 빠진다(평가 문장을 예문으로 넣으면 평가가 무의미해진다). 지금 금칙어 목록으로 한 번 더 거르고, 이미 평가셋에 있는 평가·가드 후보도 뺀다. 결과는 `<이름>.checked.json`. 확장 안에서는 이 대조를 하지 않으므로(확장은 `tools/`를 못 읽는다) 이 단계를 건너뛰지 않는다.
3. **사람이 읽고 고르기** `.checked.json`의 `exampleCandidates`를 하나씩 읽는다. `count`가 클수록 여러 번 들어온 교정이다.
   - 금칙어·멸칭·실존 인물(규칙 11)이 없는지 다시 본다. 자동 필터가 못 잡은 우회 표기도 있다.
   - 개인정보가 없는지 본다. 숫자·메일·주소는 가려져 있지만(`[숫자]`·`[메일]`·`[주소]`) **사람 이름은 가리지 않는다.** 이름·회사명·특정 장소가 있으면 버리거나 일반 표현으로 고친다.
   - **분야 중립 예문**인지 본다. 태그 예문은 "다른 분야에서 같은 구조"를 보여 주는 문장이어야 한다(T-113). 게임 용어로 쓴 문장, 태그의 추상 구조(`desc`)와 맞지 않는 문장은 버린다.
   - `[숫자]`가 남은 문장은 뜻이 살도록 자연스럽게 고친다(구체 수치를 새로 지어 넣지 않는다).
   - 새 태그 id는 만들지 않는다(규칙 9). 후보의 `tagId`가 맞지 않으면 기존 태그 중 맞는 것으로 옮기거나 버린다.
4. **예문 추가** 고른 문장을 `extension/data/common/tags.json`의 그 태그 `examples` **맨 뒤에** 넣는다. 태그 순서·다른 태그는 건드리지 않는다(ADR 0012).
5. **회귀 확인(필수)** `npm run eval -- --guard -v`를 실제 확장으로 돌린다(ADR 0011, Node 수치는 보고하지 않는다. `debug.embedderId`가 실제 모델인지 확인). 가드 문장이 하나라도 새로 틀리면 원인 예문을 빼고 다시 돌린다. 회귀 0이 될 때까지 반복한다. `npm run eval -v`로 평가셋·검증셋 hit@1도 본다. 틀리던 문장이 맞게 되면 좋고, 잘 맞던 문장이 틀려지면 그 예문은 넣지 않는다(CLAUDE.md "함정").
6. **평가셋·가드 후보** 한 문장은 **예문이나 평가 문장 중 한쪽에만** 쓴다(같은 문장이 두 곳에 들어가면 평가가 무의미해진다). 4단계에서 예문으로 쓴 문장은 여기서 버린다.
   - `evalCandidates` 중 고른 것을 `tools/eval-set.json`에(학습에 쓰지 않는 검증용이면 `tools/eval-holdout.json`에) `{ sentence, expectNodes, expectTag }` 모양으로. `source` 필드는 빼고, 3단계와 같은 기준(개인정보·분야 중립·[숫자] 정리)으로 읽는다. `expectNodes`가 정말 맞는 개념인지 사람이 판단한다(한 사용자의 교정이 틀렸을 수 있다).
   - `guardCandidates` 중 지금 `npm run eval -v`에서 실제로 맞히는 문장만 `tools/eval-guard.json`에 더한다. 가드에서 빼는 일은 사용자 승인 없이 하지 않는다.
7. **판본 올리기** 예문을 바꿨으면 `tags.json`의 `version`을 올리고, 공통 그래프 `maplestory.json`의 `version`도 올린다(서버·확장 결과 캐시 키에 둘이 들어간다).
8. `npm run test:unit`(그래프·태그 파일 무결성 포함)과 `npm test`를 통과시킨다.
9. **기록** `docs/EVAL_LOG.md`에 한 줄: 날짜, 반영한 예문 수(태그별), 평가셋·가드에 더한 수, `eval --guard` 결과(회귀 0), hit@1·hit@3 전후. 내보낸 원본 JSON 파일은 커밋하지 않는다(사용자 문장이다).
10. 커밋 메시지 `data: 사용자 교정 예문 반영 (<날짜>)`. `/ship` 절차로 push 후 dev로 PR. PR 본문에 추가한 예문 전문과 `eval --guard` 결과를 넣어 검수자가 바로 확인할 수 있게 한다.

회귀가 나면 그 예문을 빼고 5단계부터 다시 한다. 회귀를 감수하고 넣어야 할 이유가 있으면 멈추고 사용자에게 문장별로 보여 주고 묻는다.

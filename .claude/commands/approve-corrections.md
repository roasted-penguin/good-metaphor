---
description: 사용자 교정 내보내기(JSON)를 검토해 공통 태그 예문·평가셋·회귀 가드에 반영한다 (T-131, ADR 0010 3단계)
argument-hint: "<내보낸 JSON 경로, 예: ~/Downloads/good-metaphor-corrections-restaurant-2026-11-09.json>"
---

설정 "내 피드백" → **운영자용 교정 내보내기**로 받은 파일 "$ARGUMENTS"를 공통 그래프에 반영한다. 공통 그래프는 모든 사용자의 검색 근거이므로, 사람이 읽고 고른 것만 넣고 회귀 0을 확인한 뒤에만 새 판본을 낸다(ADR 0010 "운영자 승인 뒤", T-113 원칙). 코드는 공통 그래프·`tags.json`을 고치지 않는다(규칙 3). 반영은 이 절차로 운영자가 손으로 한다.

**관심사별 파일(T-157).** 내보내기는 설정에서 그때 고른 관심사 하나만 담는다. 파일 최상위 `interest`(파일 이름에도 들어 있음)를 먼저 보고, 아래 표에서 그 관심사 줄의 파일만 쓴다. `interest`가 없는 예전 파일은 메이플이다. 한 PR에 두 관심사 파일을 섞지 않는다.

| 관심사 (`interest`) | 그래프 | 평가셋 | 검증셋 | 홀드아웃 | 회귀 가드 |
| --- | --- | --- | --- | --- | --- |
| `maplestory` | `extension/data/common/maplestory.json` | `tools/eval-set.json` | `tools/eval-holdout.json` | `tools/eval-unseen.json` | `tools/eval-guard.json` |
| `restaurant` | `extension/data/common/restaurant.json` | `tools/eval-set-restaurant.json` | (없음) | `tools/eval-unseen-restaurant.json` | `tools/eval-guard-restaurant.json` |

태그 예문은 두 관심사가 **공유하는** `extension/data/common/tags.json`에 들어간다. 그래서 어느 관심사 교정이든 예문을 바꾸면 **메이플·식당 둘 다** 가드와 홀드아웃을 돌린다(5단계).

먼저 `git fetch origin && git switch -c task/data-corrections-<날짜> origin/dev`로 브랜치를 만든다.

1. **파일 확인** `kind`가 `good-metaphor-corrections`이고 `version`이 1인지, `interest`가 무엇인지 본다. `commonGraphVersion`·`tagsVersion`이 지금 그 관심사 그래프(표)·`tags.json`의 `version`과 다르면 그 사이 바뀐 태그·노드를 감안해 읽는다(없어진 태그 id 후보는 버린다).
2. **평가 문장 베끼기 거르기** `npm run check:corrections -- "$ARGUMENTS"`. 도구가 파일의 `interest`를 읽어 그 관심사 평가 파일(표)과 대조하고, 그 관심사 그래프에 없는 노드를 가리키는 후보는 빼며 개수를 "주의"로 알린다(모르는 관심사면 오류로 멈춘다). 평가셋·검증셋·홀드아웃·가드 문장과 글자 3-gram 자카드 0.5 이상인 예문 후보는 `copies-eval`로 빠진다(평가 문장을 예문으로 넣으면 평가가 무의미해진다). 지금 금칙어 목록으로 한 번 더 거르고, 이미 평가셋에 있는 평가·가드 후보와 지금 `tags.json` 공통 예문과 자카드 0.5 이상인 평가·가드 후보도 뺀다. 예문 후보이기도 한 평가·가드 후보에는 `alsoExampleCandidate: true`가 붙고 도구가 개수를 "주의"로 알린다. 결과는 `<이름>.checked.json`. 확장 안에서는 이 대조를 하지 않으므로(확장은 `tools/`를 못 읽는다) 이 단계를 건너뛰지 않는다.
3. **사람이 읽고 고르기** `.checked.json`의 `exampleCandidates`를 하나씩 읽는다. `count`가 클수록 여러 번 들어온 교정이다.
   - 금칙어·멸칭·실존 인물(규칙 11)이 없는지 다시 본다. 자동 필터가 못 잡은 우회 표기도 있다.
   - 개인정보가 없는지 본다. 숫자·메일·주소는 가려져 있지만(`[숫자]`·`[메일]`·`[주소]`) **사람 이름은 가리지 않는다.** 이름·회사명·특정 장소가 있으면 버리거나 일반 표현으로 고친다.
   - **분야 중립 예문**인지 본다. 태그 예문은 "다른 분야에서 같은 구조"를 보여 주는 문장이어야 한다(T-113). 게임 용어로 쓴 문장, 태그의 추상 구조(`desc`)와 맞지 않는 문장은 버린다.
   - `[숫자]`가 남은 문장은 뜻이 살도록 자연스럽게 고친다(구체 수치를 새로 지어 넣지 않는다).
   - 새 태그 id는 만들지 않는다(규칙 9). 후보의 `tagId`가 맞지 않으면 기존 태그 중 맞는 것으로 옮기거나 버린다.
4. **예문 추가** 고른 문장을 `extension/data/common/tags.json`의 그 태그 `examples` **맨 뒤에** 넣는다. 태그 순서·다른 태그는 건드리지 않는다(ADR 0012).
5. **회귀 확인(필수)** `tags.json`은 공유라 **두 관심사 모두** 돌린다: 메이플 `npm run eval -- --guard -v`, 식당 `npm run eval -- --interest restaurant --guard -v`. 실제 확장으로 돌린다(ADR 0011, Node 수치는 보고하지 않는다. `debug.embedderId`가 실제 모델인지 확인). 가드 문장이 하나라도 새로 틀리면 원인 예문을 빼고 다시 돌린다. 회귀 0이 될 때까지 반복한다. `npm run eval -v`로 평가셋·검증셋 hit@1도 본다. 틀리던 문장이 맞게 되면 좋고, 잘 맞던 문장이 틀려지면 그 예문은 넣지 않는다(CLAUDE.md "함정").
   - 예문을 바꾸면 홀드아웃도 두 관심사 모두 돌려 — 메이플 `npm run eval -- --holdout -v`(`tools/eval-unseen.json`), 식당 `npm run eval -- --interest restaurant --holdout -v`(`tools/eval-unseen-restaurant.json`) — 순위가 떨어지지 않는지 본다(T-150). 홀드아웃 문장은 예문을 고를 때 보지 않고, 여기에 교정 문장을 넣지 않는다. 출력 끝 "여유 작은 문장" 목록도 늘지 않았는지 본다.
6. **평가셋·가드 후보** 한 문장은 **예문이나 평가셋·가드 중 한 곳에만** 쓴다(같은 문장이 두 곳에 들어가면 평가가 무의미해진다).
   - `alsoExampleCandidate: true`인 후보는 4단계에서 같은 문장을 예문으로 넣었으면 버리고, 예문으로 넣지 않았을 때만 평가·가드 후보로 읽는다. 확인: 이번에 넣은 예문과 평가·가드에 넣을 문장 사이에 비슷한 문장이 없는지 다시 `npm run check:corrections`로 본다(4단계 뒤 `tags.json`이 바뀌었으니 공통 예문 대조가 그 문장을 평가·가드 후보에서 뺀다).
   - `evalCandidates` 중 고른 것을 그 관심사 평가셋(표, 메이플 `tools/eval-set.json` / 식당 `tools/eval-set-restaurant.json`)에(메이플에서 학습에 쓰지 않는 검증용이면 `tools/eval-holdout.json`에) `{ sentence, expectNodes, expectTag }` 모양으로. `source`·`alsoExampleCandidate` 필드는 빼고, 3단계와 같은 기준(개인정보·분야 중립·[숫자] 정리)으로 읽는다. `expectNodes`가 정말 맞는 개념인지 사람이 판단한다(한 사용자의 교정이 틀렸을 수 있다).
   - `guardCandidates` 중 지금 그 관심사 평가(`npm run eval -v` / `npm run eval -- --interest restaurant -v`)에서 실제로 맞히는 문장만 그 관심사 가드(표)에 더한다. 식당 가드 파일은 문장만 담은 배열이다. 가드에서 빼는 일은 사용자 승인 없이 하지 않는다.
7. **판본 올리기** 예문을 바꿨으면 `tags.json`의 `version`을 올리고, 그 관심사 공통 그래프(표)의 `version`도 올린다(서버·확장 결과 캐시 키에 둘이 들어간다).
8. `npm run test:unit`(그래프·태그 파일 무결성 포함)과 `npm test`를 통과시킨다.
9. **기록** `docs/EVAL_LOG.md`에 한 줄: 날짜, 반영한 예문 수(태그별), 평가셋·가드에 더한 수, 관심사, 두 관심사의 `eval --guard` 결과(회귀 0), hit@1·hit@3 전후. 내보낸 원본 JSON 파일은 커밋하지 않는다(사용자 문장이다).
10. 커밋 메시지 `data: 사용자 교정 예문 반영 (<날짜>)`. `/ship` 절차로 push 후 dev로 PR. PR 본문에 추가한 예문 전문과 `eval --guard` 결과를 넣어 검수자가 바로 확인할 수 있게 한다.

회귀가 나면 그 예문을 빼고 5단계부터 다시 한다. 회귀를 감수하고 넣어야 할 이유가 있으면 멈추고 사용자에게 문장별로 보여 주고 묻는다.

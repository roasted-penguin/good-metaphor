# 반자동 노드 파이프라인 (T-194)

관심사마다 노드 1,000개를 손으로 고르기는 어렵다. 이 도구는 공식·공공 페이지에서 후보 개념을 뽑고, 자동 검사와 회귀 관문을 거친 것만 공통 그래프 패치로 만든다. 사람(또는 메인 세션)은 리뷰 시트를 보고 승인만 한다.

```
index → draft → check → (승인 id 고르기) → gate(fallback) → gate(browser) → apply
```

작업 파일은 모두 `.tmp/node-pipeline/`에 둔다(커밋하지 않음).

## 지키는 규칙

- **원문 저장 금지(D-5).** 페이지 본문은 초안 호출 동안 메모리에만 있다. 디스크에는 URL, 제목, 가져온 시각, 본문 해시, 우리 말로 쓴 사실, 겹침 지표(숫자)만 남는다.
- **공식 출처만.** 메이플은 `maplestory.nexon.com`, 식당은 `*.go.kr`, `www.korea.kr`, `www.sbiz.or.kr`(`sources.mjs` `allowHost`). 출처 주소는 LLM이 아니라 파이프라인이 붙인다.
- **예의 바른 수집.** 호스트마다 1초에 1번 이하, robots.txt를 지키고(가장 긴 규칙 우선), UA에 도구 이름을 밝힌다. 메이플 가이드 목록은 스크립트로 그려져서 robots가 허용하는 공식 가이드 검색(`/Guide/N23GameInformation/Articles/Search`)을 주제어로 돌린다.
- **규칙 2·9·11.** 자주 바뀌는 수치(확률, 판본, 날짜, 가격, 레벨, 횟수)는 실패로 친다(메이플은 `6차` 같은 차수만 허용, 식당은 숫자가 하나라도 있으면 실패). 태그는 `tags.json` 목록 안의 것만 받는다. 금칙어는 `blocklist.json`에서 `승인` 상태인 카드만 쓴다.
- **회귀 0.** 실제 그래프에는 실제 확장 관문(`gate --embedder browser`)을 통과한 노드만 쓴다(`apply --write-real`은 `--gate browser`일 때만 동작).

## 명령

```bash
# 1. 색인: 목록 페이지 → 상세 페이지 URL·제목 (본문은 읽지 않음)
npm run node-pipeline:index -- --interest maplestory [--pages 3]

# 2. 초안: 색인에서 아직 안 한 페이지 N개 → 페이지마다 LLM 1번 → 후보 (묶음 번호 자동)
#    키는 GEMINI_API_KEY 등 환경 변수(값은 출력하지 않음). Gemini 무료 한도는 하루 500번을 다른 작업과 나눠 쓴다
npm run node-pipeline:draft -- --interest maplestory --limit 10 [--kind guide,update] [--provider gemini] [--model ...]

# 3. 자동 검사 → 리뷰 시트 .tmp/node-pipeline/<관심사>-batch-N.md (+ .json)
npm run node-pipeline:check -- --interest maplestory [--batch N] [--no-probe]

# 4. 회귀 관문: 후보를 그래프 사본에 넣어 평가 문장(평가셋·검증셋·홀드아웃·가드)으로 잰다
npm run node-pipeline:gate -- --interest maplestory --batch N [--approve ids.json]                    # 대체 임베더(거름)
npm run node-pipeline:gate -- --interest maplestory --batch N --approve .tmp/node-pipeline/maplestory-batch-N.accepted-fallback.json --embedder browser   # 실제 확장(최종)

# 5. 반영: 승인 id 중 관문을 통과한 것만 패치. 기본 출력은 .tmp 사본
npm run node-pipeline:apply -- --interest maplestory --batch N --approve ids.json [--gate browser|fallback|none] [--out 경로]
npm run node-pipeline:apply -- --interest maplestory --batch N --approve ids.json --write-real          # 실제 그래프(관문 browser 필수)
```

승인 파일은 id 문자열 JSON 배열이다(`["guild_castle", "daily_gift"]`). 실패 후보는 apply가 받지 않는다.

## 자동 검사 (check)

| 판정 | 사유 |
| --- | --- |
| 실패 | id 꼴(영문 소문자·숫자·밑줄), 그래프·묶음 안 id·이름 중복, 사실 2~3개 아님, 200자 넘음, "다."로 안 끝남, 수치, 금칙어, 목록 안 태그 없음, 출처가 허용 밖·https 아님·200 아님·허용 밖으로 넘어감, 기존 노드와 거의 같음(대체 임베더 코사인 0.75 이상), 원문을 40자 넘게 그대로 옮김, 식당은 영문·이름 숫자 |
| 확인 | 목록 밖 태그를 뺌, 별칭(은어)은 사람이 확인, 식당 별칭은 뺌, 첫 사실이 구조보다 정의에 가까움, 비슷한 노드 있음(0.5 이상 또는 이름 포함), 이름이 본문에 없음, 사실과 본문 겹침이 적음(페이지 밖 지식 의심), 원문 25자 이상 그대로, 없는 노드를 가리키는 엣지를 뺌 |

기준값은 `check.mjs` 맨 위 상수다. 코사인 기준은 기존 그래프의 서로 다른 노드끼리 최고값(메이플 0.47, 식당 0.40)보다 위로 잡았다.

## 회귀 관문 (gate)

`npm run eval:fallback`과 실제 확장 `npm run eval`과 같은 재료(`mergeGraphs`, `embedItems`, `retrieve` 혼합 기본값, `marginOf`)로 채점한다. 다른 점은 그래프를 파일이 아니라 사본 객체로 받는 것뿐이다. 질의 벡터와 기존 노드 벡터는 한 번만 만들고, 후보마다 새 노드 글만 더 임베딩한다. 그래서 크롬에서도 후보 수십 개를 몇 분 안에 잴 수 있다.

문장마다 후보 없는 그래프와 비교한다.

- **1위 회귀:** 맞던 문장이 틀림 → 그 문장 1위를 차지한 후보가 범인
- **음성 실패:** 음성 문장(forbidNodes)이 통과하다 실패
- **여유 악화:** 1위는 맞지만 여유가 줄어 얇은 선(`--margin`, 기본 0.005)보다 작아짐. `eval --margin-guard`의 "새로 얇아졌거나 바닥보다 더 얇아짐"과 같은 뜻이고, 가드 문장뿐 아니라 모든 문장에 건다. `--strict-margin`이면 가드 문장은 조금만 줄어도 실패
- 비유 없음 문장은 eval처럼 정보로만 본다

절차는 두 단계다. ① 후보를 하나씩 넣어 걸리는 후보를 뺀다. ② 남은 후보를 한꺼번에 넣어 다시 재고, 걸리면 범인만 빼고 다시 잰다(범인을 못 짚으면 문제 문장 상위 3에 든 후보를 뺀다). 결과는 `<관심사>-batch-N.gate-<임베더>.json`(사유), `<관심사>-batch-N.accepted-<임베더>.json`(채택 id)이다.

대체 임베더 관문은 값싼 앞 단계 거름이고, 판정은 실제 확장(`--embedder browser`, ADR 0011)으로 한다. 채택한 노드를 실제 그래프에 넣은 PR은 평소처럼 `npm run eval:fallback -- --baseline`(1위가 바뀐 문장이 있으면 `--write-baseline`), `npm run eval -- --guard`, `--holdout`, `--margin-guard`, `--interest restaurant --guard`로 한 번 더 확인한다.

## 파일

| 파일 | 하는 일 |
| --- | --- |
| `sources.mjs` | 관심사별 허용 호스트·목록·씨앗·본문 표지·검사 규칙 |
| `web.mjs` | robots.txt, 예의 바른 fetch, HTML → 글·링크·제목, 해시 |
| `run.mjs` | index(목록 → 색인), draft(페이지 → 후보) |
| `draft.mjs` | 페이지 초안 프롬프트(T-301 `buildDraftPrompt` 꼴), 답 파싱, 근거 지표(겹침·최장 복사) |
| `check.mjs` | 자동 검사, 리뷰 시트 |
| `gate.mjs` | 회귀 관문 |
| `apply.mjs` | 패치 만들기, 판본 올리기, 검증 |
| `cli.mjs` | 명령줄 |

단위 테스트: `tests/unit/node-pipeline.test.mjs`, `tests/unit/node-pipeline-flow.test.mjs`(가짜 fetch·LLM·평가).

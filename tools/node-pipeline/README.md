# 반자동 노드 파이프라인 (T-194, 수확·대안 정답 T-195, 태그 적합성·2위 대안 정답 T-197)

관심사마다 노드 1,000개를 손으로 고르기는 어렵다. 이 도구는 공식·공공 페이지에서 후보 개념을 뽑고, 자동 검사와 회귀 관문을 거친 것만 공통 그래프 패치로 만든다. 사람(또는 메인 세션)은 리뷰 시트를 보고 승인만 한다.

```
index → draft → check → (승인 id 고르기) → gate(fallback) → gate(browser) → (대안 정답 확인 → accept-alt) → apply
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
#    --probe-seeds: 씨앗마다 한 번 가져와 살아 있는지 색인에 probe로 기록(응답 없는 씨앗은 초안 순서 맨 뒤, T-198)
npm run node-pipeline:index -- --interest maplestory [--pages 3] [--probe-seeds]

# 2. 초안: 색인에서 아직 안 한 페이지 N개 → 절마다 LLM 1번 → 후보 (묶음 번호 자동)
#    키는 GEMINI_API_KEY 등 환경 변수(값은 출력하지 않음). Gemini 무료 한도는 하루 500번을 다른 작업과 나눠 쓴다.
#    --max-calls로 이번 실행 호출 상한(캐시 적중은 안 셈). 상한에 걸린 페이지는 다음 실행에 다시(이미 한 절은 캐시로 공짜)
npm run node-pipeline:draft -- --interest maplestory --limit 10 [--max-calls 40] [--kind guide,update] [--provider gemini] [--model ...]

# 3. 자동 검사 → 리뷰 시트 .tmp/node-pipeline/<관심사>-batch-N.md (+ .json)
#    태그 적합성(T-197)이 후보마다 LLM을 한 번 부른다(캐시). --max-calls 14로 나눠 돌리고, 못 한 후보는 다시 돌리면 이어 가요. --no-tag-fit이면 건너뜀
npm run node-pipeline:check -- --interest maplestory [--batch N] [--no-probe] [--max-calls 14] [--no-tag-fit]

# 4. 회귀 관문: 후보를 그래프 사본에 넣어 평가 문장(평가셋·검증셋·홀드아웃·가드)으로 잰다. --batch all이면 그 관심사 묶음을 모두 합쳐
npm run node-pipeline:gate -- --interest maplestory --batch N [--approve ids.json] [--explain]          # 대체 임베더(거름)
npm run node-pipeline:gate -- --interest maplestory --batch N --approve .tmp/node-pipeline/maplestory-batch-N.accepted-fallback.json --embedder browser   # 실제 확장(최종)

# 4-1. 대안 정답 확인: .alt-<임베더>.md 표를 보고, 맞는 줄은 같은 이름 .json에서 approve를 true로 → 평가 파일 expectNodes에 더함
npm run node-pipeline:accept-alt -- .tmp/node-pipeline/maplestory-batch-N.alt-browser.json [--dir tools]

# 5. 반영: 승인 id 중 관문을 통과한 것만 패치(대안 정답이 남은 노드는 accept-alt 뒤에만). 기본 출력은 .tmp 사본
npm run node-pipeline:apply -- --interest maplestory --batch N --approve ids.json [--gate browser|fallback|none] [--out 경로]
npm run node-pipeline:apply -- --interest maplestory --batch N --approve ids.json --write-real          # 실제 그래프(관문 browser 필수)
```

승인 파일은 id 문자열 JSON 배열이다(`["guild_castle", "daily_gift"]`). 실패 후보는 apply가 받지 않는다.

## 초안 수확 (T-195)

- **절 단위 초안.** 본문을 h1~h3 제목으로 나눠(`draft.mjs` `splitSections`) 절마다 LLM을 한 번 부른다. 예전에는 12,000자에서 잘려 긴 패치 노트는 목차·이벤트만 보였다. 건너뛸 절(`sources.mjs` `sectionSkip`: 메이플 이벤트·버닝·패스·오류 수정·댓글 등, 식당 메뉴·만족도 조사)과 너무 짧은 절은 부르지 않고, 1,500자보다 작은 절은 이웃과 합치고, 12,000자를 넘는 절은 줄 단위로 자르고, 페이지당 10덩어리까지. 건너뛸 페이지 제목은 `pageSkip`(메이플 "스킬 조정" 패치).
- **한 절에 여러 후보.** 프롬프트가 시스템·규칙·재화·제약을 빠짐없이 따로(보통 2~5개) 고르게 한다. 같은 페이지 앞 절에서 나온 개념은 다음 절의 [이미 있는 개념]에 들어간다.
- **맞는 태그 없음은 초안에서 버림.** 목록 안 태그가 하나도 없는 후보는 check에 넘기지 않고 초안 파일 `dropped`(사유 `noTags`, 출처·절)에 남긴다.
- **LLM 답 캐시.** `.tmp/node-pipeline/cache/llm-<해시>.json`(제공자·모델·프롬프트 해시 → LLM 답). 저장하는 것은 LLM이 우리 말로 쓴 답뿐이고 본문은 해시 키로만 쓴다(D-5).

## 식당 출처 (T-198)

식당은 목록 페이지가 거의 없어 씨앗(`sources.mjs` `restaurant.seeds`) 위주다. 종류(`kind`)와 초안 순서는 `law → local → agency → press`.

- **법령(국가법령정보센터):** 씨앗 주소는 사람이 여는 `https://www.law.go.kr/법령/<법령명>`이고 후보 출처도 이 주소다. 이 페이지는 껍데기라 `bodyFrom`(`lawBodyUrl`)이 껍데기에서 현행 판 번호(`lsiSeq`)·시행일(`efYd`)을 읽어 본문(`/LSW/lsInfoR.do`)을 한 번 더 가져온다(개정돼도 씨앗은 그대로). 장 제목(`<p class="gtit">`)을 절 표지로 쓰고(`content` `headingClasses`), 씨앗의 `keep`에 맞는 장만 초안한다(`keepSub`: 하위 "제N절"은 상위 장을 따름, `maxSections` 4). 벌칙·부칙 장은 `sectionSkip`. 판 번호를 못 읽으면 `no-body`로 건너뛴다.
- **지자체 보건소:** 동대문구 보건소 식품접객업 안내(시설기준·영업자 준수사항·식중독 예방·지위승계·원산지 등), 송파구 식품안심업소. 꼬리 절(컨텐츠 정보·담당자)은 `sectionSkip`.
- **기관:** 공정위 가맹 안내, 최저임금위원회 제도·자주 묻는 질문, 국세청 사업자 세무(카드·현금영수증 포함).
- **넣지 않은 것(2026-11-22):** 생활법령(easylaw) 503 지속(씨앗은 남겨 두고 `probe.ok=false`로 맨 뒤), 공정위 가맹사업거래(`franchise.ftc.go.kr`) 403, 소상공인24(`sbiz24.kr`)·소상공인시장진흥공단(`semas.or.kr`)은 허용 호스트 밖(식당 그래프 출처 테스트와 같은 기준이라 넓히지 않음), 식약처 게시판(첨부 파일 위주라 본문이 짧음), 고용노동부 정책안내(목록이 스크립트 링크), 정책브리핑 정책위키(2022년에 멈춘 기록 문서).

## 자동 검사 (check)

| 판정 | 사유 |
| --- | --- |
| 실패 | id 꼴(영문 소문자·숫자·밑줄), 그래프·묶음 안 id·이름 중복, 사실 2~3개 아님, 200자 넘음, "다."로 안 끝남, 수치, 금칙어, 목록 안 태그 없음, 출처가 허용 밖·https 아님·200 아님·허용 밖으로 넘어감, 기존 노드와 거의 같음(대체 임베더 코사인 0.75 이상), 원문을 40자 넘게 그대로 옮김, 식당은 영문·이름 숫자 |
| 확인 | 목록 밖 태그를 뺌, 별칭(은어)은 사람이 확인, 식당 별칭은 뺌, 첫 사실이 구조보다 정의에 가까움, 비슷한 노드 있음(0.5 이상 또는 이름 포함), 이름이 본문에 없음, 사실과 본문 겹침이 적음(페이지 밖 지식 의심), 원문 25자 이상 그대로, 없는 노드를 가리키는 엣지를 뺌 |

| 태그 적합성(T-197, `tag-fit.mjs`) | 실패: 태그가 하나도 안 남음(`tagFitNone`). 확인: LLM no 태그를 뺌(`tagFitDropped`), 못 물음·답 빠짐(`tagFitPending`) |

**태그 적합성(T-197).** T-195 관문 대안 정답 후보 17줄 중 14줄이 LLM no였다(예: 염색 개편 → random_reroll). 억지 태그가 관문까지 가면 같은 태그 문장의 1위·여유를 흔든다. 그래서 check에서 후보마다 LLM을 한 번 불러(태그 여러 개를 한 번에) 태그마다 "이 개념의 사실이 그 태그 구조를 실제로 드러내는가" yes/no와 한 문장 이유를 받는다. 기준 자료는 `tags.json`의 desc와 예문(다른 분야)이다. no 태그는 빼고, 남은 태그가 없으면 실패다. 이미 실패한 후보는 묻지 않는다. 판정과 이유는 리뷰 시트 "후보 자세히"와 `.json` `tagFit`에 남는다. 호출 상한(`--max-calls`)·429·키 없음이면 그 뒤 후보는 태그를 그대로 두고 `tagFitPending`이다.

기준값은 `check.mjs` 맨 위 상수다. 코사인 기준은 기존 그래프의 서로 다른 노드끼리 최고값(메이플 0.47, 식당 0.40)보다 위로 잡았다.

## 회귀 관문 (gate)

`npm run eval:fallback`과 실제 확장 `npm run eval`과 같은 재료(`mergeGraphs`, `embedItems`, `retrieve` 혼합 기본값, `marginOf`)로 채점한다. 다른 점은 그래프를 파일이 아니라 사본 객체로 받는 것뿐이다. 질의 벡터와 기존 노드 벡터는 한 번만 만들고, 후보마다 새 노드 글만 더 임베딩한다. 그래서 크롬에서도 후보 수십 개를 몇 분 안에 잴 수 있다.

문장마다 후보 없는 그래프와 비교한다.

- **1위 회귀:** 맞던 문장이 틀림 → 그 문장 1위를 차지한 후보가 범인
- **음성 실패:** 음성 문장(forbidNodes)이 통과하다 실패
- **여유 악화:** 1위는 맞지만 여유가 줄어 얇은 선(`--margin`, 기본 0.005)보다 작아짐. `eval --margin-guard`의 "새로 얇아졌거나 바닥보다 더 얇아짐"과 같은 뜻이고, 가드 문장뿐 아니라 모든 문장에 건다. `--strict-margin`이면 가드 문장은 조금만 줄어도 실패
- **비유 없음 침범(T-195):** 비유 없음 문장(`expectNodes: []`, 음성 문장 포함)의 1위를 후보가 차지함. 메인 판정(2026-11-22) "음성 문장(맞는 비유 없음)에 노드가 붙으면 그대로 회귀". 단 T-195 판정 (2)(T-197 구현): 대체 임베더 관문은 잡음이 커서(한 문장에 9개) 막지 않고 "실제 관문에서 판정"(`deferred`·`deferredIds`)으로만 표시해 다음 단계로 넘기고, 실제 확장 관문(`--embedder browser`)에서는 그대로 회귀
- **대안 정답 후보(T-195, 회귀 아님):** 맞던 문장의 1위를 후보가 가져갔지만 그 후보 태그에 문장의 `expectTag`가 있으면 막지 않고 따로 표(`<관심사>-batch-N.alt-<임베더>.md`·`.json`)로 낸다. 사용자 판정(2026-11-22) "한 문장에 대해 비유가 다양하게 나올 수도 있잖아". 줄마다 문장·셋·원래 정답·새 노드·expectTag·이유(휴리스틱: 공유 태그 뜻 + 문장에 가장 가까운 사실, `--explain`이면 LLM yes/no와 한 문장 이유)가 있고 모두 메인 확인 대상이다. 메인이 맞는 줄의 `approve`를 true로 바꾸고 `accept-alt`를 돌리면 그 관심사 평가 파일(평가셋·검증셋·홀드아웃, 가드는 문장 목록이라 그대로) `expectNodes`에 새 노드를 더한다. 그 전에는 apply가 그 노드를 받지 않는다. `expectTag`가 없는 후보가 1위를 가져가면 그대로 1위 회귀다
- **2위 대안 정답(T-195 판정 (1), T-197):** 새 노드가 정답 바로 밑(기대 밖 최고 경쟁자)에 들어와 여유를 0.005 아래로(또는 기록된 바닥보다 더) 얇게 만들어도, 그 노드에 문장의 `expectTag`가 있으면 여유 악화가 아니라 대안 정답 후보다(표의 "들어온 자리" 칸 `2위(여유 전→후)`, 같은 확인·accept-alt 절차). 1위가 그 노드로 바뀌어도 맞는 비유라 정확도 손상이 아니고, accept-alt로 `expectNodes`에 들어가면 여유도 원래대로 돌아온다. `expectTag`가 없는 노드가 여유를 깎으면 그대로 여유 악화
- `--cases-dir <폴더>`면 평가 파일을 `tools/` 대신 그 폴더에서 읽는다(accept-alt를 사본에 시연할 때)

절차는 두 단계다. ① 후보를 하나씩 넣어 걸리는 후보를 뺀다. ② 남은 후보를 한꺼번에 넣어 다시 재고, 걸리면 범인만 빼고 다시 잰다(범인을 못 짚으면 문제 문장 상위 3에 든 후보를 뺀다). 결과는 `<관심사>-batch-N.gate-<임베더>.json`(사유), `<관심사>-batch-N.accepted-<임베더>.json`(채택 id)이다.

대체 임베더 관문은 값싼 앞 단계 거름이고, 판정은 실제 확장(`--embedder browser`, ADR 0011)으로 한다. 채택한 노드를 실제 그래프에 넣은 PR은 평소처럼 `npm run eval:fallback -- --baseline`(1위가 바뀐 문장이 있으면 `--write-baseline`), `npm run eval -- --guard`, `--holdout`, `--margin-guard`, `--interest restaurant --guard`로 한 번 더 확인한다.

## 파일

| 파일 | 하는 일 |
| --- | --- |
| `sources.mjs` | 관심사별 허용 호스트·목록·씨앗·본문 표지·검사 규칙, 법령 껍데기 → 본문 주소(`lawBodyUrl`·`bodyUrlFor`), 씨앗 설정 찾기(`seedFor`) |
| `web.mjs` | robots.txt, 예의 바른 fetch, HTML → 글·링크·제목, 해시 |
| `run.mjs` | index(목록 → 색인), draft(페이지 → 후보), 씨앗 확인(`probeSeeds`·`markProbes`) |
| `draft.mjs` | 페이지 초안 프롬프트(T-301 `buildDraftPrompt` 꼴), 답 파싱·태그 없음 버림, 근거 지표(겹침·최장 복사), 절 나누기 |
| `check.mjs` | 자동 검사, 리뷰 시트 |
| `tag-fit.mjs` | 태그 적합성 LLM 검사(프롬프트·답 파싱·결과 반영, T-197) |
| `gate.mjs` | 회귀 관문, 대안 정답 후보 표·이유, accept-alt(평가 파일 한 줄 꼴 그대로 고치기) |
| `apply.mjs` | 패치 만들기, 판본 올리기, 검증 |
| `cli.mjs` | 명령줄 |

단위 테스트: `tests/unit/node-pipeline.test.mjs`, `tests/unit/node-pipeline-flow.test.mjs`(가짜 fetch·LLM·평가), `tests/unit/node-pipeline-sources.test.mjs`(법령 본문·남길 장·씨앗 확인, T-198), `tests/unit/node-pipeline-tagfit.test.mjs`(태그 적합성·2위 대안 정답·비유 없음 미루기, T-197).

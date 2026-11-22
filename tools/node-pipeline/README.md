# 반자동 노드 파이프라인 (T-194, 수확·대안 정답 T-195, 태그 적합성·2위 대안 정답 T-197, 묶음 사이 중복·조문 이름 근거 T-205, 커뮤니티 출처 T-212)

관심사마다 노드 1,000개를 손으로 고르기는 어렵다. 이 도구는 공식·공공 페이지에서 후보 개념을 뽑고, 자동 검사와 회귀 관문을 거친 것만 공통 그래프 패치로 만든다. 사람(또는 메인 세션)은 리뷰 시트를 보고 승인만 한다.

```
index → draft → check → (승인 id 고르기) → gate(fallback) → gate(browser) → (대안 정답 확인 → accept-alt) → apply
```

작업 파일은 모두 `.tmp/node-pipeline/`에 둔다(커밋하지 않음).

## 지키는 규칙

- **원문 저장 금지(D-5).** 페이지 본문은 초안 호출 동안 메모리에만 있다. 디스크에는 URL, 제목, 가져온 시각, 본문 해시, 우리 말로 쓴 사실, 겹침 지표(숫자)만 남는다.
- **수집은 공식 출처만.** 목록·초안은 메이플 `maplestory.nexon.com`, 식당 `*.go.kr`, `www.korea.kr`, `www.sbiz.or.kr`(`sources.mjs` `allowHost`)만 돈다. 출처 주소는 LLM이 아니라 파이프라인이 붙인다.
- **커뮤니티 출처는 확인용(D-8, ADR 0016).** 정책 원본 `tools/source-policy.json`(메이플: 나무위키 `/w/`·인벤 메이플, 식당: 나무위키·티스토리·브런치·다음 뉴스). 커뮤니티 페이지는 색인·초안하지 않고, 사람·에이전트가 읽고 우리 문장으로 쓴 후보(수동 초안 파일 `.tmp/node-pipeline/<관심사>-batch-N.draft.json`의 `candidates`, `grounding` 없이)의 `sources`에 URL로만 들어온다. check가 ① 교차 확인(공식 1개 이상 또는 서로 다른 커뮤니티 사이트 2곳, 같은 플랫폼 두 글은 한 곳) ② 출처 페이지를 한 쪽씩 가져와(robots·1초 간격) 베낌(최장 복사 40자 실패·25자 확인)·겹침을 재고(글은 메모리에만, 결과엔 숫자만) ③ 노드에 `sourceKind: "community"`를 붙인다. 커뮤니티 출처는 `--no-probe`로 통과할 수 없다. 공식과 어긋나면 공식 우선(리뷰 판정).
- **예의 바른 수집.** 호스트마다 1초에 1번 이하, robots.txt를 지키고(가장 긴 규칙 우선), UA에 도구 이름을 밝힌다. 메이플 가이드 목록은 스크립트로 그려진다. T-207까지는 공식 가이드 검색을 주제어로 돌렸는데 쪽당 5개라 겹침이 많았고, T-208부터는 가이드 첫 화면 분류가 부르는 사이트 자체 목록 API(`POST /guide/n23gameinformation/articles?boardId=…`, robots 허용 경로, `sources.mjs` `MAPLE_GUIDE_BOARDS`)로 분류 9개 × 1번이면 가이드 107글 전부를 얻는다(검색으로 모은 100글을 모두 포함, 2026-11-23). 응답의 본문 칸은 버리고 글 번호·제목만 쓴다(`fetcher.postJson`, 목록 항목 `json.links`).
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
#    분당 한도(T-207): --gap-ms 4000(호출 사이 간격)·--retry-429 1(429면 60초 뒤 다시). 하루 한도(quotaId …PerDay…)면 결국 429로 멈춘다. 하루 한도는 모델마다 따로다

# 3. 자동 검사 → 리뷰 시트 .tmp/node-pipeline/<관심사>-batch-N.md (+ .json)
#    태그 적합성(T-197)이 후보마다 LLM을 한 번 부른다(캐시). --max-calls 14로 나눠 돌리고, 못 한 후보는 다시 돌리면 이어 가요. --no-tag-fit이면 건너뜀
#    조문 꼴 출처(식당 법령) 후보에 이름 신호가 없으면(T-205 전 초안) 페이지를 다시 가져와 잰다(LLM 없음). --no-probe·--no-reground면 건너뜀
npm run node-pipeline:check -- --interest maplestory [--batch N] [--no-probe] [--no-reground] [--max-calls 14] [--no-tag-fit] [--no-near-dup] [--dup-embedder e5|fallback]

# 4. 회귀 관문: 후보를 그래프 사본에 넣어 평가 문장(평가셋·검증셋·홀드아웃·가드)으로 잰다. --batch all이면 그 관심사 묶음을 모두 합쳐
npm run node-pipeline:gate -- --interest maplestory --batch N [--approve ids.json] [--explain]          # 대체 임베더(거름)
npm run node-pipeline:gate -- --interest maplestory --batch N --approve .tmp/node-pipeline/maplestory-batch-N.accepted-fallback.json --embedder browser   # 실제 확장(최종)

# 4'. 맥에서 크롬을 못 띄울 때(밤) 실제 확장 관문을 GitHub Actions로(T-196): 채택 후보만 최소 입력으로 커밋(우리 문장·출처 주소만, 원문 없음)
#     tools/node-pipeline/batches/<이름>-<관심사>.json = { interest, results: [{ status, node, edges }] }
gh workflow run eval.yml --ref <브랜치> -f suites=none -f gate_args="--interest maplestory --results tools/node-pipeline/batches/t196-maplestory.json; --interest restaurant --results tools/node-pipeline/batches/t196-restaurant.json"
gh run download <실행 번호> -n node-gate -D .tmp/node-pipeline    # <관심사>-batch-all.{gate,accepted,alt}-browser.*
#     CI에는 키가 없어 --explain을 못 한다. 받은 대안 표에 LLM 이유 칸만 나중에 채운다(T-207, 노드 사실은 같은 입력 파일에서)
npm run node-pipeline:explain-alt -- .tmp/node-pipeline/maplestory-batch-all.alt-browser.json --results tools/node-pipeline/batches/t207-maplestory.json --interest maplestory [--provider gemini]
#     apply·accept-alt 뒤 다시 잴 때는 --regate(그래프에서 후보를 빼고 기준을 잼): 앞 관문에서 다른 후보에 가려 안 보였던 2위 침범을 찾는다

# 4-1. 대안 정답 확인: .alt-<임베더>.md 표를 보고, 맞는 줄은 같은 이름 .json에서 approve를 true로 → 평가 파일 expectNodes에 더함
npm run node-pipeline:accept-alt -- .tmp/node-pipeline/maplestory-batch-N.alt-browser.json [--dir tools]

# 5. 반영: 승인 id 중 관문을 통과한 것만 패치(대안 정답이 남은 노드는 accept-alt 뒤에만). 기본 출력은 .tmp 사본
npm run node-pipeline:apply -- --interest maplestory --batch N --approve ids.json [--gate browser|fallback|none] [--out 경로]
npm run node-pipeline:apply -- --interest maplestory --batch N --approve ids.json --write-real          # 실제 그래프(관문 browser 필수)
```

승인 파일은 id 문자열 JSON 배열이다(`["guild_castle", "daily_gift"]`). 실패 후보는 apply가 받지 않는다.

## 초안 수확 (T-195)

- **목록별 제목 거름(T-207).** 목록 항목에 `titleFilter`·`titleSkip`을 둘 수 있다. 메이플 공지(`/News/Notice/Notice`)는 점검·오류·이벤트가 대부분이라 운영정책·월드 리프·보안 같은 제도 글만 색인한다. 제목 거름에 다 걸린 쪽은 빈 쪽이 아니라서 다음 쪽도 본다.
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
| 실패 | id 꼴(영문 소문자·숫자·밑줄), 그래프·묶음 안 id·이름 중복, 사실 2~3개 아님, 200자 넘음, "다."로 안 끝남, 수치, 금칙어, 목록 안 태그 없음, 출처가 정책 밖·https 아님·200 아님·정책 밖으로 넘어감, 커뮤니티 출처 교차 확인 없음(`communityUncorroborated`)·가져오지 않음(`communityUnprobed`), 기존 노드와 거의 같음(대체 임베더 코사인 0.75 이상), 원문(초안 페이지 또는 출처 페이지)을 40자 넘게 그대로 옮김(`copiedHeavy`·`copiedSourceHeavy`), 식당은 영문·이름 숫자 |
| 확인 | 목록 밖 태그를 뺌, 별칭(은어)은 사람이 확인, 식당 별칭은 뺌, 첫 사실이 구조보다 정의에 가까움, 비슷한 노드 있음(0.5 이상 또는 이름 포함), 이름이 본문에 없음, 사실과 본문 겹침이 적음(페이지 밖 지식 의심), 원문 25자 이상 그대로(`copied`·`copiedSource`), 사실과 겹치는 출처 페이지가 2곳 미만(`communityWeak`, 커뮤니티 노드), 식당 커뮤니티 후보의 가게 이름 확인(`storeNameReview`), 없는 노드를 가리키는 엣지를 뺌 |

| 묶음 사이 중복(T-205, `dedupe.mjs`) | 실패: 같은 id 또는 같은 이름이 다른 묶음에도 있고 그쪽을 남김(`dupCross`, 이유는 메모 "묶음 사이 중복(같은 id): 묶음 5 …를 남겨요") |
| 이름 근거(조문, T-205) | 조문 꼴 출처(`articleHosts`, 식당 = `www.law.go.kr`)는 이름 핵심 낱말이 본문·장/조 제목에 있으면 `labelNotInPage` 대신 메모 "이름 근거(조문)" |

| 근접 중복(T-197, `near-dup.mjs`) | 실패: 개념 글(이름. 사실) 코사인이 기존 노드끼리 가장 가까운 쌍(바닥)보다 높음(`nearDup`), 기존·앞선 후보 사실 문장 재사용(`factReused`). 확인: 바닥 − 0.03 이상(`nearDupClose`) |
| 태그 밀도(T-197, `near-dup.mjs`) | 확인만: 한 태그를 단 노드 수(그래프 + 앞 묶음 + 이 묶음)가 max(ceil(노드 수의 10%), 5)를 넘음(`tagDense`) |
| 태그 적합성(T-197, `tag-fit.mjs`) | 실패: 태그가 하나도 안 남음(`tagFitNone`). 확인: LLM no 태그를 뺌(`tagFitDropped`), 못 물음·답 빠짐(`tagFitPending`) |

**태그 적합성(T-197).** T-195 관문 대안 정답 후보 17줄 중 14줄이 LLM no였다(예: 염색 개편 → random_reroll). 억지 태그가 관문까지 가면 같은 태그 문장의 1위·여유를 흔든다. 그래서 check에서 후보마다 LLM을 한 번 불러(태그 여러 개를 한 번에) 태그마다 "이 개념의 사실이 그 태그 구조를 실제로 드러내는가" yes/no와 한 문장 이유를 받는다. 기준 자료는 `tags.json`의 desc와 예문(다른 분야)이다. no 태그는 빼고, 남은 태그가 없으면 실패다. 이미 실패한 후보는 묻지 않는다. 판정과 이유는 리뷰 시트 "후보 자세히"와 `.json` `tagFit`에 남는다. 호출 상한(`--max-calls`)·429·키 없음이면 그 뒤 후보는 태그를 그대로 두고 `tagFitPending`이다.

**근접 중복·태그 밀도(T-197, ADR 0015 제안 2·3).** T-193 측정에서 근접 중복 노드는 어떤 검색 관문도 통과해 정확도를 무너뜨렸다(합성 1,000노드에서 메이플 hit@1 54 → 5). check 순서는 기본 검사 → 근접 중복(LLM 전, 실패 후보에 한도를 안 씀) → 태그 적합성 → 태그 밀도다.
- 근접 중복은 노드 임베딩 글(태그 설명·예문이 앞에 붙음)이 아니라 개념 글(이름. 사실)로 잰다. 태그가 같으면 사실이 달라도 가깝기 때문이다(같은 구조 몰림은 태그 밀도가 맡는다).
- 임베더는 Node e5(`admin.embedding` 모델, 한 문장씩, 벡터는 `.tmp/node-pipeline/cache/vec-*.json`)이고, 모델을 못 쓰면 대체 임베더로 같은 규칙이다(`--dup-embedder fallback`). 미리 계산 벡터 파일(`extension/data/vectors/`, 크롬)은 섞지 않는다. 같은 글을 Node와 크롬에서 임베딩하면 코사인이 0.95~0.97뿐이라(2026-11-22) 0.9 근처를 재기에 잡음이 크다.
- 기준값은 데이터에서 잰다: 기존 노드끼리 가장 가까운 쌍(2026-11-22 Node e5: 메이플 0.895 world_trade_group~meso_market, 식당 0.864 hygiene_inspection~open_prep). 근거는 시트 "근접 중복 관문" 절과 후보마다 "근접 중복" 줄, `.json` `nearDup`에 남는다.
- 앞 묶음에서 실패 안 한 후보도 비교 대상이다(묶음 번호 순서로 check를 돌린다). `--no-near-dup`이면 건너뜀.

**묶음 사이 중복(T-205).** 묶음마다 따로 check를 돌려서 같은 개념이 묶음 5·8에 모두 살아 있으면 `--batch all`로 합칠 때 노드가 둘 들어갔다(T-198 `franchise_dispute_mediation`). `dedupe.mjs`가 같은 id 또는 같은 이름(공백·가운뎃점 무시)을 한 무리로 묶고(이름·id로 이어지면 셋 이상도 한 무리), 하나만 남긴다. 남길 순서: ① 검사 판정(통과 > 확인 > 실패, 이 표시 전 판정) ② 사실이 많은 쪽 ③ 앞 묶음. 나머지는 실패 `dupCross` + 남긴 후보를 적은 메모, `.json` `dupCross`(원래 판정·남긴 후보·같은 id/같은 이름). check는 다른 묶음(앞·뒤 모두) `.json`과 대조해 그 묶음 결과에 적고(시트·`.json` `crossBatch`), `gate`·`apply --batch all`은 합칠 때 다시 판정한다(나중 묶음이 이긴 경우 앞 묶음 파일은 그대로라 합칠 때 정리). 한 묶음 안 중복은 예전처럼 check(`idDupBatch`·`labelDupBatch`)가 뒤쪽을 실패로.

**조문 꼴 이름 근거(T-205).** 법령 본문은 "제40조(건강진단)" 같은 짧은 조 제목과 조문이라 LLM이 지은 이름("건강진단과 종사 자격 제한")이 그대로 나오지 않는다(T-198 법령 후보 29개 중 23개 경고). 초안이 이름을 핵심 낱말로 쪼개(끝 조사 과·와·의·을·를·에서·으로를 떼되 심의·부과 같은 낱말은 그대로, 붙여 쓴 4자 이상 낱말은 앞뒤 반쪽이 모두 있으면 있음) 본문과 제목(절·장 제목 + 조 제목)에 든 수, 낱말을 가장 많이 담은 조 번호를 `grounding.labelNouns`에 숫자로 남긴다(D-5). check는 조문 꼴 출처일 때만 다음 중 하나면 경고 없이 메모를 단다: 낱말이 모두 본문에 있음, 제목에 하나 이상 + 본문에 2/3 이상, 조 제목 하나가 낱말 절반 이상, 이름·사실이 "제N조"를 직접 가리킴. 다른 출처는 예전처럼 이름이 그대로 없으면 경고. 2026-11-22 식당 법령 후보 경고 23 → 3(남은 셋은 "이수 의무"·"배치 의무"·"알바비"처럼 조문에 없는 말을 이름에 쓴 경우라 경고가 맞다).

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
| `../source-policy.mjs`·`.json` | 출처 정책 원본: 관심사별 공식·커뮤니티 호스트, 분류·교차 확인·노드 검사(그래프 테스트·apply와 같은 판정, ADR 0016) |
| `sources.mjs` | 관심사별 허용 호스트·목록·씨앗·본문 표지·검사 규칙, 법령 껍데기 → 본문 주소(`lawBodyUrl`·`bodyUrlFor`), 씨앗 설정 찾기(`seedFor`) |
| `web.mjs` | robots.txt, 예의 바른 fetch, HTML → 글·링크·제목, 해시 |
| `run.mjs` | index(목록 → 색인), draft(페이지 → 후보), 씨앗 확인(`probeSeeds`·`markProbes`), 이름 신호 다시 재기(`regroundLabels`, T-205) |
| `draft.mjs` | 페이지 초안 프롬프트(T-301 `buildDraftPrompt` 꼴), 답 파싱·태그 없음 버림, 근거 지표(겹침·최장 복사), 절 나누기 |
| `check.mjs` | 자동 검사, 리뷰 시트 |
| `tag-fit.mjs` | 태그 적합성 LLM 검사(프롬프트·답 파싱·결과 반영, T-197) |
| `near-dup.mjs` | 근접 중복 관문(바닥 = 기존 노드끼리 최고 코사인, 같은 사실 재사용)·태그 밀도 상한(T-197, ADR 0015) |
| `dedupe.mjs` | 묶음 사이 id·이름 중복 무리 찾기·하나만 남기기(T-205) |
| `gate.mjs` | 회귀 관문, 대안 정답 후보 표·이유, accept-alt(평가 파일 한 줄 꼴 그대로 고치기) |
| `apply.mjs` | 패치 만들기, 판본 올리기, 검증 |
| `cli.mjs` | 명령줄 |

단위 테스트: `tests/unit/node-pipeline.test.mjs`, `tests/unit/node-pipeline-flow.test.mjs`(가짜 fetch·LLM·평가), `tests/unit/node-pipeline-sources.test.mjs`(법령 본문·남길 장·씨앗 확인, T-198), `tests/unit/node-pipeline-tagfit.test.mjs`(태그 적합성·2위 대안 정답·비유 없음 미루기·근접 중복·태그 밀도, T-197), `tests/unit/node-pipeline-dedupe.test.mjs`(묶음 사이 중복·조문 이름 근거·다시 재기, T-205), `tests/unit/source-policy.test.mjs`(출처 분류·교차 확인·출처 글 베낌·apply 방어, T-212).

# 작업 목록

상태: `대기` · `진행`(브랜치 작업 중) · `리뷰`(PR 열림) · `완료`(dev에 병합) · `보류` · `결정 필요`. 우선순위: `P0` 다음에 바로 · `P1` 이 단계 안에 · `P2` 여유 있을 때.
작업 하나마다 `task/<ID>-<슬러그>` 브랜치에서 하고, 끝나면 push 후 `dev`로 PR을 연다(CLAUDE.md "작업 방식"). PR을 열면 상태를 `리뷰`로, 병합되면 다음 작업을 시작할 때 `완료`로 바꾼다. 맨 아래 **작업 로그**에 PR 링크와 함께 한 줄 남긴다.

## 한눈에 보기

| ID | 작업 | 단계 | 우선 | 상태 | 먼저 끝나야 할 것 |
| --- | --- | --- | --- | --- | --- |
| D-1 | 기본 트리거를 Alt로 둘지 자동으로 둘지 | 결정 | P0 | 결정 필요 | |
| T-101 | 실제 키로 네 제공자 호출 확인 + 스모크 스크립트 | 1 품질 | P0 | 진행 | 무료 키(Gemini, Groq) |
| T-102 | 실제 임베딩 모델을 확장 안에서 로드 확인 (오프라인 대체 경로) | 1 품질 | P2 | 대기 | |
| T-103 | 검색 평가셋 확장(40문장+)과 품질 관문 통과 | 1 품질 | P0 | 대기 | T-405 |
| T-104 | 생성 품질 평가 (근거 준수·자연스러움) | 1 품질 | P1 | 대기 | T-101, T-103 |
| T-105 | 공통 그래프 벡터 사전 계산 | 1 품질 | P2 | 보류 | LightRAG 전환으로 서버가 벡터를 보관 |
| T-106 | 말풍선 도움됨/어색함 피드백 | 1 품질 | P1 | 대기 | |
| T-107 | 제외 사이트 목록과 "이 사이트에서 끄기" | 1 품질 | P1 | 대기 | |
| T-108 | 첫 결과 전 테마 깜빡임 제거 | 1 품질 | P2 | 대기 | |
| T-109 | 여러 줄 문장에서 말풍선 위치 | 1 품질 | P2 | 대기 | |
| T-110 | 벡터 캐시 정리 (모델 바뀌면 삭제, 상한) | 1 품질 | P2 | 대기 | |
| T-111 | iframe·Shadow DOM 안 문장 지원 | 1 품질 | P2 | 대기 | |
| T-112 | 윈도우에서 Alt 메뉴 포커스 충돌 확인 | 1 품질 | P2 | 대기 | |
| T-114 | 메이플 커뮤니티 용어 사전: 은어 aliases + 멸칭 금칙어 필터 | 1 품질 | P1 | 대기 | |
| T-113 | 금융·경제 문장이 `meso`·`auction`으로 끌려가는 주제 편향 줄이기 | 1 품질 | P0 | 대기 | |
| D-2 | 로그인 방식과 백엔드 | 결정 | P0 | 결정 필요 | Phase 1 관문 |
| T-201 | 사용자 저장소 서버 + remote 어댑터 연결 | 2 계정 | P0 | 대기 | D-2 |
| T-202 | 그래프 편집 화면 (JSON 대신 폼) | 2 계정 | P1 | 대기 | |
| T-203 | 공통 저장소 원격 배포와 버전 확인 | 2 계정 | P1 | 대기 | T-201 |
| T-204 | 외부 배포용 API 키 프록시 | 2 계정 | P1 | 보류 | T-402가 서버에서 키를 보관하며 흡수 |
| D-3 | 공통 저장소 검수 주체와 갱신 주기 | 결정 | P1 | 결정 필요 | |
| D-5 | 메이플 가이드 문서 출처 (공식만 / 위키 포함) | 결정 | P1 | 완료 | 공식 원문 + 위키·인벤 참고 |
| D-4 | 두 번째 공통 관심사 | 결정 | P1 | 완료 | 식당 |
| T-301 | AI로 관심사 그래프 초안 만들기 + 사용자 검수 | 3 확장 | P0 | 대기 | T-202, T-304 |
| T-304 | 추상 태그를 공통 파일로 분리 (`tags.json`) | 3 확장 | P1 | 대기 | |
| T-302 | 두 번째 공통 관심사: 식당 그래프 + 로그인 없이 관심사 선택 | 3 확장 | P1 | 대기 | T-304, D-3 |
| T-303 | 크롬 웹스토어 공개 준비 | 3 확장 | P1 | 대기 | T-107, T-402 |
| T-401 | [L0] EC2 준비: t4g.medium, Caddy, Tailscale, 키 보관 | L 서버 | P0 | 대기 | |
| T-402 | [L0] `server/` analogy-api 골격: `/v1/analogy`, 결과 형식 호환, 캐시 | L 서버 | P0 | 대기 | |
| T-403 | [L0] 시드 주입: maplestory.json → insert_custom_kg, 추상구조 엔티티 | L 서버 | P0 | 대기 | T-402 |
| T-404 | [L0] 확장 서버 모드 + 서버 장애 시 로컬 대체 | L 서버 | P0 | 대기 | T-402 |
| T-405 | [L0] 평가 도구에 서버 모드 추가, 관문: 서버 hit@1 ≥ 브라우저 | L 서버 | P0 | 대기 | T-403 |
| T-411 | [L1] 맥 추출 노드: Ollama, tailscale serve, launchd 시간창 | L 서버 | P0 | 대기 | T-401 |
| T-412 | [L1] 추출 프롬프트: 통제 어휘·용어 사전, JSON 모드 | L 서버 | P0 | 대기 | T-403 |
| T-413 | [L1] 20청크 A/B 하네스 (모델 × thinking) | L 서버 | P0 | 대기 | T-411, T-412 |
| T-414 | [L1] 추출 큐 워커: 맥 헬스체크, 재시도, 클라우드 대체 플래그 | L 서버 | P1 | 대기 | T-411 |
| T-421 | [L2] 가이드 문서 수집·인덱싱 | L 서버 | P1 | 대기 | T-413, T-414, D-5 |
| T-422 | [L2] 검수 리포트: 추상구조 연결 없는 개념 | L 서버 | P1 | 대기 | T-421 |
| T-423 | [L2] 패치 노트 자동 반영 (감지 → 이전 판 삭제 → 재인덱싱, 최신 우선) | L 서버 | P1 | 대기 | T-421 |
| T-424 | [L2] 밈·은어 용어 카드: 주간 초안 → 사람 승인 → 별칭·금칙어 반영 | L 서버 | P1 | 대기 | T-114, T-422 |
| T-431 | [L3] Postgres(pgvector·AGE) 전환, t4g.large | L 서버 | P1 | 대기 | T-421 |

단계 관문 (기획서 로드맵과 같음). LightRAG 트랙(T-4xx)은 [architecture-lightrag.md](architecture-lightrag.md)의 L0~L3 관문을 따른다. 사용자 워크스페이스(L3)는 Phase 2의 T-201과 함께 진행한다.
- Phase 0 → 1: 실제 키로 동작 확인 (T-101, T-102)
- Phase 1 → 2: 검색 hit@1 이 평가셋의 75% 이상 (T-103), 근거 밖 사실 0건 (T-104)
- Phase 2 → 3: 로그인 사용자의 오버레이가 두 기기에서 동기화

---

## 결정 필요

### D-1 기본 트리거
원래 아이디어는 "커서만 올리면"이지만, PoC 기본값은 Alt+호버다(오작동과 API 호출 폭주 방지). 자동 모드는 설정에 이미 있다.
- 선택지: (a) Alt 유지 (b) 자동을 기본, 머무름 900ms (c) 첫 실행 온보딩에서 사용자가 고르게
- 추천: (c). 온보딩 한 화면이면 되고, 기본 선택은 Alt.
- 결정하면: `lib/config.js`의 `DEFAULT_SETTINGS`와 설치 직후 여는 설정 화면을 고친다.

### D-2 로그인 방식과 백엔드
- 선택지: (a) Supabase(구글 OAuth + Postgres RLS) (b) Firebase (c) 자체 서버
- 추천: (a). 테이블 두 개(`common_graphs` 공개 읽기, `user_overlays` 본인만)로 끝나고 RLS로 권한이 명확하다.
- 확장 쪽 계약은 이미 있다: `lib/stores.js`의 `remoteAdapter`, 기획서 "사용자 저장소 API".

### D-3 공통 저장소 검수
게임 패치로 사실이 틀려진다. 누가 검수하고, 얼마나 자주 갱신하는지, 제보 경로를 정한다.

### D-5 메이플 가이드 문서 출처
LightRAG 공통 그래프(T-421)에 넣을 문서. 선택지: (a) 공식 가이드만 (b) 나무위키 등 커뮤니티 문서 포함 (c) 직접 요약한 문서만. 라이선스(CC BY-NC-SA 등)와 출처 표기, 패치 주기에 따른 갱신 방법을 함께 정한다. 추천: (a)+(c)로 시작하고 (b)는 라이선스 확인 후.
**결정 (2026-10-11)** 원문 인덱싱은 공식 가이드·패치 노트만. 나무위키와 메이플 인벤은 **참고용**: 읽고 사실을 확인해 우리 문장으로 새로 쓴 요약 문서만 넣고, 원문을 수집·저장·요약 저장하지 않는다. 이유: 저작권은 표현만 보호해서 사실을 다시 쓰는 건 자유롭지만, 원문 수집은 나무위키 CC BY-NC-SA(비상업·동일조건), 인벤 게시글 작성자 저작권, 데이터베이스 제작자 권리(저작권법 제93조), 각 사이트 약관·robots.txt에 걸린다. 이렇게 하면 상업화 여부와 무관하다. 출처가 다르면 공식을 따른다. 요약 문서에도 자주 바뀌는 수치는 넣지 않는다(규칙 2).

### D-4 두 번째 공통 관심사
메이플 밖 사용자 유입용. 후보 예: 축구, 요리, 다른 게임. 추상 태그 사전을 재사용할 수 있는지가 기준.
**유력 후보 (2026-10-11)** 식당(`analogyPrefix: "식당으로 비유하자면"`, 반영 방안은 naming-meme.md "식당 밈 반영 방안"). 앱 이름 후보 "좋은비유네용"이 메이플 인벤의 식당 비유 밈에서 왔고, 식당 운영이 지금 추상 태그 대부분에 대응된다. 배경과 주의점은 [naming-meme.md](naming-meme.md). 하려면 추상 태그를 `maplestory.json`에서 공통 파일로 빼야 한다(규칙 9, ADR 필요).

---

## Phase 1 · 품질 검증

**결정 (2026-10-11)** 관심사는 세 층이다.
| 순서 | 관심사 | 로그인 | 저장 위치 |
| --- | --- | --- | --- |
| 기본 | 메이플 | 필요 없음 | 공통 `maplestory.json` |
| 두 번째 | 식당 (`analogyPrefix: "식당으로 비유하자면"`) | **필요 없음** | 공통 `restaurant.json` |
| 그 외 | 사용자 커스텀 | 필요 | 사용자 오버레이 (`u:` 노드) |
- 공통 관심사끼리는 로그인 없이 바꿀 수 있다. 고른 관심사는 기기(`chrome.storage.local`)에만 저장한다. 공통 그래프만 쓰므로 규칙 3(로그아웃 = 공통만)에 어긋나지 않는다. 이유: 밈을 아는 사용자가 인벤에서 바로 식당 비유를 써 보게 하려는 것(가입 장벽 없음).
- 커스텀은 두 방식 모두 지원한다: (a) 메이플·식당 공통 그래프 위에 내 노드를 더하기(오버레이), (b) 완전히 새 관심사(`useCommon: false` + `domain`, T-301 AI 초안).
- 모든 관심사가 같은 추상 태그 목록을 쓴다. 그래서 태그를 공통 파일로 빼는 T-304가 식당(T-302)과 커스텀(T-301)의 전제다.
- 배경: [naming-meme.md](naming-meme.md).
### T-101 실제 키로 네 제공자 호출 확인 + 스모크 스크립트
**왜** 모든 테스트가 가짜 LLM으로 돌았다. 요청 형식(파라미터, 헤더, JSON 모드)이 실제 API와 맞는지 모른다.
**할 일**
- `tools/smoke-providers.mjs`: 환경 변수(`GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`)가 있는 제공자만 `lib/providers.js`의 `complete()`로 비유 프롬프트 1건을 보내고, `parseJSONLoose` 결과와 지연 시간을 출력. `npm run smoke:providers`로 등록.
- 실패하는 파라미터를 고친다. 의심 지점: Gemini `thinkingConfig`/`responseMimeType`, OpenAI `gpt-6-*`가 chat completions에서 요구하는 인자, Anthropic 브라우저 직접 호출 헤더.
- 확장에서 설정 → 연결 테스트 → 시험해 보기를 각 제공자로 한 번씩.
**진행 (2026-10-11)** `npm run smoke:providers` 완료. 가짜 서버(custom)로 통과 확인. 유료 키(OpenAI, Anthropic)는 없어서 무료인 Gemini·Groq 키로만 확인하고, 두 제공자는 건너뜀으로 기록한다. 로컬 Ollama는 `CUSTOM_BASE_URL`로 같은 스크립트를 쓴다.
**완료 기준** 키가 있는 모든 제공자가 유효한 JSON(`meaning`, `analogy`, `nodeId`)을 돌려준다. 결과를 작업 로그에 제공자별 지연 시간과 함께 남긴다.
**파일** `extension/lib/providers.js`, `tools/`, `package.json`

### T-102 실제 임베딩 모델을 확장 안에서 로드 확인
**왜** 모델 실행 엔진(wasm)이 확장 CSP에서 도는 것까지만 확인했다. transformers.js 파이프라인이 모델을 받아 실제로 벡터를 내는지는 모른다.
**할 일**
- 설정 → 검색 모델 → 지금 준비하기. 진행률이 오르고 `ready`가 되는지, 걸린 시간과 받은 용량을 기록.
- 두 번째 실행(캐시)에서 3초 안에 준비되는지.
- 느린 네트워크에서 서비스 워커가 중간에 죽지 않는지(`keepAlive`). 죽으면 오프스크린이 직접 진행 상태를 저장하게 바꾼다.
- Hugging Face가 막힌 환경에서는 설정 화면에 "대체 검색 사용 중 · 원인"이 보이는지.
**완료 기준** `debug.embedderId`가 `Xenova/multilingual-e5-small@q8`로 나오는 결과를 시험해 보기에서 확인. 첫 로드 시간·용량을 작업 로그에 기록.
**파일** `src/offscreen-src.js`(고친 뒤 `npm run build`), `extension/background.js`

### T-103 검색 평가셋 확장과 품질 관문
**왜** 지금 평가셋 16문장은 태그 설명과 단어를 공유해서 점수가 낙관적이다(대체 임베더로도 hit@1 12/16이 나옴). 실제 모델(e5-small)은 오히려 11/16(2026-10-11, EVAL_LOG).
**할 일**
- `tools/eval-set.json`을 40문장 이상으로. 태그 설명에 쓰인 단어를 피해서 바꿔 말한 문장, 영어 문장 25% 이상, "맞는 비유가 없어야 하는" 문장 5개(`expectNodes: []`, 이때는 1위 점수가 임계값 아래인지 본다).
- `npm run eval` 결과를 `docs/EVAL_LOG.md`에 기록.
- 75% 미만이면 차례로 시도하고 각각 기록: 가중치 격자 탐색 → 태그에 `examples`(분야가 다른 예문 2~3개) 필드 추가해 태그 임베딩 텍스트에 포함 → 정밀 모드 기본 켜기 → 더 큰 모델(`Xenova/multilingual-e5-base`, 용량 비교).
**완료 기준** 실제 모델로 hit@1 ≥ 75%, hit@3 ≥ 90%. 채택한 설정을 `config/admin.json`에 반영하고, 바뀐 결정이 있으면 ADR 추가.
**파일** `tools/eval.mjs`, `tools/eval-set.json`, `extension/data/common/maplestory.json`, `extension/lib/graph.js`(`tagText`)

### T-104 생성 품질 평가
**왜** 검색이 맞아도 LLM이 근거 밖 메이플 사실을 섞거나 어색한 비유를 만들 수 있다.
**할 일**
- `tools/eval-gen.mjs`: 평가셋 문장마다 background의 `explain()`과 같은 과정(검색 → 프롬프트 → 호출)을 Node에서 돌려 결과를 `.tmp/eval-gen-<날짜>.json`에 저장. background.js에서 파이프라인을 `lib/pipeline.js`로 빼서 Node와 확장이 같은 코드를 쓰게 한다.
- 두 번째 LLM으로 채점: (1) 근거 준수 — analogy의 메이플 관련 주장이 모두 후보 facts에 있는가(예/아니오), (2) 구조 대응 1~5, (3) 자연스러움 1~5.
**완료 기준** 근거 준수 100%, 구조 대응 평균 ≥ 4. 어긋난 사례는 프롬프트 수정 후 재측정해 EVAL_LOG에 기록.

### T-105 공통 그래프 벡터 사전 계산
**왜** 첫 호버 때 태그·노드 36개를 브라우저에서 임베딩하느라 느리다.
**할 일** `tools/build-vectors.mjs`가 `extension/data/common/maplestory.vectors.json`(`{ embedderId, graphVersion, vectors: {"tag:id": [...]}}`)을 만든다. background의 `ensureGraphVectors`가 embedderId와 버전이 맞으면 이 파일로 캐시를 채운다. 공통 그래프를 고치면 이 파일도 다시 만든다(단위 테스트로 버전 일치 검사).
**완료 기준** 새 프로필에서 모델 준비 직후 첫 호버에 그래프 임베딩 호출이 0건(e2e에서 offscreen `embed` 호출 수로 확인).

### T-106 말풍선 도움됨/어색함 피드백
**할 일** 말풍선 하단에 버튼 두 개. `chrome.storage.local`에 `{ ts, sentenceHash, nodeId, tagId, provider, vote }` 누적(최근 500건). 설정 화면에서 JSON 내보내기. 로그인 사용자는 "어색함" 3회 이상 받은 노드를 오버레이 `nodeBoosts`에서 -0.05씩(하한 -0.2).
**완료 기준** e2e: 버튼 클릭 → 저장 확인 → 내보내기 파일 내용 확인.

### T-107 제외 사이트와 "이 사이트에서 끄기"
**왜** 메일·은행 페이지 문장이 LLM 제공자로 전송된다.
**할 일** `settings.excludedHosts`(기본값: 메일, 뱅킹, 로그인 도메인 몇 개), 팝업에 현재 사이트 토글, content.js가 시작할 때 확인. 비밀번호 입력란이 있는 폼 안 문장은 항상 무시.
**완료 기준** e2e: 제외한 호스트에서 Alt+호버해도 포트 메시지가 가지 않는다.

### T-108 첫 결과 전 테마 깜빡임
로딩 말풍선이 기본 `maple` 테마로 뜬 뒤 결과에서 중립으로 바뀐다. content.js가 시작할 때 `graph:info`로 테마를 받아 두거나, 첫 `stage` 메시지에 `theme`을 싣는다. e2e로 로딩 상태의 클래스를 확인.

### T-109 여러 줄 문장에서 말풍선 위치
`place()`가 문장 전체의 bounding rect를 쓴다. 커서가 있는 줄의 client rect를 기준으로 바꾸고, 화면 아래쪽이면 위로 뒤집는다.

### T-110 벡터 캐시 정리
`vecCache`가 계속 커진다. 현재 embedderId가 아닌 항목 삭제, 2,000개 상한(LRU). 단위 테스트 가능한 순수 함수로 분리.

### T-111 iframe·Shadow DOM
`all_frames: true` 검토(포트·말풍선이 프레임마다 생김), 열린 Shadow DOM 안 텍스트에서 `caretPositionFromPoint`의 `shadowRoots` 옵션 사용.

### T-112 윈도우 Alt 충돌
Alt를 눌렀다 떼면 크롬 메뉴로 포커스가 가는 문제를 keyup `preventDefault`로 막아 두었다. 실제 윈도우 크롬에서 확인하고, 안 되면 보조키 기본값을 바꾼다(D-1과 함께).

---

## Phase 2 · 계정과 내 저장소


### T-113 금융·경제 문장의 주제 편향
**왜** 실제 모델 첫 평가(2026-10-11)에서 틀린 5건이 모두 금융·경제 문장(레버리지, 복권, 누진세, 세일)이었다. 구조(손실 위험, 기댓값, 단계별 비용 증가)와 상관없이 "돈" 주제가 겹치는 `meso_inflation`·`auction`·`meso`가 1위로 올라온다. 직접 유사도가 주제를, 태그 유사도도 경제 태그를 따라간다.
**할 일** 차례로 시도하고 각각 EVAL_LOG에 기록: (1) 노드 임베딩 텍스트에서 게임 고유 용어 비중 줄이고 구조 설명 비중 늘리기 (2) 태그에 분야가 다른 예문 `examples` 추가(T-103과 공유) (3) 경제 태그(`market_price`, `inflation`)에 일정 감점 또는 태그 점수 상위 2개 평균 (4) 질의를 LLM으로 "추상 구조 한 줄"로 바꾼 뒤 임베딩(정밀 모드와 같음, 무료 키로 시험).
**완료 기준** 실제 모델 혼합 hit@1 ≥ 13/16, 금융 문장 5건 중 3건 이상 맞힘. T-103의 확장 평가셋에서도 떨어지지 않을 것.
**파일** `extension/lib/graph.js`, `extension/lib/retrieval.js`, `extension/data/common/maplestory.json`, `tools/eval.mjs`

### T-114 메이플 커뮤니티 용어 사전
**왜** 인벤 같은 페이지는 은어(재획, 펑, 세금, 메요일)로 쓰여 있어 지금 그래프로는 검색이 안 된다. 또 LLM이 커뮤니티 멸칭(쌀숭이, 리선족 등)을 비유에 섞어 낼 위험이 있다. 용어 분류는 [naming-meme.md](naming-meme.md) "메이플 커뮤니티 용어".
**할 일**
- 노드에 `aliases` 필드(A 묶음 은어). `nodeText`에 포함해 임베딩하고, `validateGraph`가 문자열 배열인지 검사.
- `data/common/blocklist.json`(D 묶음 + 실존 인물 별명). 항목 형식은 ADR 0007의 용어 카드(`term`, `variants`, `category`, `sources` …)로 처음부터 맞춰, T-424가 그대로 이어 쓰게 한다. 프롬프트 규칙에 "멸칭·실존 인물 금지" 한 줄, 응답 후처리에서 금칙어가 있으면 그 필드를 비우고 `rejected`에 이유. 서버(T-402)도 같은 파일을 쓴다.
- 평가셋에 은어 문장 3개 이상 추가.
**완료 기준** 단위 테스트: aliases 검증, 금칙어 필터(우회 표기 포함). 은어 문장 hit@3.
**파일** `extension/data/common/*.json`, `extension/lib/graph.js`, `extension/lib/prompt.js`, `extension/background.js`, `tools/eval-set.json`
### T-201 사용자 저장소 서버 + remote 어댑터
**할 일** D-2 결정대로 서버 구현: `GET /auth/start?redirect_uri=`(로그인 후 `redirect_uri#token=&user_id=&name=`), `GET/PUT /v1/overlay`, `GET /v1/common/:id`. `config/admin.json`의 `userStore.adapter`를 `remote`로. 서버 코드는 `server/`에 둔다.
**완료 기준** e2e: 가짜 인증 서버로 로그인 → 오버레이 저장 → 새 프로필에서 같은 토큰으로 불러오기. `local-dev` 어댑터는 개발 빌드에만 남긴다.

### T-202 그래프 편집 화면
노드 추가·수정·삭제 폼, 태그는 공통 태그 사전에서 칩으로 선택, 공통 노드 숨김 체크박스, 가중치 슬라이더. 기존 JSON 편집은 "고급"으로 접어 둔다. 저장 전 `validateOverlay`.

### T-203 공통 저장소 원격 배포
`commonStore.url`에서 받아 `chrome.storage.local`에 버전과 함께 캐시, 하루 한 번 ETag 확인, 검증 실패 시 이전 버전 유지, 오프라인이면 번들 파일.

### T-204 외부 배포용 API 키 프록시
`sharedApiKeys`는 확장에서 꺼낼 수 있다. 서버가 키를 보관하고 사용자별 요청 한도를 두는 `proxy` 제공자를 추가한다(`PROVIDERS`에 항목 하나 + 서버 엔드포인트).

---

## Phase 3 · 관심사 넓히기

### T-301 AI로 관심사 그래프 초안 + 검수
사용자가 관심사 이름을 넣으면 LLM이 공통 태그 사전(`tags.json`, T-304)에 맞춰 노드 10~20개를 제안한다. 공통 관심사 위에 더하기(오버레이)와 완전히 새 관심사(`useCommon: false`) 둘 다 지원한다(D-4). 모든 fact는 "미검수" 표시로 들어가고, 사용자가 하나씩 확인해야 검색 대상이 된다. 검수 전 노드는 비유 근거로 쓰지 않는다.

### T-304 추상 태그를 공통 파일로 분리
**왜** 지금 추상 태그 18개가 `maplestory.json` 안에 있다. 식당(T-302)과 커스텀(T-301)이 같은 태그를 써야 한다(규칙 9 통제 어휘).
**할 일** `data/common/tags.json`(`{ version, tags: [...] }`)으로 옮기고, 관심사 그래프는 태그 id만 참조한다. `mergeGraphs`·`validateGraph`·평가 도구·(나중에) 서버 시드(T-403)와 추출 프롬프트(T-412)가 이 파일을 원본으로 쓰게 한다. CLAUDE.md 규칙 9의 "원본은 `maplestory.json`의 `tags`"를 `tags.json`으로 고치고 ADR을 남긴다.
**완료 기준** 단위·e2e 통과, `npm run eval` 결과가 분리 전과 같음(EVAL_LOG 한 줄), 존재하지 않는 태그 id를 참조하면 검증 오류.

### T-302 두 번째 공통 관심사: 식당
D-4 결정(식당, 로그인 없이 선택 가능). [naming-meme.md](naming-meme.md) "식당 밈 반영 방안"을 따른다.
**할 일**
- `data/common/restaurant.json`: `domain: "식당"`, `analogyPrefix: "식당으로 비유하자면"`, `theme: "neutral"`(규칙 6). 노드 15개 안팎(원가 상승, 점심 피크·테이블 회전, 주방 분업, 해피아워, 한정 메뉴, 단골 적립, 위생 점검, 배달 앱 수수료 등), 공통 태그(T-304)에 연결. 자주 바뀌는 수치 금지(규칙 2), 특정 가게·인물·밈 원문 금지(규칙 11).
- 관심사 선택 UI: 팝업과 설정에 "메이플 / 식당". 로그아웃 상태에서도 바꿀 수 있고 선택은 `chrome.storage.local`. 로그인 상태에서 오버레이는 고른 공통 관심사 위에 얹는다.
- 비유가 없을 때 문구는 관심사별(`noMatchText`), 식당은 "이건 식당으로도 비유가 안 되네요."
- 평가셋에 식당 관심사용 문장(메이플 문장 포함) 10개 이상, 결과를 EVAL_LOG에.
**완료 기준** e2e: 로그아웃 상태에서 식당으로 바꾸면 말풍선이 "식당으로 비유하자면"으로 시작하고 중립 테마, 메이플로 되돌리기. 식당 평가 hit@3 ≥ 80%.

### T-303 웹스토어 공개 준비
권한 사유서(`<all_urls>`, `offscreen`, `identity`), 개인정보 처리방침(문장이 LLM 제공자로 전송됨을 명시), 스토어 스크린샷, 프로덕션 빌드에서 `local-dev` 어댑터와 데모 제공자 숨김.

---

## LightRAG 트랙 · 서버 전환 (설계: docs/architecture-lightrag.md, ADR 0006)

### T-401 [L0] EC2 준비
`t4g.medium`(Graviton, 서울 리전 요금 확인), 보안 그룹 인바운드 443만, Caddy(HTTPS 자동 인증서), Tailscale `tag:rag-server`(`--ssh`), Gemini 키는 SSM Parameter Store, 스왑 2GB, Ollama + `bge-m3`. 인프라 절차는 `infra/README.md`에 명령 그대로 남긴다(콘솔 클릭 금지, 가능하면 스크립트).
**완료 기준** 테일넷에서만 SSH 가능, 인터넷에서 `https://<도메인>/health` 200, `bge-m3` 임베딩 호출 성공.

### T-402 [L0] analogy-api 골격
`server/`(Python, FastAPI, `lightrag-hku` 버전 고정). `POST /v1/analogy`는 확장의 `explain()` 결과 형식을 그대로 돌려준다. 키워드(Gemini Flash-Lite) → `QueryParam(mode="hybrid", hl_keywords, ll_keywords, only_need_context=True)` → 후보 3개 → 비유(Gemini Flash) → `nodeId` 검증. 결과 캐시(문장 해시 + 워크스페이스 버전). 설치 토큰별 요청 한도. 프롬프트는 `extension/lib/prompt.js`와 같은 규칙을 Python으로 옮기고, 두 쪽이 같은 규칙인지 확인하는 테스트를 둔다.
**완료 기준** pytest(가짜 LLM, 작은 시드 그래프)로 응답 형식·근거 검증·캐시 확인. `docker compose up`으로 로컬 실행.

### T-403 [L0] 시드 주입
`maplestory.json` → `insert_custom_kg` 변환 스크립트. 태그 18개는 `entity_type="추상구조"` 엔티티, 노드는 `게임시스템` 등, 노드–태그 연결은 `keywords`에 태그 라벨이 들어간 관계, 기존 엣지는 `rel`을 설명으로. `source_id`는 `seed:<id>`.
**완료 기준** 워크스페이스 `common_maplestory`에 엔티티 36개, 관계(노드–태그 + 기존 엣지) 적재 확인. 재실행해도 중복이 생기지 않음.

### T-404 [L0] 확장 서버 모드
`config/admin.json`에 `analogyServer.url`. 설정되면 background가 서버를 먼저 부르고, 실패(타임아웃 4초, 5xx)하면 기존 브라우저 파이프라인으로 대체. 말풍선 footer에 `서버`/`로컬` 표시. e2e는 가짜 analogy-api(Node)로.
**완료 기준** e2e: 서버 응답 사용, 서버 다운 시 로컬 대체 모두 통과.

### T-405 [L0] 평가 도구 서버 모드 · L0 관문
`tools/eval.mjs --server <url>`: 같은 평가셋을 서버 `/v1/analogy`(debug 후보)로 돌려 hit@1·hit@3 비교. 결과를 EVAL_LOG에.
**완료 기준** 서버 hit@1 ≥ 브라우저 hit@1. 통과하면 ADR 0006 상태를 "채택"으로.

### T-411 [L1] 맥 추출 노드
`infra/mac/`에 launchd plist 두 개(시간창 시작·끝), Ollama 환경 변수(`OLLAMA_HOST=127.0.0.1:11434`, `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_KEEP_ALIVE=5m`, `OLLAMA_CONTEXT_LENGTH=16384`), `tailscale serve --bg --tcp 11434 tcp://127.0.0.1:11434`, `tag:llm-node`. Tailscale 정책 파일은 `infra/tailscale-policy.json`.
**완료 기준** EC2에서 `curl http://<맥 테일넷 이름>:11434/api/tags` 성공, 같은 와이파이의 다른 기기에서는 실패.

### T-412 [L1] 추출 프롬프트
LightRAG 추출 프롬프트 확장: 엔티티 유형 `게임시스템, 재화, 아이템, 보스, 지역, 추상구조`, 통제 어휘 18개(원본 `maplestory.json` tags에서 생성), 메이플 용어 사전, 예시 2개. `ENTITY_EXTRACTION_USE_JSON` 사용. 목록 밖 추상구조를 만들면 후처리에서 버린다.
**완료 기준** 단위 테스트: 어휘 목록 생성, 목록 밖 추상구조 제거.

### T-413 [L1] 20청크 A/B 하네스 · L1 관문
`server/tools/ab_extract.py`: 청크 20개 × (gemma4:12b, qwen3.5:9b) × (thinking 켬, 끔). 파싱 실패율, 청크당 엔티티·관계 수, 추상구조 연결률, 청크당 시간, 최대 메모리. 결과표를 `docs/EVAL_LOG.md`에.
**완료 기준** 파싱 실패 5% 이하, 게임 개념의 추상구조 연결률 70% 이상인 조합을 기본값으로 확정.

### T-414 [L1] 추출 큐 워커
문서 상태 저장소 기반 큐. 5분마다 맥 헬스체크, 응답하면 `llm_model_max_async=1`로 처리, 연결이 끊기면 해당 청크 실패 표시 후 다음 시간창에 재시도. 관리자 플래그 `extractFallback=cloud`(하루 청크 상한, 사용자 워크스페이스에만).
**완료 기준** 가짜 Ollama 서버를 켰다 껐다 하는 테스트로 재시도·재개 확인.

### T-421 [L2] 가이드 문서 수집·인덱싱
원문은 공식 가이드·패치 노트만, 위키·인벤은 직접 쓴 요약 문서로(D-5). 문서마다 `doc_id = 출처 URL + 판본`, 패치 시 `adelete_by_doc_id` 후 재삽입. 출처 URL은 관계 설명과 함께 남아 말풍선 근거에 링크로 보일 수 있게.

### T-422 [L2] 검수 리포트
"추상구조 연결이 없는 게임 개념" 목록과, 같은 대상을 가리키는 것으로 보이는 이름 쌍(임베딩 유사도 상위)을 뽑아 `/admin/review`(테일넷 전용)에 보여 준다. 보강은 `insert_custom_kg`.

### T-423 [L2] 패치 노트 자동 반영
ADR 0007. EC2 cron이 정기 점검 다음 날 공식 업데이트 목록에서 새 글을 감지한다. 문서마다 `doc_id = URL + 판본`, `published_at`. 같은 문서의 이전 판은 `adelete_by_doc_id` 후 추출 큐에 넣는다. 질의 병합 단계에서 같은 엔티티의 근거가 여러 판이면 최신 `published_at`을 앞에 두고, 결과 `evidence`에 기준 날짜와 출처 URL을 넣어 말풍선에 보인다. 패치 노트 원문은 수치를 포함해도 된다(규칙 2 예외).
**완료 기준** pytest: 새 글 감지(가짜 목록 페이지), 재실행 시 중복 없음, 이전 판 삭제 확인, 최신 판 우선 정렬. 목록 형식이 바뀌어 파싱이 실패하면 알림만 하고 기존 판을 유지.

### T-424 [L2] 밈·은어 용어 카드
ADR 0007, [naming-meme.md](naming-meme.md). 주 1회 나무위키·인벤의 용어 관련 문서를 읽고(원문 저장 안 함) LLM이 용어 카드 초안을 쓴다: `term`, `variants`, `meaning`(우리 문장), `category`(A 은어 / B 밈 / C 실존 인물 / D 멸칭), `links`(게임 시스템 id), `first_seen`, `sources`(URL만), `status`. 분류가 애매하면 D로 둔다(보수적으로). `/admin/review`(T-422)에서 승인한 카드만 반영: A → 엔티티 별칭과 질의 키워드 확장, B → 말투 사전, C·D → `blocklist.json`. 확장의 브라우저 대체 경로도 같은 `blocklist.json`과 별칭을 받는다.
**완료 기준** pytest: 카드 스키마 검증, 승인 전 카드는 어디에도 반영 안 됨, D 카드 승인 시 금칙어 필터가 변형 표기까지 잡음. 첫 실행으로 카드 10개 이상 제안.

### T-431 [L3] Postgres 전환
`t4g.large`, PostgreSQL + pgvector(HNSW) + Apache AGE. 파일 스토리지 → Postgres 이전 스크립트. 추출 워커를 별도 프로세스로 분리. 로그인·오버레이 설정 테이블도 같은 DB(D-2와 함께).

---

## 작업 로그

| 날짜 | ID | 브랜치 | PR | 내용 |
| --- | --- | --- | --- | --- |
| 2026-10-11 | D-4 | task/eval-real-model | [#2](https://github.com/roasted-penguin/good-metaphor/pull/2) | D-4 결정: 기본 메이플, 두 번째 식당(로그인 없이 선택), 그 외 가입 후 커스텀. 태그 분리 T-304 추가, T-302·T-301 구체화. |
| 2026-10-11 | DOC | task/eval-real-model | [#2](https://github.com/roasted-penguin/good-metaphor/pull/2) | 최신화 설계(ADR 0007): 패치 노트 원문 자동 반영(T-423), 밈 용어 카드 승인 흐름(T-424), 규칙 2 범위 조정. 설계 문서 md·html·ADR 0006 갱신. |
| 2026-10-11 | DATA | task/eval-real-model | [#2](https://github.com/roasted-penguin/good-metaphor/pull/2) | 공통 그래프 사실 검수(공식 패치 노트 update/799·806, 나무위키): 스타포스 파괴 후 흔적 복구(2026-03), 샤이닝 스타포스 타임 이름, 큐브 → 메소 재설정 병행, 심볼·아케인포스·결정석·유니온·솔 에르다 문장 수정. 수치는 넣지 않음. 등급색은 공식 값이 공개돼 있지 않아 유지(ADR 0004 메모 갱신). 그래프 버전 2026.10.11-1. |
| 2026-10-11 | T-101 | task/eval-real-model | [#2](https://github.com/roasted-penguin/good-metaphor/pull/2) | 스모크 스크립트 `npm run smoke:providers` 추가(가짜 서버로 통과). Gemini가 잘못된 키 400을 thinkingConfig 오류로 오인해 한 번 더 호출하던 문제 수정 + 단위 테스트 2개. 실제 무료 키 확인은 남음. |
| 2026-10-11 | EVAL | task/eval-real-model | [#2](https://github.com/roasted-penguin/good-metaphor/pull/2) | 첫 실제 임베딩 모델 평가: e5-small 혼합 hit@1 11/16, hit@3 12/16(대체 임베더 12/16보다 낮음). 주제 편향을 T-113으로 추가. Node 20.8에서는 transformers.js(sharp)가 안 떠서 `engines`를 22 이상으로. |
| 2026-09-29 | DOC | task/docs-architecture | [#1](https://github.com/roasted-penguin/good-metaphor/pull/1) | 설계 문서 시각화: `architecture-lightrag.md`에 Mermaid 그림 4개, `architecture-lightrag.html` 추가. |
| 2026-09-29 | DOC | task/docs-architecture | [#1](https://github.com/roasted-penguin/good-metaphor/pull/1) | LightRAG 아키텍처 설계(`docs/architecture-lightrag.md`, ADR 0006), LightRAG 트랙 작업 T-401~T-431 추가, 소개 페이지에 다음 아키텍처 구성도 추가. |
| 2026-09-28 | DOC | task/docs-architecture | [#1](https://github.com/roasted-penguin/good-metaphor/pull/1) | 작동 방식·인프라 구성 소개 페이지 `docs/intro.html` 추가. |
| 2026-09-28 | PoC | main | 없음(초기 커밋) | 확장·공통 저장소·제공자 레지스트리·두 층 저장소·테마 구현. 단위 17개, e2e 6개 통과(가짜 LLM, 대체 임베더). |

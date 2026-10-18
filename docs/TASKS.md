# 작업 목록

상태: `대기` · `진행`(브랜치 작업 중) · `리뷰`(PR 열림) · `완료`(dev에 병합) · `보류` · `결정 필요`. 우선순위: `P0` 다음에 바로 · `P1` 이 단계 안에 · `P2` 여유 있을 때. 사용자가 대화 중에 직접 요청해 추가한 작업은 제목 앞에 **[사용자 추가]**를 붙인다.
작업 하나마다 `task/<ID>-<슬러그>` 브랜치에서 하고, 끝나면 push 후 `dev`로 PR을 연다(CLAUDE.md "작업 방식"). PR을 열면 상태를 `리뷰`로, 병합되면 다음 작업을 시작할 때 `완료`로 바꾼다. 맨 아래 **작업 로그**에 PR 링크와 함께 한 줄 남긴다.

## 한눈에 보기

| ID | 작업 | 단계 | 우선 | 상태 | 먼저 끝나야 할 것 |
| --- | --- | --- | --- | --- | --- |
| 2026-10-17 | 인계 | task/handoff-status | [#5](https://github.com/roasted-penguin/good-metaphor/pull/5) | #4 병합 반영(T-121 완료). CLAUDE.md 현재 상태를 10-17 기준으로, 여러 세션 동시 작업 규칙 추가. D-6(에이전트 단 설계 범위, 답 대기) 등록. |
| 2026-10-11 | T-121 | task/T-121-provider-retry | [#4](https://github.com/roasted-penguin/good-metaphor/pull/4) | 503·429·네트워크 오류 재시도(최대 2회, 백오프, Retry-After 상한 3초), 키 오류는 즉시. `debug.llmRetries`, 스모크에 재시도 횟수 표시. 단위 5개 추가(24개). 이 브랜치로 `smoke` 수동 실행(run 38127863442): Gemini·Groq 모두 통과 → T-119 완료 기준도 충족. |
| 2026-10-11 | 상태 | task/T-121-provider-retry | [#4](https://github.com/roasted-penguin/good-metaphor/pull/4) | #1·#2·#3 병합 반영: T-101·T-119 완료. 수동 스모크 첫 실행: Groq 전부 통과(0.4~0.9초), Gemini 503 2건 → T-121로 이어 확인. Groq 존댓말·추상화 문제로 T-122 추가. 노출됐던 Gemini 키 삭제 확인(401). |
| D-1 | 기본 트리거를 Alt로 둘지 자동으로 둘지 | 결정 | P0 | 완료 | Alt + 첫 실행 선택 |
| T-119 | 실제 키 스모크를 CI에서 수동 실행 (Actions 비밀값) | 1 품질 | P1 | 완료 | |
| T-120 | Jev로 추상 태그 판정 실험 ("판정기" 인터페이스) | 1 품질 | P1 | 대기 | Jev 얼리 액세스 |
| T-121 | 제공자 일시 오류(503·429) 재시도 | 1 품질 | P0 | 완료 | |
| T-122 | Groq 응답 품질 다듬기(존댓말 ~요, 추상화에 원문 용어 금지) + 기본 제공자 검토 | 1 품질 | P1 | 대기 | T-121 |
| T-123 | 비유가 근거 facts 밖 사실을 쓰는지 검사 (nodeId만으로는 못 잡음) | 1 품질 | P1 | 대기 | |
| T-124 | **[사용자 추가]** 모델 순위 fallback 체인(지금 1·2순위, 순위는 더 붙음) + 429 쿨다운 | 1 품질 | P0 | 완료 | T-117 |
| T-125 | **[사용자 추가]** 체인 2·3순위 교체: Gemini 3.5 Flash-Lite, NVIDIA Build(thinking 끔) | 1 품질 | P0 | 완료 | T-124 |
| T-126 | 하루 한도 429(TPD·RPD)는 리셋 시각까지 쿨다운 (지금은 상한 10분마다 재시도) | 1 품질 | P2 | 대기 | T-125 |
| T-127 | **[사용자 추가]** 로컬 Ollama를 호버 체인 최종 방어선으로 (다른 무료 모델은 무조건 앞) | 1 품질 | P1 | 완료 | T-125 |
| T-116 | 첫 실행 트리거 선택 화면 (D-1) | 1 품질 | P1 | 대기 | |
| T-117 | 뜻 먼저 보여 주기: 응답 스트리밍으로 체감 속도 개선 | 1 품질 | P0 | 완료 | |
| T-101 | 실제 키로 네 제공자 호출 확인 + 스모크 스크립트 | 1 품질 | P0 | 완료 | |
| T-102 | 실제 임베딩 모델을 확장 안에서 로드 확인 (오프라인 대체 경로) | 1 품질 | P2 | 진행 | 첫 로드 확인됨, 캐시·대체 경로 남음 |
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
| T-115 | 앱 이름을 "좋은비유네용"으로 바꾸기 | 1 품질 | P1 | 대기 | |
| T-114 | 메이플 커뮤니티 용어 사전: 은어 aliases + 멸칭 금칙어 필터 | 1 품질 | P1 | 대기 | |
| T-113 | 금융·경제 문장이 `meso`·`auction`으로 끌려가는 주제 편향 줄이기 | 1 품질 | P0 | 대기 | |
| D-2 | 로그인 방식과 백엔드 | 결정 | P0 | 보류 | **L3 시작 전에 결정** (추천 d) |
| T-201 | 사용자 저장소 서버 + remote 어댑터 연결 | 2 계정 | P0 | 대기 | D-2 |
| T-202 | 그래프 편집 화면 (JSON 대신 폼) | 2 계정 | P1 | 대기 | |
| T-203 | 공통 저장소 원격 배포와 버전 확인 | 2 계정 | P1 | 대기 | T-201 |
| T-204 | 외부 배포용 API 키 프록시 | 2 계정 | P1 | 보류 | T-402가 서버에서 키를 보관하며 흡수 |
| D-3 | 공통 저장소 검수 주체와 갱신 주기 | 결정 | P1 | 완료 | 본인 승인, 큰 업데이트마다 |
| T-118 | 공통 노드에 출처·검수 날짜(`sources`, `verifiedAt`) + 제보 3건이면 근거에서 제외 | 1 품질 | P1 | 대기 | T-106 |
| D-6 | "에이전트 단" 설계 범위 | 결정 | P1 | 결정 필요 | |
| D-5 | 메이플 가이드 문서 출처 (공식만 / 위키 포함) | 결정 | P1 | 완료 | 공식 원문 + 위키·인벤 참고 |
| D-4 | 두 번째 공통 관심사 | 결정 | P1 | 완료 | 식당 |
| T-301 | AI로 관심사 그래프 초안 만들기 + 사용자 검수 | 3 확장 | P0 | 대기 | T-202, T-304 |
| T-304 | 추상 태그를 공통 파일로 분리 (`tags.json`) | 3 확장 | P1 | 대기 | |
| T-302 | 두 번째 공통 관심사: 식당 그래프 + 로그인 없이 관심사 선택 | 3 확장 | P1 | 대기 | T-304 |
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
| T-431 | [L3] Postgres(pgvector·AGE) 전환, t4g.large | L 서버 | P1 | 대기 | T-421, **D-2** |

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
**결정 (2026-10-11)** (c). 기본은 Alt + 호버, 설치 직후 첫 실행 화면에서 "Alt 누르고 올리기 / 자동(머무르면)"을 고른다(T-116).
- 이유: 자동은 처리 시간이 같고 머무름 0.9초만큼 늦게 시작할 뿐이지만, 지나가기만 해도 떠서 LLM 호출이 몇 배로 늘고 무료 키 한도를 금방 쓴다.
- 체감 속도는 트리거가 아니라 응답 방식으로 푼다: 뜻을 먼저 띄우고 비유를 이어서 채우는 스트리밍(T-117). 단계별 로딩 문구와 스피너는 이미 있다(`content.js` `STAGE_TEXT`).
- 다음 후보(아직 작업 아님): Alt keydown 순간 미리 검색 시작, 서버의 "키워드+비유 한 번에" 빠른 모드(architecture-lightrag.md 리스크 표).

### D-2 로그인 방식과 백엔드
- 선택지: (a) Supabase(구글 OAuth + Postgres RLS) (b) Firebase (c) 자체 서버
- 추천: (a). 테이블 두 개(`common_graphs` 공개 읽기, `user_overlays` 본인만)로 끝나고 RLS로 권한이 명확하다.
- 확장 쪽 계약은 이미 있다: `lib/stores.js`의 `remoteAdapter`, 기획서 "사용자 저장소 API".

**보류 (2026-10-11)** L3(로그인·내 워크스페이스) 시작 전에 정한다. 잊지 않도록 T-431과 T-201의 선행 조건으로 걸어 둔다. 2026-10-11에 검토한 선택지:
| 선택지 | 내용 | 장점 | 단점 |
| --- | --- | --- | --- |
| (a) Supabase | 인증 + Postgres + RLS | 테이블 두 개와 RLS로 끝, 구글 로그인 내장 | 서버(EC2)와 DB가 두 곳, 무료 플랜은 1주 미사용 시 일시정지 |
| (b) Firebase | 인증 + Firestore | 구글 로그인이 가장 매끄러움 | 문서형 DB라 그래프·오버레이 다루기 불편, 서버 Postgres와 따로 놂 |
| (c) 자체 | EC2 Postgres + 구글 OAuth + 자체 JWT | 한 곳에서 관리, 추가 비용 없음 | 로그인·토큰 갱신·보안 직접 구현 |
| (d) 인증만 빌리기 | Supabase Auth 또는 Clerk로 로그인만, 데이터는 EC2 Postgres | 어려운 인증은 맡기고 데이터는 한 곳 | 두 서비스 연결 설정 |
추천은 (d): L3에서 EC2 Postgres가 어차피 생기므로 데이터는 거기, 로그인만 맡긴다. 확장 쪽은 `chrome.identity.launchWebAuthFlow`로 붙인다.
### D-3 공통 저장소 검수
게임 패치로 사실이 틀려진다. 누가 검수하고, 얼마나 자주 갱신하는지, 제보 경로를 정한다.

**결정 (2026-10-11)**
- **누가:** 운영자(본인) 혼자 승인. 공개 후에는 사용자 제보를 받아 운영자가 승인하는 방식을 더한다.
- **언제:** 큰 업데이트(여름·겨울 쇼케이스) 때 공통 그래프 전체 검수. 매주 정기 패치는 T-423 자동 감지가 바뀐 시스템과 관련된 노드만 알린다. 식당 그래프는 패치가 없으니 처음 만들 때 한 번 검수한다.
- **어떻게:** 공식 패치 노트·가이드와 대조(D-5). 노드마다 `sources`(URL)와 `verifiedAt`(검수 날짜)를 남긴다(T-118).
- **틀렸을 때:** 말풍선 "어색해요"(T-106) → 제보 목록 → 승인 화면(T-422). 같은 노드에 제보가 3건 쌓이면 검수 전까지 그 노드를 근거에서 잠시 뺀다(T-118).
- 첫 전체 검수는 2026-10-11에 했다(그래프 2026.10.11-1).
### D-5 메이플 가이드 문서 출처
LightRAG 공통 그래프(T-421)에 넣을 문서. 선택지: (a) 공식 가이드만 (b) 나무위키 등 커뮤니티 문서 포함 (c) 직접 요약한 문서만. 라이선스(CC BY-NC-SA 등)와 출처 표기, 패치 주기에 따른 갱신 방법을 함께 정한다. 추천: (a)+(c)로 시작하고 (b)는 라이선스 확인 후.
**결정 (2026-10-11)** 원문 인덱싱은 공식 가이드·패치 노트만. 나무위키와 메이플 인벤은 **참고용**: 읽고 사실을 확인해 우리 문장으로 새로 쓴 요약 문서만 넣고, 원문을 수집·저장·요약 저장하지 않는다. 이유: 저작권은 표현만 보호해서 사실을 다시 쓰는 건 자유롭지만, 원문 수집은 나무위키 CC BY-NC-SA(비상업·동일조건), 인벤 게시글 작성자 저작권, 데이터베이스 제작자 권리(저작권법 제93조), 각 사이트 약관·robots.txt에 걸린다. 이렇게 하면 상업화 여부와 무관하다. 출처가 다르면 공식을 따른다. 요약 문서에도 자주 바뀌는 수치는 넣지 않는다(규칙 2).

### D-6 "에이전트 단" 설계 범위
2026-10-17 사용자 질문: "에이전트 단에 대한 구현 설계 되어 있니?" → 별도 설계 없음. 지금 있는 것은 고정 파이프라인(호버), 추출 큐 워커(T-414), cron(T-423), LLM 초안 + 사람 승인(T-424·T-422·T-301)뿐이다. 사용자가 어느 뜻인지 아직 답하지 않았다. 다음 세션은 먼저 묻는다.
- (1) **오프라인 에이전트**(밈 조사·패치 반영·검수 리포트·관심사 초안): 도구(읽기 대상·D-5 원문 저장 금지·약관), 모델(맥은 추출 전용, 규칙 8), 실행당 예산, 승인 큐·감사 기록, 실패 처리, 안전장치(금칙어·실존 인물·근거 밖 사실)를 묶은 공통 설계 → ADR 0008 + 설계 문서 새 절(md·html 함께).
- (2) **호버 경로를 에이전트화**: 단계 선택을 LLM에 맡김. 지연(이미 3~9초)과 근거 검증(규칙 1) 때문에 비추천, 하려면 장단점 정리부터.
- (3) **개발용 Claude Code 에이전트**: `.claude/commands`(add-common-node, eval, next-task, ship, verify) 정리·확장, 서브에이전트·팀 구성.
- 추천: 호버는 고정 파이프라인 유지, 에이전트는 (1)의 오프라인 작업에만.

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
**결과 (2026-10-11)** 무료 Gemini 키로 완료 기준 충족(아래). OpenAI·Anthropic은 키가 없어 건너뜀, Groq는 키를 받으면 같은 스크립트로 확인.
- 스모크(`gemini-3.8-flash`, thinking low): 추상화 3.3초, 비유 생성 2.6초·1.9초, JSON·`nodeId` 검증 통과.
- 실제 확장(headless 크롬, 실제 키 + 실제 임베딩): 연결 테스트 통과, 호버 3건 모두 성공. 걸린 시간 3.6초·9.1초·3.6초(캐시 없음, 임베딩 포함). **설계 가정(1~2초)보다 느려서** T-117(뜻 먼저)의 우선순위를 올릴 근거.
- 레버리지 문장은 검색 후보가 `meso_inflation`·`meso`·`auction`(T-113 쏠림)이라 LLM이 비유를 내지 않았다. 억지 비유 대신 빈칸 = 규칙대로 동작. 검색이 고쳐져야 비유가 나온다.
- 품질 메모(T-104): API 요청 제한 문장의 뜻풀이가 "한 사용자"를 "서버"로 옮겨 적음.
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
**진행 (2026-10-11)** 실제 확장(headless 크롬)에서 `embed:warmup` → `ready`, `embedderId = Xenova/multilingual-e5-small@q8` 확인. 첫 로드 13.9초(모델 다운로드 포함). 남은 것: 두 번째 실행 캐시 3초, 느린 네트워크에서 서비스 워커 생존, Hugging Face 차단 시 설정 화면 문구, 받은 용량 기록.
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
**할 일** 차례로 시도하고 각각 EVAL_LOG에 기록: (1) 노드 임베딩 텍스트에서 게임 고유 용어 비중 줄이고 구조 설명 비중 늘리기 (2) 태그에 분야가 다른 예문 `examples` 추가(T-103과 공유) (3) 경제 태그(`market_price`, `inflation`)에 일정 감점 또는 태그 점수 상위 2개 평균 (4) 질의를 LLM으로 "추상 구조 한 줄"로 바꾼 뒤 임베딩(정밀 모드와 같음, 무료 키로 시험) (5) 태그를 임베딩 대신 판정 모델로 고르기(T-120, Jev 또는 Gemini 객관식).
**완료 기준** 실제 모델 혼합 hit@1 ≥ 13/16, 금융 문장 5건 중 3건 이상 맞힘. T-103의 확장 평가셋에서도 떨어지지 않을 것.
**파일** `extension/lib/graph.js`, `extension/lib/retrieval.js`, `extension/data/common/maplestory.json`, `tools/eval.mjs`

### T-119 실제 키 스모크 CI 워크플로
**왜** 로컬 `~/.zshrc` 말고도 같은 키로 언제든 제공자 형식을 확인할 수 있게 한다. 공개 저장소라 키는 Actions 비밀값에만 둔다(암호화 `.env` 커밋은 검토 후 보류: 무료 키라 위험은 낮지만 개인키 관리 부담이 생기고, 비밀값으로 충분).
**할 일** `.github/workflows/smoke.yml`: `workflow_dispatch`(입력 `all_models`), `permissions: contents: read`, 비밀값 `GEMINI_API_KEY`·`GROQ_API_KEY`를 env로 넘겨 `npm run smoke:providers`. PR·push에는 돌지 않는다. CLAUDE.md에 키 두는 곳 표.
**완료 기준** dev 병합 뒤 Actions 탭에서 수동 실행 → Gemini·Groq 모두 통과(로그에 키 값 없음). 결과를 작업 로그에.
**결과 (2026-10-11, run 38127720608)** 워크플로·비밀값 전달 정상, 로그에 키 없음. Groq 전부 통과(0.4~0.9초). Gemini는 추상화 통과(5.4초), 비유 생성 2건이 `503 high demand`로 실패 → 일시 오류라 T-121 완료 기준에 "재시도 뒤 수동 스모크 재실행에서 Gemini 통과"를 넣어 이어서 확인한다.

### T-120 Jev로 추상 태그 판정 실험
**왜** T-113의 쏠림은 임베딩이 "단어가 비슷한 쪽"을 고르기 때문이다. Jev(TypeSafe AI, 2026-09-15 얼리 액세스)는 글을 쓰지 않고 정해진 질문에 선택지·확률로 답하는 판정 모델이라, "이 문장의 구조는 태그 18개 중 무엇인가"를 직접 물을 수 있다. 회사 주장 응답 0.07~0.5초, 입력 100만 토큰당 $0.042(모두 자체 발표, 독립 평가는 엇갈림, 한국어 성능 자료 없음).
**할 일**
- `extension/lib/judges.js`: "판정기" 인터페이스 `judge({ text, question, choices, multi }) → [{ id, p }]`. 생성 제공자 레지스트리(규칙 7)와 같은 방식으로 판정기 항목을 둔다: `jev`(키 필요), `gemini-choice`(Jev를 못 쓸 때 대체: Gemini에 객관식 JSON으로 질문). 호버 경로 클라우드만(규칙 8).
- 질문 1: 문장 → 추상 태그(다중 선택, 통제 어휘 18개, 규칙 9). 결과를 `retrieve()`의 태그 유사도 대신 또는 함께 쓴다.
- 질문 2(선택): 후보 3개 중 구조가 맞는 것 / 없음. "없음" 확률이 높으면 생성 LLM을 부르지 않는다(지연·비용 절약, 규칙 1은 그대로).
- `tools/eval.mjs --judge <id>`: 평가셋으로 태그 top-1과 노드 hit@1/@3 비교, 판정 지연 시간 기록.
- 나중 후보(이 작업 범위 밖): 멸칭·용어 카드 분류 보조(T-114·T-424, 사람 승인 유지), 생성 품질 채점(T-104).
**선행** 얼리 액세스(사용자가 신청). 키는 Actions 비밀값 `JEV_API_KEY`와 `~/.zshrc`. 한국어 판정이 되는지 평가셋 16문장으로 먼저 확인한다.
**완료 기준** EVAL_LOG에 임베딩 / `gemini-choice` / `jev` 세 줄 비교(혼합 hit@1, 태그 top-1, 판정 지연). 채택 여부를 ADR로 남긴다. Jev 없이도 `gemini-choice`로 실험은 진행할 수 있다.

### T-121 제공자 일시 오류 재시도
**왜** 2026-10-11 스모크에서 Gemini가 `503 This model is currently experiencing high demand`로 한 번 실패했다. 지금은 재시도 없이 바로 말풍선 오류가 된다.
**할 일** `lib/providers.js`의 공통 호출부(`postJSON`)에서 503·429·네트워크 오류만 재시도: 최대 2회, 지수 백오프(0.5초 → 1.5초, 지터), 429에 `Retry-After`가 있으면 따르되 상한 3초. 400·401·403은 재시도하지 않는다(키 오류는 즉시 알림). 전체 시간 상한은 기존 타임아웃 안에서. 재시도 횟수를 `debug`에 남긴다. 제공자별 분기 없이 한 곳에서(규칙 7).
**완료 기준** 단위(가짜 fetch): 503 → 성공 시 결과 반환·호출 2회, 429 `Retry-After` 준수, 401은 1회만 호출, 재시도 다 써도 실패하면 기존 오류 문구. 병합 뒤 `smoke` 워크플로 재실행에서 Gemini·Groq 모두 통과(T-119에서 이어짐).

### T-122 Groq 응답 품질과 기본 제공자 검토
**왜** 2026-10-11 수동 스모크에서 Groq(`openai/gpt-oss-120b`)가 Gemini보다 5~10배 빨랐다(0.4~0.9초 대 1.9~5.4초). 호버 지연(T-117)에 크다. 다만 (1) 비유를 "~습니다"로 끝내 규칙 5(~요)를 어겼고 (2) 정밀 모드 추상화에 원문 전문용어("레버리지")를 그대로 썼다.
**할 일** 프롬프트 규칙 문구를 모델과 무관하게 지켜지도록 다듬고(예시 한 줄, 끝맺음 명시), 생성 후 끝맺음 검사로 "~습니다"체를 잡아 한 번 다시 요청하거나 표시만 한다. 스모크에 존댓말·용어 검사 추가. 후보 모델은 [Artificial Analysis 리더보드](https://artificialanalysis.ai/leaderboards/models)로 먼저 추리고(지능·속도·첫 토큰 지연·가격, 확인 날짜와 함께), 평가셋 문장으로 Gemini·Groq의 응답 시간(뜻까지)·근거 준수·존댓말을 비교해 기본 제공자(`config/admin.json` `defaultProvider`)를 정한다. 무료 한도(분당·일당)도 함께 적는다.
**완료 기준** 스모크에 문체 검사 통과(두 제공자), 비교표를 작업 로그에, 기본 제공자 결정(바꾸면 ADR 0005 갱신).

**사전 측정 (2026-10-18, smoke run 39100925941, `--all-models`, 문장 2개라 참고용)** 뜻까지 시간 / 비고
- `gemini-3.8-flash`: 1.8·6.1초, 첫 글자 ≈ 전체(스트리밍 이득 없음). Rate limit 문장은 비유 없음(보수적).
- `gemini-3.5-flash-lite`: 7.2·6.4초(재시도 1회). 느림.
- `gemini-3.1-flash-lite`: 5.7·2.3초. **근거 밖 사실**: "보스 일주일 입장 횟수"는 `boss_entry` facts에 없음(nodeId는 맞아 검증을 통과함 → 사실 단위 검사가 필요).
- `gpt-oss-120b`: 0.6·0.5초. 존댓말 지킴. 추상화에 "레버리지" 그대로. Rate limit → `arcane_force`(구조는 맞지만 `boss_entry`보다 약함).
- `gpt-oss-20b`: **0.25·0.57초(가장 빠름)**. 존댓말 지킴. 추상화에 원문 그대로. 뜻에 "초당"(원문은 분당) 오역.
- `qwen3.8-27b`: 추상화만 통과, 비유는 429(Groq 무료 출력 토큰 분당 1000 한도 초과) → 무료로는 못 씀.

**리더보드 후보 (Artificial Analysis, 2026-10-18 확인)** 열: 지능 지수 / 첫 조각(초) / 전체 응답(초) / 작업당 비용. 첫 조각은 여러 호스트 중앙값이라 Groq 같은 빠른 호스트는 더 짧다. 한국어 품질은 리더보드에 없어서 스모크로 잰다. 이 앱은 출력이 짧은 JSON이라 **첫 조각 1.5초 이하**를 먼저 본다.
- 지금 쓰는 것: `gpt-oss-120b`(high) 12 / 0.86 / 12.5, `gpt-oss-20b`(high) 9 / 0.70 / 11.6, `Gemini 3.8 Flash`(high) 41 / **22.6** / 26.0(thinking 때문에 느림, low는 지수 33·속도 자료 없음), `Gemini 3.5 Flash-Lite` 22 / 6.85 / 8.0.
- 첫 조각이 빠르고 지수가 더 높은 것(유료·OpenAI 호환): `DeepSeek V4.1 Flash`(non-reasoning) 25 / 1.27 / 4.3 / $0.15, `Nemotron 3.5 Super VL` 26 / 0.75 / 7.2 / $0.19, `Inkling Small` 26 / 1.68 / 14.0 / $0.09, `GPT-6 Luna`(non-reasoning, 레지스트리에 있음) 18 / 0.94 / 5.4 / $0.01.
- 지수는 높지만 첫 조각이 느린 것: `Claude Haiku 5.5`(low) 29 / 6.33, `GLM-5.3-Flash` 42 / 2.77, `Qwen3.8-Flash-Next` 40 / 2.16.
- 다음: 무료로 쓸 수 있는 호스트(Groq·Cerebras·OpenRouter 무료)에 위 후보가 있는지 확인 → `custom`(OpenAI 호환)으로 스모크. Gemini는 `thinkingLevel` 최소로 첫 조각이 줄어드는지 먼저 잰다.

### T-123 근거 facts 밖 사실 검사
**왜** 2026-10-18 사전 측정에서 `gemini-3.1-flash-lite`가 `boss_entry`를 고르고 facts에 없는 "일주일 입장 횟수"를 지어냈다. 지금 검증(규칙 1)은 `nodeId`가 후보에 있는지만 보므로 통과한다.
**할 일** 방법 후보: (1) 프롬프트에 "비유에 쓴 사실은 facts 문장을 그대로 인용" + `usedFact` 필드로 받아 facts와 대조 (2) 비유 문장과 고른 노드 facts의 임베딩·글자 겹침이 낮으면 숨김 (3) 정밀 모드에서 판정 호출 1회(T-120 판정기와 공유). 호버 지연(T-117)을 늘리지 않는 쪽을 먼저.
**완료 기준** 가짜 LLM이 facts 밖 수치·규칙을 넣은 비유를 내면 숨김(e2e), 정상 비유는 그대로(오탐 없음). 실제 키 스모크에 검사 결과 표시.
**파일** `extension/lib/prompt.js`, `extension/background.js`, `tools/smoke-providers.mjs`
### T-124 [사용자 추가] 모델 순위 fallback 체인 + 429 쿨다운
> 체인은 1·2순위로 끝나지 않는다. 병합 전후로 순위가 더 붙을 수 있다(사용자 안내, 2026-10-18). 길이를 가정하지 말고 `fallbackChain`에 항목만 추가한다.
**왜** 2026-10-18 사용자 요청. 등록 모델 전체 측정(smoke run 39100925941)과 Artificial Analysis 리더보드 후보 정리(T-122 섹션, PR #8) 결과, 무료로 쓸 수 있는 모델 중 1순위 Groq `openai/gpt-oss-120b`(뜻까지 0.5~0.6초, 존댓말 지킴), 2순위 Gemini `gemini-3.8-flash`(1.8~6초, 근거 없으면 비유를 비우는 보수적 응답, 할당량이 Groq와 따로)를 남긴다. 무료 한도 429가 잦아(Gemini 일일 할당량, Groq 출력 토큰 분당 한도) 한 제공자만으로는 호버가 실패한다.
**할 일** `config/admin.json`에 `fallbackChain`(순서 = 순위)과 `cooldown`. 호출 순서 = 사용자가 고른 제공자·모델 → 체인(중복·키 없음·허용 안 됨은 건너뜀). 429·503·네트워크·시간 초과면 다음 순서로. 429를 받은 모델은 `Retry-After`(없으면 기본값) 동안 쿨다운하고 그동안은 바로 다음 순서로 간다(쿨다운 기록은 `chrome.storage.session`, 서비스 워커가 잠들어도 유지). 다음 순서가 있으면 429에 같은 모델 재시도를 하지 않는다. 키 오류(400·401·403)는 체인을 타지 않는다. 모두 쿨다운이면 가장 먼저 풀리는 것을 시도. `debug.provider`는 실제로 답한 모델, `debug.fallbacks`에 건너뛴 이유.
**완료 기준** 단위: 체인 구성(중복·키 없음·데모), 429 → 다음 모델 + 쿨다운 기록, 쿨다운 중 건너뜀, 풀리면 다시 시도, 401은 체인 안 탐, 모두 쿨다운이면 가장 이른 것. e2e: 가짜 LLM이 429를 내는 모델에서 체인 다음 모델로 답하고, 두 번째 호버는 429 모델을 부르지 않음. 근거 검증(규칙 1)은 그대로.
**진행 과정**
- 2026-10-18 사용자 요청 "바로 측정" → 등록 모델 6개 CI 스모크(`--all-models`), 결과는 T-122 사전 측정.
- 2026-10-18 사용자 요청 "모델 성능은 Artificial Analysis 리더보드 우선 참고" → CLAUDE.md·ADR 0005·T-122에 기록, 후보 정리(PR #8).
- 2026-10-18 사용자 요청 "1·2순위 + fallback 체인 + 429 쿨다운" → 이 작업. T-117(#7)과 `providers.js`가 겹쳐 그 브랜치 위에 쌓음(#7 먼저 병합).
- 2026-10-18 구현: `lib/fallback.js`(`buildChain`, `completeWithFallback`), `config.providerFor`, `noRetry429`. 기본 제공자 gemini → groq. 단위 10개(44)·e2e 1개(9) 추가. ADR 0008, CLAUDE.md, intro.html 갱신.
- 2026-10-18 사용자 안내 "병합 전후로 폴백 체인이 더 추가될 수 있음" → 체인 길이에 기대지 않도록 3개 체인 단위 테스트 추가(45), ADR 0008에 "순위를 더할 때" 절차. CLAUDE.md 규칙 7, `admin.json` 설명, 이 섹션 머리에도 명시.
- 2026-10-18 사용자 질문 "3.8 Flash는 너무 느리지 않나, 3.5 Flash-Lite가 괜찮다던데" → 로컬 키로 thinking 단계별 재측정(비유 프롬프트 1건 × 2회, 스트리밍): `gemini-3.5-flash-lite` minimal 첫 0.6~1.2초·전체 1.0~1.6초, low 첫 0.9~1.1초·전체 1.4~1.5초 / `gemini-3.1-flash-lite` 2.1~9.2초(들쭉날쭉) / `gemini-3.8-flash` low 2.6초(1건, 나머지 429), minimal은 400(미지원). 아까 CI의 3.5 Flash-Lite 6~7초는 재현 안 됨. 체인 2순위를 3.5 Flash-Lite로 바꾸는 안을 사용자에게 물음.
- 2026-10-18 사용자 결정 "Groq → 3.5 Flash-Lite → 다른 무료 키(NVIDIA)" → `PROVIDERS.nvidia` 추가(OpenAI 호환 `https://integrate.api.nvidia.com/v1`, 스트리밍), manifest 호스트 권한, 체인 3순위 `nvidia/nemotron-3.5-super-vl-120b-a12b`(리더보드 첫 조각 0.75초), Gemini 기본 모델도 3.5 Flash-Lite로. 3.8 Flash는 체인에서 빠지고 레지스트리에만 남음. 체인 설정 검사 단위 테스트 2개(레지스트리·허용 목록·호스트 권한). smoke 워크플로에 `NVIDIA_API_KEY`. **NVIDIA 모델 ID는 제3자 목록(freellm.net) 기준, 키가 없어 실제 호출 미확인.** 무료는 키당 분당 40회, 개발용 약관 → T-303 전에 확인.
- 2026-10-18 사용자가 NVIDIA 키(로컬·CI) 넣음 → 실제 확인. 모델 ID 3개 모두 `/v1/models`에 있음. 기본 설정에선 super-vl 500·30초 초과, deepseek-v4.1-flash·nemotron-3.5-lightning 20초 넘게 무응답(목록에서 뺌). 원인은 생각(reasoning)부터 하는 것: `chat_template_kwargs: {enable_thinking: false}`(항목 `extraBody`)로 끄면 super-vl 비유 스모크 **첫 글자 0.28·0.29초, 뜻 0.49·0.98초**, 존댓말 지킴(끄기 전 14~17초). 단, Rate limit 비유에 "1분 보스 입장 횟수"를 지어냄(T-123). `nemotron-3-super-120b`는 끄고도 뜻 1.0~4.3초, "~입니다"체, 태그 id를 nodeId로 냄(규칙 1 검증이 숨김) → 2번째 후보로만 남김. 3순위는 super-vl 유지.
**파일** `extension/lib/fallback.js`(새), `extension/lib/providers.js`, `extension/background.js`, `extension/config/admin.json`, `scripts/prepare-e2e.mjs`, `tests/unit/fallback.test.mjs`, `tests/e2e/*`

### T-125 [사용자 추가] 체인 2·3순위 교체 (Gemini 3.5 Flash-Lite, NVIDIA Build)
**왜** 2026-10-18 사용자 요청. #9(T-124)가 병합된 뒤에 올린 커밋 5개가 빠져서 따로 올린다. 재측정에서 `gemini-3.8-flash`가 느리고(스트리밍 이득 없음) `gemini-3.5-flash-lite`가 첫 글자 1초 안팎이었고, 사용자가 3순위로 NVIDIA Build 무료 API를 정했다.
**할 일** 체인 = Groq `openai/gpt-oss-120b` → Gemini `gemini-3.5-flash-lite` → NVIDIA `nvidia/nemotron-3.5-super-vl-120b-a12b`. `PROVIDERS.nvidia`(OpenAI 호환, 스트리밍, `chat_template_kwargs.enable_thinking: false`), manifest 호스트 권한, Gemini 기본 모델 3.5 Flash-Lite, smoke 워크플로 `NVIDIA_API_KEY`.
**완료 기준** 단위: `admin.json` 체인의 모든 순위가 레지스트리 모델·허용 목록·호스트 권한 안, 체인 순서, NVIDIA 요청에 thinking 끄기. 실제 키 스모크에서 NVIDIA super-vl 통과.
**진행 과정** 측정·결정 경과는 T-124 진행 과정의 2026-10-18 항목들(3.5 Flash-Lite 재측정, NVIDIA 키 실측)에 있다.
**무료 한도와 하루 예상 호출량 (2026-10-18, 한도는 제3자 정리 기준 · 각 콘솔에서 다시 확인)** 호버 1회 = 비유 호출 1번, 실측 약 900~1,200토큰(입력 800~1,040 + 출력 100~170). 정밀 모드는 추상화 호출이 더해져 +130~310토큰, 요청 2배.
| 순위 | 모델 | 무료 한도 | 먼저 막히는 것 | 하루 호버 어림 |
| --- | --- | --- | --- | --- |
| 1 | Groq `gpt-oss-120b` | 분당 30회·8,000토큰, 하루 1,000회·200,000토큰 | 하루 토큰 | 약 170~200회 (분당 6~7회) |
| 2 | Gemini `gemini-3.5-flash-lite` | 분당 15회, 하루 500회(측정 보고, 공식 미공개) | 하루 요청 | 약 500회 |
| 3 | NVIDIA `nemotron-3.5-super-vl` | 키당 분당 40회(전 모델 공유), 하루 상한 보고 없음 | 분당 요청 | 개인 사용엔 사실상 제한 없음(개발용 약관) |
세 개를 합치면 하루 약 700회 + NVIDIA. 같은 문장은 결과 캐시로 다시 부르지 않는다. 순서는 속도(Groq 0.5초 · NVIDIA 0.5~1초지만 들쭉날쭉 · Gemini Lite 1초 안팎)와 안정성·근거 준수로 지금 순서를 유지. Groq 하루 한도가 다 차면 쿨다운 상한(10분)마다 한 번씩 429를 다시 맞는다 → T-126.

### T-126 하루 한도 429는 리셋까지 쿨다운
**왜** Groq 무료는 하루 200,000토큰(호버 약 170~200회)이라 많이 쓰는 날엔 한낮에 다 찬다. 지금 쿨다운은 `Retry-After`를 10분 상한으로 자르므로, 하루 한도가 찬 뒤에도 10분마다 1순위를 한 번씩 불러 429를 받는다(0.3초쯤 손해, 요청 1회 낭비).
**할 일** 429 응답 본문·헤더로 하루 한도(Groq `tokens per day (TPD)`·`requests per day`, Gemini `PerDay` quota)를 구분해 그때는 `cooldown.dailyMaxMs`(예: 다음 리셋까지, 상한 24시간)를 쓴다. 분당 한도는 지금처럼.
**완료 기준** 단위: 하루 한도 429는 긴 쿨다운, 분당 429는 기존 상한. 각 제공자의 실제 429 본문 예시를 테스트 입력으로.

### T-127 [사용자 추가] 로컬 Ollama 최종 방어선
**왜** 2026-10-18 사용자 결정. 로컬 모델은 인덱싱 추출용으로 정했지만(ADR 0006, 그래서 인덱싱 품질이 클라우드 상태에 흔들리지 않는다), 추론(호버)에서도 클라우드 무료 모델이 모두 막혔을 때의 마지막 방어선으로 쓴다. 다른 무료 모델은 무조건 Ollama보다 앞.
**할 일** `PROVIDERS.ollama`(`http://127.0.0.1:11434/v1`, `local: true`, 키 없음, 스트리밍, `gemma4:12b`), `buildChain`이 `local`을 항상 맨 뒤로, `fallbackChain` 맨 끝, manifest 호스트 권한, smoke가 로컬 서버가 떠 있으면 포함. CLAUDE.md 규칙 8, ADR 0006·0008, `architecture-lightrag.md`·`.html`, intro.html.
**완료 기준** 단위: 로컬은 사용자가 골라도·체인 중간에 있어도 맨 뒤, 꺼져 있으면 앞 순위가 모두 실패했을 때만 오류. 수동: Ollama 설치 + `OLLAMA_ORIGINS=chrome-extension://*` 뒤 스모크로 첫 글자·뜻 시간.
**진행 과정**
- 2026-10-18 사용자 질문 "로컬 모델은 이 파트에서 쓰는 게 아닌가" → 설계상 추출 전용(ADR 0006·규칙 8)이라고 답함.
- 2026-10-18 사용자 결정 "추론 최종 순위(다른 무료 모델은 무조건 Ollama 앞)로 최종 방어선" → 구현. 단위 3개(50). 이 맥에는 Ollama 미설치라 실제 호출은 미확인. #10에 함께 올림(같은 파일).

### T-116 첫 실행 트리거 선택 (D-1)
**할 일** 설치 직후(`chrome.runtime.onInstalled`, reason=install) 여는 설정 화면 맨 위에 한 화면짜리 안내: "Alt 누르고 문장에 올리기(추천) / 머무르면 자동". 기본 선택은 Alt. 고르면 `triggerMode` 저장 후 안내를 접는다. 자동을 고르면 "호출이 많아져 무료 한도를 빨리 써요" 한 줄.
**완료 기준** e2e: 새 프로필 설치 → 안내 표시 → 자동 선택 → 설정 저장 확인 → 다시 열면 안내 없음.

### T-117 뜻 먼저 보여 주기 (스트리밍)
**왜** 첫 호버는 LLM 응답까지 1~2초(서버 전환 뒤 2~3초) 기다린다. 뜻풀이가 먼저 보이면 체감이 빨라진다(D-1).
**할 일** 제공자 호출에 스트리밍 옵션(`PROVIDERS` 항목 설정으로, 규칙 7). 응답 JSON의 필드 순서를 `meaning` → `analogy` → `nodeId`로 고정하고, 부분 JSON에서 `meaning`이 완성되면 포트로 `partial` 메시지를 보내 말풍선에 먼저 띄운다. 비유는 `nodeId` 검증(규칙 1)이 끝난 뒤에만 보인다. 서버(T-402)는 SSE로 같은 순서.
**완료 기준** e2e(가짜 LLM이 천천히 흘려보냄): 뜻이 비유보다 먼저 보임, 후보 밖 `nodeId`면 비유가 끝까지 안 보임. 실제 키로 첫 글자까지 시간을 작업 로그에.

### T-118 공통 노드 출처·검수 날짜와 제보 제외 (D-3)
**할 일** 공통 노드에 `sources`(URL 배열)와 `verifiedAt`(YYYY-MM-DD). `validateGraph`가 공통 그래프에서는 둘 다 요구. 2026-10-11 검수 결과(PR #2)의 출처를 채운다. T-106의 "어색해요" 제보가 같은 공통 노드에 3건 쌓이면 그 노드를 검수 전까지 후보에서 뺀다(로그인 전에는 기기 안에서만, 서버 전환 뒤에는 서버 집계). 말풍선 근거에 "검수 2026-10" 표시.
**완료 기준** 단위: 출처 없는 공통 노드는 검증 오류, 제보 3건이면 후보 제외. e2e: 근거에 검수 날짜 표시.

### T-115 앱 이름 변경: 좋은비유네용
**왜** 2026-10-11 사용자가 확정. 배경과 주의점은 [naming-meme.md](naming-meme.md)(원래 반어였던 밈이라 비유 품질과 이름이 묶인다).
**할 일** `extension/manifest.json`의 `name`·`default_title`(PoC 표시는 유지), 팝업·설정 화면 제목, 말풍선 표시 이름(`content.js`, `content.css`의 주석 포함), `package.json` `name`(영문 슬러그 `good-metaphor`), README, CLAUDE.md 제목, `docs/intro.html`·`architecture-lightrag.html` 제목, 기획서. 피드백 버튼 문구는 T-106에서.
**완료 기준** 코드·문서에서 "비유 도우미"·"비유 설명 도우미"·`analogy-helper`가 남지 않음(빌드 산출물 제외), e2e 통과(제목을 확인하는 테스트가 있으면 함께 수정).

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
| 2026-10-18 | T-127 | task/T-125-chain-nvidia | [#10](https://github.com/roasted-penguin/good-metaphor/pull/10) | **[사용자 추가]** 로컬 Ollama `gemma4:12b`를 호버 체인 맨 뒤 최종 방어선으로(`local`은 항상 맨 뒤). 규칙 8과 설계 문서 세 곳 갱신. Ollama 미설치로 실제 호출 미확인. |
| 2026-10-18 | T-125 | task/T-125-chain-nvidia | [#10](https://github.com/roasted-penguin/good-metaphor/pull/10) | **[사용자 추가]** #9 병합 뒤 커밋 5개가 빠져 따로 올림: 체인 Groq → Gemini 3.5 Flash-Lite → NVIDIA super-vl(thinking 끔, 뜻 0.5~1.0초), `PROVIDERS.nvidia`, 체인 설정 검사 테스트. T-124 완료 반영. |
| 2026-10-18 | T-124 | task/T-124-fallback-chain | [#9](https://github.com/roasted-penguin/good-metaphor/pull/9) | **[사용자 추가]** Groq `gpt-oss-120b` → Gemini `gemini-3.5-flash-lite` → NVIDIA `nemotron-3.5-super-vl` fallback 체인(처음 3.8 Flash였다가 재측정 뒤 사용자 결정으로 교체), 429 쿨다운(Retry-After, 기본 60초, 상한 10분, session 저장). 다음 순서가 있으면 429 재시도 생략, 키 오류는 체인 안 탐. 기본 제공자 groq. T-117 위에 쌓음. 실제 키로 체인 동작은 미확인(Groq 키가 로컬에 없음). |
| 2026-10-18 | 문서 | task/docs-model-reference | [#8](https://github.com/roasted-penguin/good-metaphor/pull/8) | 모델 성능 비교는 Artificial Analysis 리더보드를 먼저 참고하도록 CLAUDE.md 함정·ADR 0005·T-122 할 일에 추가. |
| 2026-10-18 | T-117 | task/T-117-stream-meaning | [#7](https://github.com/roasted-penguin/good-metaphor/pull/7) | `PROVIDERS`에 `stream`, 종류별 차이는 `KINDS` 표(build·text·chunk) 한 곳. 응답 받기 전까지만 재시도. 뜻이 닫히면 `partial`(meaning만) → 말풍선에 먼저, 비유는 검증 뒤 `result`로만. 단위 10개·e2e 2개 추가(34·8). 실제 키 스모크(run 39099966893): Groq 첫 글자 415~685ms, 뜻 485~717ms, 전체 674~837ms. 로컬 새 Gemini 키(gemini-3.8-flash): 스트리밍 형식 통과, 하지만 첫 글자 4.1·7.9초 ≈ 전체(조각이 사실상 한 번에 옴, 대기는 thinking) → Gemini에선 체감 이득 없음, T-122 기본 제공자 검토 근거. |
| 2026-10-18 | 도구 | task/test-first-command | [#6](https://github.com/roasted-penguin/good-metaphor/pull/6) | `/test-first` 명령 추가: 테스트 계획을 먼저 보여 주고 승인받은 뒤 실패하는 테스트부터 구현(superpowers 스킬 연결). PR 템플릿에 "테스트 계획" 칸, CLAUDE.md 작업 방식 3단계에 안내. |
| 2026-10-11 | T-120·T-121 | task/T-119-smoke-workflow | [#3](https://github.com/roasted-penguin/good-metaphor/pull/3) | T-120(Jev 판정기 실험, 대체는 Gemini 객관식) 등록. 스모크 중 Gemini 503 발견 → T-121(일시 오류 재시도) 등록. |
| 2026-10-11 | T-119 | task/T-119-smoke-workflow | [#3](https://github.com/roasted-penguin/good-metaphor/pull/3) | 수동 실행 스모크 워크플로 추가, 키는 Actions 비밀값(GEMINI·GROQ 등록 확인). 실행 확인은 dev 병합 뒤(workflow_dispatch는 기본 브랜치에 있어야 버튼이 생김). |
| 2026-10-11 | T-101 | task/eval-real-model | [#2](https://github.com/roasted-penguin/good-metaphor/pull/2) | 무료 Gemini 키로 스모크·실제 확장 확인. 호출 1.9~3.3초, 호버 3.6~9.1초(설계 가정보다 느림 → T-117). 레버리지 문장은 T-113 쏠림으로 비유 없음(빈칸, 규칙대로). T-102 첫 로드 13.9초 확인. |
| 2026-10-11 | D-1·D-3 | task/eval-real-model | [#2](https://github.com/roasted-penguin/good-metaphor/pull/2) | D-1(기본 Alt + 첫 실행 선택), D-3(본인 승인, 큰 업데이트마다, 출처·검수 날짜, 제보 3건 제외) 결정. D-2는 L3 전에 결정(T-431·T-201 선행 조건). T-116·T-117·T-118 추가. |
| 2026-10-11 | NAME | task/eval-real-model | [#2](https://github.com/roasted-penguin/good-metaphor/pull/2) | 앱 이름 "좋은비유네용" 확정, 변경 작업 T-115 추가. |
| 2026-10-11 | D-4 | task/eval-real-model | [#2](https://github.com/roasted-penguin/good-metaphor/pull/2) | D-4 결정: 기본 메이플, 두 번째 식당(로그인 없이 선택), 그 외 가입 후 커스텀. 태그 분리 T-304 추가, T-302·T-301 구체화. |
| 2026-10-11 | DOC | task/eval-real-model | [#2](https://github.com/roasted-penguin/good-metaphor/pull/2) | 최신화 설계(ADR 0007): 패치 노트 원문 자동 반영(T-423), 밈 용어 카드 승인 흐름(T-424), 규칙 2 범위 조정. 설계 문서 md·html·ADR 0006 갱신. |
| 2026-10-11 | DATA | task/eval-real-model | [#2](https://github.com/roasted-penguin/good-metaphor/pull/2) | 공통 그래프 사실 검수(공식 패치 노트 update/799·806, 나무위키): 스타포스 파괴 후 흔적 복구(2026-03), 샤이닝 스타포스 타임 이름, 큐브 → 메소 재설정 병행, 심볼·아케인포스·결정석·유니온·솔 에르다 문장 수정. 수치는 넣지 않음. 등급색은 공식 값이 공개돼 있지 않아 유지(ADR 0004 메모 갱신). 그래프 버전 2026.10.11-1. |
| 2026-10-11 | T-101 | task/eval-real-model | [#2](https://github.com/roasted-penguin/good-metaphor/pull/2) | 스모크 스크립트 `npm run smoke:providers` 추가(가짜 서버로 통과). Gemini가 잘못된 키 400을 thinkingConfig 오류로 오인해 한 번 더 호출하던 문제 수정 + 단위 테스트 2개. 실제 무료 키 확인은 남음. |
| 2026-10-11 | EVAL | task/eval-real-model | [#2](https://github.com/roasted-penguin/good-metaphor/pull/2) | 첫 실제 임베딩 모델 평가: e5-small 혼합 hit@1 11/16, hit@3 12/16(대체 임베더 12/16보다 낮음). 주제 편향을 T-113으로 추가. Node 20.8에서는 transformers.js(sharp)가 안 떠서 `engines`를 22 이상으로. |
| 2026-09-29 | DOC | task/docs-architecture | [#1](https://github.com/roasted-penguin/good-metaphor/pull/1) | 설계 문서 시각화: `architecture-lightrag.md`에 Mermaid 그림 4개, `architecture-lightrag.html` 추가. |
| 2026-09-29 | DOC | task/docs-architecture | [#1](https://github.com/roasted-penguin/good-metaphor/pull/1) | LightRAG 아키텍처 설계(`docs/architecture-lightrag.md`, ADR 0006), LightRAG 트랙 작업 T-401~T-431 추가, 소개 페이지에 다음 아키텍처 구성도 추가. |
| 2026-09-28 | DOC | task/docs-architecture | [#1](https://github.com/roasted-penguin/good-metaphor/pull/1) | 작동 방식·인프라 구성 소개 페이지 `docs/intro.html` 추가. |
| 2026-09-28 | PoC | main | 없음(초기 커밋) | 확장·공통 저장소·제공자 레지스트리·두 층 저장소·테마 구현. 단위 17개, e2e 6개 통과(가짜 LLM, 대체 임베더). |

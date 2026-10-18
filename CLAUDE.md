# 비유 도우미 (analogy-helper)

웹페이지의 모르는 문장에 커서를 올리면, 사용자의 관심사(기본: 메이플스토리)에 빗대 한 줄로 풀어 주는 크롬 확장(MV3). 관심사를 "개념 노드 + 추상 태그" 그래프로 저장하고, 문장과 구조가 같은 노드를 찾아(그래프 RAG) 그 사실만 근거로 LLM이 비유를 만든다.

- 기획서(살아 있는 문서): https://claude.ai/code/artifact/3706cfb6-01aa-4284-8f81-8393cdad7313
- 할 일 목록: `docs/TASKS.md` ← **작업은 항상 여기서 시작**
- 설계 결정 기록: `docs/decisions/`
- 검색 품질 기록: `docs/EVAL_LOG.md`
- 앱 이름 "좋은비유네용"(2026-10-11 확정, 변경은 T-115)의 밈 배경, 메이플 커뮤니티 용어 분류, 식당 모드 방안: `docs/naming-meme.md`
- 작동 방식·인프라 소개 페이지: `docs/intro.html` (구조가 바뀌면 이 페이지의 구성도도 함께 고친다)
- 다음 아키텍처(LightRAG 서버 + 맥 추출 노드): `docs/architecture-lightrag.md`(원본, Mermaid 그림), `docs/architecture-lightrag.html`(시각화 버전), ADR 0006, 최신화(패치·밈)는 ADR 0007. 설계를 바꾸면 세 곳을 함께 고친다

## 현재 상태 (2026-10-17)

PoC 완료, 실제 키·실제 모델로 확인됨.
- **검색:** 실제 임베딩(e5-small) 혼합 hit@1 11/16으로 대체 임베더(12/16)보다 낮다. 금융 문장이 `meso`·`auction`으로 쏠려 비유가 안 나온다(T-113, 다음 P0).
- **LLM:** 무료 Gemini(`gemini-3.8-flash`)·Groq(`openai/gpt-oss-120b`) 키로 스모크 통과(T-101·T-119). 실제 확장 호버는 3.6~9.1초로 느리다(T-117 뜻 먼저, P0). Groq가 5~10배 빠르지만 존댓말·추상화 품질을 다듬어야 한다(T-122). 503·429는 재시도한다(T-121). 기본은 Groq `gpt-oss-120b` → Gemini `gemini-3.5-flash-lite` → NVIDIA `nemotron-3.5-super-vl` fallback 체인 → 맨 뒤 로컬 Ollama `gemma4:12b`(최종 방어선)(순위는 더 붙을 수 있음, `admin.json` `fallbackChain`에 추가만), 429 모델은 쿨다운(T-124, ADR 0008).
- **데이터:** 공통 그래프 사실은 2026-10 패치 노트로 검수(2026.10.11-1).
- **결정됨:** 앱 이름 "좋은비유네용"(변경은 T-115), 기본 트리거 Alt + 첫 실행 선택(D-1), 두 번째 관심사 식당·로그인 없이(D-4), 문서 출처(D-5), 검수 방식(D-3), 최신화 설계(ADR 0007). D-2(로그인)는 L3 전에 정한다.
- **열린 질문:** "에이전트 단" 설계(D-6, `docs/TASKS.md`), 피드백 저장·공유 범위(D-7).
- **다음 큰 기능:** 말풍선 원클릭 피드백 루프(ADR 0010, 제안). 👎 한 번이면 그 자리에서 다시 비유하고, 교정은 승인 뒤 태그 예문으로 그래프에 들어간다. 순서 D-7 → T-129 → T-106 → T-130·T-131·T-132.
- 테스트는 가짜 LLM 서버와 대체 임베더로 돈다. Node 22 이상.

방향: 검색을 EC2의 LightRAG 서버로 옮기고, 엔티티·관계 추출만 사용자의 M2 Pro 맥(16GB, Ollama)에 Tailscale로 맡긴다(ADR 0006, 제안 상태). 지금 확장의 브라우저 파이프라인은 서버 장애 시 대체 경로로 남는다. 다음 작업 순서는 T-113 → T-117 → T-122 → T-115, 서버 트랙은 L0(T-401~T-405, AWS·도메인 준비 필요). 서버 코드는 `server/`(Python, FastAPI), 인프라 절차는 `infra/`에 둔다(아직 없음).

## 여러 세션이 동시에 작업할 때

- 작업 하나 = 세션 하나 = 브랜치 하나. 같은 파일을 크게 고치는 작업은 동시에 잡지 않는다(예: T-113·T-120은 `retrieval.js`, T-117·T-122는 `providers.js`·`prompt.js`, T-114·T-304는 `graph.js`·공통 그래프 JSON).
- `docs/TASKS.md`는 모든 PR이 고친다. 표의 자기 작업 줄과 작업 로그 맨 위 한 줄만 고치고, 충돌이 나면 양쪽 줄을 모두 살린다.
- 시작 전에 `gh pr list --state open`으로 다른 세션이 이미 잡은 작업(`진행`·`리뷰`)을 확인한다.

## 명령

```bash
npm install                      # 처음 한 번 (esbuild, transformers.js, playwright)
npx playwright install chromium  # e2e용 브라우저, 처음 한 번
npm run build                    # src/offscreen-src.js → extension/offscreen.js + wasm 복사
npm test                         # 단위(node:test) + e2e(Playwright). 커밋 전 항상 통과시킬 것
npm run test:unit                # 순수 함수만, 1초 이내
npm run test:e2e                 # 확장을 실제 크롬에 로드. CHROMIUM_PATH=... 로 브라우저 지정 가능, HEADED=1 로 화면 보기
npm run eval                     # 실제 임베딩 모델로 검색 품질(hit@1/@3). -- -v 로 틀린 문장 출력
npm run eval:fallback            # 모델 없이 같은 평가
npm run smoke:providers          # 실제 키로 제공자 호출 확인(키 있는 제공자만). CI에서는 Actions 탭 → smoke → Run workflow
```

확장 수동 실행: `chrome://extensions` → 개발자 모드 → 압축해제된 확장 로드 → `extension/`. 코드를 고치면 확장 카드의 새로고침 버튼 + 페이지 새로고침.

## 구조

```
extension/                   크롬에 로드되는 폴더. 빌드 결과(offscreen.js, vendor/)도 커밋한다
  background.js              서비스 워커. explain() 파이프라인과 모든 메시지 핸들러
  content.js / content.css   커서 아래 문장 찾기(Intl.Segmenter), CSS Highlight, Shadow DOM 말풍선
  offscreen.html / .js       임베딩 모델 실행 (빌드 산출물, 직접 고치지 말 것 → src/offscreen-src.js)
  options.* / popup.*        설정·팝업 UI
  lib/config.js              설정 우선순위: admin.json < chrome.storage.managed < 사용자 설정(잠금 아닐 때)
  lib/providers.js           LLM 제공자 레지스트리 + 호출 (gemini, openai-compat, anthropic, demo)
  lib/fallback.js            순위 fallback 체인(길이 제한 없음, 순위는 더 붙을 수 있음) + 429 쿨다운 (ADR 0008)
  lib/stores.js              공통 저장소 로더 + 사용자 저장소 어댑터(none / local-dev / remote)
  lib/graph.js               그래프 병합(공통 + 오버레이), 검증, 임베딩 텍스트
  lib/retrieval.js           점수 = 직접 유사도 × w1 + 최고 태그 유사도 × w2 + boost
  lib/prompt.js              프롬프트, 데모 응답, 조사 처리
  lib/fallback-embed.js      모델 없을 때 쓰는 글자 n-gram 임베더
  config/admin.json          배포자 설정 (기본 제공자·모델, 허용 목록, 잠금, 저장소 주소, 가중치)
  data/common/maplestory.json 공통 저장소 그래프 (노드 18, 태그 18, 엣지 12)
src/offscreen-src.js         오프스크린 원본 (transformers.js 번들 입력)
tools/eval.mjs, eval-set.json 검색 품질 평가
tests/unit/                  node:test 단위 테스트 (lib/* 순수 함수)
tests/e2e/                   Playwright: 가짜 LLM(:8765) + 테스트 페이지(:8766) + 확장 사본(.tmp/ext-e2e)
scripts/                     build, prepare-e2e
```

호버 한 번의 흐름: content.js가 문장·단어·앞 문장을 포트(`explain`)로 보냄 → background가 그래프 병합 → 벡터 캐시 확인(없으면 offscreen에서 임베딩) → 문장 임베딩 → `retrieve()` 상위 3개 → LLM 1회(정밀 모드는 2회) → nodeId 검증 → 결과 캐시(session) → 단계별 `stage` 메시지, 스트리밍 중 뜻이 완성되면 `partial`(meaning만), 마지막에 `result`를 포트로 돌려줌.

## 지켜야 할 규칙

1. **근거 밖 비유 금지.** LLM이 고른 `nodeId`가 후보에 없으면 비유를 숨기는 검증(background.js)을 절대 빼지 않는다. 프롬프트의 "근거에 없는 사실을 지어내지 않는다" 규칙도 유지.
2. **공통 그래프 facts에는 자주 바뀌는 수치를 넣지 않는다**(확률표, 최대 강화 단계, 가격). 게임 패치로 틀려진다. 예외는 날짜와 함께 판본별로 통째 교체되는 공식 패치 노트 원문뿐이다(ADR 0007). 노드 추가는 `/add-common-node` 절차를 따른다.
3. **저장소 두 층을 섞지 않는다.** 로그아웃 = 공통만, 로그인 = 공통 + 오버레이. 공통 그래프 파일을 사용자 데이터로 고치지 않는다. 사용자 노드 id는 `u:` 접두어.
4. **원격 코드 금지(MV3·웹스토어 정책).** 스크립트와 wasm은 모두 확장 안에 번들한다. 모델 가중치(데이터)만 원격에서 받는다. CSP는 `script-src 'self' 'wasm-unsafe-eval'`.
5. **UI 문구는 한국어 존댓말(~요), 짧고 구체적으로.** 코드 주석도 한국어.
6. **테마는 관심사에 붙는다.** 메이플 = 인게임 툴팁풍(어두운 남색 + 잠재능력 등급색을 의미별로), 그 외 = 중립 테마. 설정 화면은 중립 + 주황 포인트. 가이드 사이트 UI를 따라 하지 않는다.
7. 새 제공자는 `PROVIDERS`에 항목 추가로 끝나야 한다. 호출 로직을 제공자별로 흩뜨리지 않는다.
   LLM 호출 순서는 `config/admin.json`의 `fallbackChain`(ADR 0008)이고 **순위는 앞으로 계속 더 붙는다**(사용자 안내, 2026-10-18). 코드·테스트·문서·UI 문구에 체인 길이나 "1·2순위"를 가정하지 않는다. 순위 추가는 배열에 항목만 넣고 코드는 고치지 않는다(절차는 ADR 0008 "순위를 더할 때").
8. **호버는 맥에 기대지 않는다.** 맥(로컬 Ollama)의 주 용도는 인덱싱 추출이고 꺼져 있을 수 있다. 호버 LLM은 클라우드 무료 모델 체인이 먼저이고, 로컬 Ollama는 **체인 맨 뒤 최종 방어선**으로만 쓴다(`def.local`, 어떤 설정이든 다른 무료 모델이 무조건 앞, 사용자 결정 2026-10-18, T-127). 꺼져 있으면 건너뛰는 것과 같다.
9. **추상 태그는 통제 어휘다.** 원본은 `maplestory.json`의 `tags`. 추출 프롬프트와 질의 키워드 프롬프트가 같은 목록에서 생성돼야 하고, 목록 밖 추상구조는 버린다.
10. **맥은 인터넷에 포트를 열지 않는다.** Ollama는 127.0.0.1에만, 노출은 `tailscale serve`로 테일넷에만.
11. **커뮤니티 멸칭·실존 인물을 출력하지 않는다.** 쌀숭이·리선족 같은 멸칭과 신창섭(김창섭 디렉터) 같은 실존 인물은 그래프·프롬프트·UI 어디에도 넣지 않는다. 밈은 앱 말투에만 아껴 쓴다(`docs/naming-meme.md`).

## 함정 (한 번씩 밟은 것)

- 서비스 워커에서는 동적 `import()`가 막혀 있다. 그래서 임베딩은 오프스크린 문서에서 돈다. background.js에 `await import(...)`를 쓰지 말 것.
- transformers.js의 `env.useWasmCache`는 꺼 둬야 한다(blob: URL import가 확장 CSP에 막힘). wasm 경로는 `chrome.runtime.getURL('vendor/...')`.
- 확장 페이지는 `eval`이 막혀 있어 Playwright `waitForFunction('문자열')`이 실패한다. `page.evaluate(함수)`나 `expect.poll`을 쓴다.
- 모델 다운로드처럼 긴 작업 중 서비스 워커가 잠들 수 있다. `keepAlive()`로 감싼다.
- 회사망 등에서 Hugging Face가 막히면 모델 로드가 실패하고 대체 임베더로 조용히 바뀐다(`fallbackOnError`). 품질 비교 때 `debug.embedderId`를 꼭 확인.
- 모델 ID·가격은 2026-09-28에 각 사 문서로 확인한 값이다. 바뀌면 `config/admin.json`의 `defaultModels`·`fallbackChain`과 `lib/providers.js`를 함께 고친다.
- **모델을 고르거나 바꿀 때 성능 비교는 [Artificial Analysis 리더보드](https://artificialanalysis.ai/leaderboards/models)를 먼저 참고한다**(지능 지수, 출력 속도, 첫 토큰 지연, 가격). 후보를 거기서 추린 뒤 `npm run smoke:providers`(`--all-models`)로 이 앱 기준(뜻까지 시간, 존댓말, 근거 준수, JSON, 무료 한도)을 직접 잰다. 리더보드 수치는 확인한 날짜와 함께 적는다.
- Gemini 3.x는 `thinkingConfig`를 받지 않는 모델이 있어 400이면 빼고 재시도한다.

## API 키를 두는 곳

| 어디서 | 어디에 | 비고 |
| --- | --- | --- |
| CI (`smoke` 워크플로) | 저장소 Actions 비밀값 `GEMINI_API_KEY`, `GROQ_API_KEY`, `NVIDIA_API_KEY` | 수동 실행 전용. 넣기: 별도 터미널에서 `gh secret set <이름>` |
| 이 맥의 스크립트 | `~/.zshrc`의 `export ..._API_KEY=` | 별도 터미널에서 편집기로 넣는다 |
| 확장 | 설정 화면 → 제공자 → API 키 | 그 크롬 프로필에만 저장 |
| 서버 (L0 이후) | AWS SSM Parameter Store (T-401) | |

- 키 값을 대화·커밋·이슈·로그에 남기지 않는다. 대화의 `!` 명령으로 키를 넣지 말 것(기록에 남는다). 키 존재 여부는 값 없이 "있음/없음"만 확인한다.
- **저장소는 공개다.** 결제가 연결된 유료 키(OpenAI, Anthropic, AWS)는 암호화하더라도 저장소에 넣지 않는다.
- `extension/offscreen.js`의 `"Mistral3ForConditionalGeneration"`을 GitHub 비밀 탐지가 Mistral 키로 오인한 적이 있다(오탐으로 허용함). 같은 경고가 다시 뜨면 위치부터 확인한다.

## 원격 저장소 처음 연결 (한 번만)

```bash
git remote add origin <원격 주소>
git push -u origin main dev        # dev는 main과 같은 커밋에서 시작
gh auth login                      # GitHub. GitLab이면 glab auth login
```
GitHub이라면 `dev`를 기본 PR 대상으로 두고, `main`·`dev`에 브랜치 보호(직접 push 금지, `test` 체크 필수)를 걸어 둔다. CI는 `.github/workflows/ci.yml`.

## 작업 방식 (브랜치 → push → dev로 PR)

작업 하나 = 브랜치 하나 = PR 하나. `main`과 `dev`에는 직접 커밋·push하지 않는다.

```
origin/dev ──┬── task/T-101-provider-smoke ── PR → dev
             └── task/T-102-embedding-load ── PR → dev
(dev → main 병합은 사람이 한다)
```

1. **시작** (`/next-task`가 전부 대신한다) `git fetch origin` → `git switch -c task/<ID>-<영문-슬러그> origin/dev`. 작업 트리가 깨끗하지 않으면 멈추고 묻는다.
2. **고르기** `docs/TASKS.md`에서 상태가 `대기`이고 "먼저 끝나야 할 것"이 모두 `완료`(= dev에 병합됨)인 작업 중 가장 위의 것(`/next-task`). `결정 필요` 항목은 사용자에게 먼저 묻는다. 의존 작업이 `리뷰`(PR 열림, 미병합)면 그 위에 쌓지 말고 다른 작업을 고른다.
3. **구현** 완료 기준을 다시 읽고, 필요하면 테스트부터. 테스트 계획을 먼저 확인받고 싶으면 `/test-first <ID>`(계획 → 승인 → 실패하는 테스트부터, superpowers 스킬 사용). 순수 로직은 `tests/unit`, 확장 동작은 `tests/e2e`. 커밋은 작게 여러 번 해도 된다: `feat(T-105): ...`, `fix(T-105): ...`, `test(T-105): ...`, `docs(T-105): ...`.
4. **확인** `npm test` 통과. 검색·생성 품질에 영향을 주면 `npm run eval` 결과를 `docs/EVAL_LOG.md`에 한 줄. 설계를 바꾸면 `docs/decisions/`에 ADR.
5. **기록** `docs/TASKS.md`: 상태를 `리뷰`로, 작업 로그에 한 줄. 새로 발견한 문제는 새 T-번호로 추가.
6. **올리기** `git push -u origin <브랜치>` → `gh pr create --base dev --head <브랜치> --title "<ID> <작업 제목>" --body-file <본문>`(본문은 `.github/pull_request_template.md` 형식). 그다음 작업 로그의 PR 칸에 링크를 넣어 한 번 더 커밋·push. `gh`가 없으면 GitLab은 `glab mr create --target-branch dev`, 둘 다 없으면 브라우저에서 열 PR 주소를 알려 준다.
7. **병합 후** 다음 작업을 시작할 때, dev에 병합된 PR의 작업은 새 브랜치의 첫 커밋에서 `완료`로 바꾼다(`chore: 병합된 작업 상태 갱신`). 병합 여부는 `gh pr list --base dev --state merged`로 확인.

금지: `main`·`dev`로 push, `--force` push(`origin/dev`로 리베이스한 자기 작업 브랜치에만 `--force-with-lease` 허용), 남의 브랜치 수정, 테스트가 실패한 상태로 PR 열기(열어야 하면 Draft로 열고 본문에 실패 내용을 적는다).

# 비유 도우미 (analogy-helper)

웹페이지의 모르는 문장에 커서를 올리면, 사용자의 관심사(기본: 메이플스토리)에 빗대 한 줄로 풀어 주는 크롬 확장(MV3). 관심사를 "개념 노드 + 추상 태그" 그래프로 저장하고, 문장과 구조가 같은 노드를 찾아(그래프 RAG) 그 사실만 근거로 LLM이 비유를 만든다.

- 기획서(살아 있는 문서): https://claude.ai/code/artifact/3706cfb6-01aa-4284-8f81-8393cdad7313
- 할 일 목록: `docs/TASKS.md` ← **작업은 항상 여기서 시작**
- 설계 결정 기록: `docs/decisions/`
- 검색 품질 기록: `docs/EVAL_LOG.md`

## 현재 상태 (2026-09-28)

PoC 완료. 전체 흐름은 e2e로 검증했지만 **실제 LLM 키와 실제 임베딩 모델로는 아직 한 번도 돌려 보지 않았다**(작성 환경에서 Hugging Face와 LLM API가 막혀 있었음). 테스트는 가짜 LLM 서버와 글자 n-gram 대체 임베더로 돈다. 다음 단계는 Phase 1(품질 검증)이다.

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

호버 한 번의 흐름: content.js가 문장·단어·앞 문장을 포트(`explain`)로 보냄 → background가 그래프 병합 → 벡터 캐시 확인(없으면 offscreen에서 임베딩) → 문장 임베딩 → `retrieve()` 상위 3개 → LLM 1회(정밀 모드는 2회) → nodeId 검증 → 결과 캐시(session) → 단계별 `stage` 메시지와 `result`를 포트로 돌려줌.

## 지켜야 할 규칙

1. **근거 밖 비유 금지.** LLM이 고른 `nodeId`가 후보에 없으면 비유를 숨기는 검증(background.js)을 절대 빼지 않는다. 프롬프트의 "근거에 없는 사실을 지어내지 않는다" 규칙도 유지.
2. **공통 그래프 facts에는 자주 바뀌는 수치를 넣지 않는다**(확률표, 최대 강화 단계, 가격). 게임 패치로 틀려진다. 노드 추가는 `/add-common-node` 절차를 따른다.
3. **저장소 두 층을 섞지 않는다.** 로그아웃 = 공통만, 로그인 = 공통 + 오버레이. 공통 그래프 파일을 사용자 데이터로 고치지 않는다. 사용자 노드 id는 `u:` 접두어.
4. **원격 코드 금지(MV3·웹스토어 정책).** 스크립트와 wasm은 모두 확장 안에 번들한다. 모델 가중치(데이터)만 원격에서 받는다. CSP는 `script-src 'self' 'wasm-unsafe-eval'`.
5. **UI 문구는 한국어 존댓말(~요), 짧고 구체적으로.** 코드 주석도 한국어.
6. **테마는 관심사에 붙는다.** 메이플 = 인게임 툴팁풍(어두운 남색 + 잠재능력 등급색을 의미별로), 그 외 = 중립 테마. 설정 화면은 중립 + 주황 포인트. 가이드 사이트 UI를 따라 하지 않는다.
7. 새 제공자는 `PROVIDERS`에 항목 추가로 끝나야 한다. 호출 로직을 제공자별로 흩뜨리지 않는다.

## 함정 (한 번씩 밟은 것)

- 서비스 워커에서는 동적 `import()`가 막혀 있다. 그래서 임베딩은 오프스크린 문서에서 돈다. background.js에 `await import(...)`를 쓰지 말 것.
- transformers.js의 `env.useWasmCache`는 꺼 둬야 한다(blob: URL import가 확장 CSP에 막힘). wasm 경로는 `chrome.runtime.getURL('vendor/...')`.
- 확장 페이지는 `eval`이 막혀 있어 Playwright `waitForFunction('문자열')`이 실패한다. `page.evaluate(함수)`나 `expect.poll`을 쓴다.
- 모델 다운로드처럼 긴 작업 중 서비스 워커가 잠들 수 있다. `keepAlive()`로 감싼다.
- 회사망 등에서 Hugging Face가 막히면 모델 로드가 실패하고 대체 임베더로 조용히 바뀐다(`fallbackOnError`). 품질 비교 때 `debug.embedderId`를 꼭 확인.
- 모델 ID·가격은 2026-09-28에 각 사 문서로 확인한 값이다. 바뀌면 `config/admin.json`의 `defaultModels`와 `lib/providers.js`를 함께 고친다.
- Gemini 3.x는 `thinkingConfig`를 받지 않는 모델이 있어 400이면 빼고 재시도한다.

## 작업 방식

1. `docs/TASKS.md`에서 상태가 `대기`이고 의존 작업이 끝난 것 중 가장 위의 것을 고른다(`/next-task`). `결정 필요` 항목은 사용자에게 먼저 묻는다.
2. 구현 전에 완료 기준을 다시 읽고, 필요하면 테스트부터 쓴다. 순수 로직은 `tests/unit`, 확장 동작은 `tests/e2e`.
3. `npm test` 통과 → `docs/TASKS.md`의 상태와 작업 로그 갱신 → 커밋. 커밋 메시지는 `feat(T-105): 공통 그래프 벡터 사전 계산`처럼 작업 ID를 붙인다.
4. 설계를 바꾸는 결정은 `docs/decisions/`에 ADR로 남긴다(번호 이어서).
5. 검색·생성 품질에 영향을 주는 변경은 `npm run eval` 결과를 `docs/EVAL_LOG.md`에 한 줄 추가한다.

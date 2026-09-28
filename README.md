# 비유 도우미 (PoC)

웹페이지에서 모르는 문장에 커서를 올리면, 내 관심사(기본: 메이플스토리)에 빗대 한 줄로 풀어 주는 크롬 확장입니다.

## 바로 써 보기

1. 크롬 주소창에 `chrome://extensions` → 오른쪽 위 **개발자 모드** 켜기
2. **압축해제된 확장 프로그램 로드** → 이 폴더의 `extension/` 선택
3. 설정 화면이 열리면 AI 제공자를 고르고 키를 넣기
   - 무료: **Google Gemini** (https://aistudio.google.com/apikey) 또는 **Groq** (https://console.groq.com/keys)
   - 키 없이 구조만 보려면 **데모** 제공자
4. 설정 화면 **검색 모델 → 지금 준비하기** (처음 한 번 약 120MB)
5. 아무 페이지에서 **Alt(맥은 Option)를 누른 채** 문장에 커서를 올리기

로그인하지 않아도 공통 저장소(메이플스토리 그래프)로 바로 동작합니다. 내 노드 추가·관심사 변경은 설정의 **내 저장소**에서 로그인 후 할 수 있습니다(PoC는 서버 없는 개발용 로그인).

## 폴더 구조

```
extension/                 ← 크롬에 로드하는 폴더 (빌드 결과 포함)
  manifest.json
  background.js            서비스 워커: 저장소 병합 → 임베딩 → 그래프 검색 → LLM
  content.js / content.css 커서 아래 문장 찾기, 강조, 말풍선
  offscreen.html/.js       브라우저 안 임베딩 모델 (src/offscreen-src.js 빌드 결과)
  options.* / popup.*      설정·팝업 화면
  config/admin.json        관리자(배포자) 설정: 기본 제공자, 허용 목록, 잠금, 저장소 주소
  managed_schema.json      크롬 엔터프라이즈 정책으로 admin 값을 덮어쓸 때의 스키마
  data/common/maplestory.json  공통 저장소 샘플 그래프
  lib/                     providers, stores, graph, retrieval, prompt, config
  vendor/                  onnxruntime-web wasm
src/offscreen-src.js       오프스크린 원본 (transformers.js 번들 대상)
tools/eval.mjs             검색 품질 평가 (hit@1, hit@3, 가중치별 비교)
tools/eval-set.json        평가 문장 16개
tests/                     단위(node:test) · e2e(Playwright)
docs/                      TASKS.md(할 일) · decisions/(설계 결정) · EVAL_LOG.md
CLAUDE.md                  Claude Code용 프로젝트 안내
```

## 관리자가 LLM 바꾸기

`extension/config/admin.json`을 고치거나, 조직 정책(`chrome.storage.managed`)으로 같은 키를 내려보냅니다. 정책 값이 파일보다 우선합니다.

| 키 | 뜻 |
| --- | --- |
| `defaultProvider` | `gemini`, `groq`, `openai`, `anthropic`, `custom`, `demo` |
| `defaultModels` | 제공자별 기본 모델 |
| `allowedProviders` | 사용자가 고를 수 있는 목록 |
| `lockProvider` | `true`면 사용자가 제공자·모델을 못 바꿈 |
| `sharedApiKeys` | 조직 공용 키 (확장 안에 들어가므로 외부 배포용으로는 쓰지 말 것) |
| `customBaseUrl` | OpenAI 호환 주소 (OpenRouter, Ollama 등) |
| `commonStore.url` | 공통 저장소 그래프 URL. 비우면 번들 파일 |
| `userStore.adapter` | `none`, `local-dev`, `remote` |
| `userStore.baseUrl` | `remote` 어댑터 서버 주소 |

새 제공자는 `extension/lib/providers.js`의 `PROVIDERS`에 항목을 하나 추가하면 됩니다. OpenAI 호환 API라면 `kind: 'openai-compat'`와 `baseUrl`만 있으면 됩니다.

## 개발

```bash
npm install                      # 처음 한 번
npx playwright install chromium  # e2e용 브라우저
npm run build                    # src/offscreen-src.js → extension/offscreen.js, wasm 복사
npm test                         # 단위 + e2e (가짜 LLM, 대체 임베더로 네트워크 없이)
npm run eval                     # 실제 임베딩 모델로 검색 품질 평가 (-- -v 로 틀린 문장 보기)
npm run eval:fallback            # 모델 없이 같은 평가
```

이어서 작업하려면 `CLAUDE.md`(프로젝트 맥락·규칙)와 `docs/TASKS.md`(할 일)를 먼저 보세요. Claude Code에서는 `/next-task`로 다음 작업을 이어 갈 수 있습니다.

# 웹스토어 공개 준비 (T-303)

크롬 웹스토어에 올릴 때 필요한 문서·빌드·스크린샷이에요. 개발자 계정 등록, 결제, 업로드, 심사 제출은 사람이 해요.

## 파일

| 파일 | 내용 |
| --- | --- |
| `permissions.md` | 단일 목적 설명 + manifest 권한마다 사용 이유. 대시보드 "개인정보 보호 관행" 탭에 붙여 넣어요 |
| `privacy-policy.md` | 개인정보 처리방침(한국어 본문 + 영어 요약). `[시행일]`·`[연락처]`는 사람이 채워요 |
| `screenshots/*.png` | 스토어 스크린샷 1280×800 5장 |
| `../../scripts/build-store.mjs` | 스토어 빌드(`npm run build:store`) |
| `../../scripts/store-transform.mjs` | 빌드 변환 순수 함수(단위 테스트 `tests/unit/store-transform.test.mjs`) |
| `../../scripts/store-screenshots.mjs` | 스크린샷 다시 만들기(`npm run store:screenshots`) |
| `../../tests/e2e/store-build.spec.mjs` | 스토어 빌드를 크롬에 올려 확인하는 e2e |

## 스토어 빌드

```bash
npm run build          # offscreen.js·vendor wasm (커밋돼 있으면 생략 가능)
npm run build:store    # → dist/store/ + dist/good-metaphor-<판>.zip
npx playwright test tests/e2e/store-build.spec.mjs   # 빌드 확인(서비스 워커·데모 없음·로그인 꺼짐)
```

`extension/`은 그대로 두고 `dist/store/` 사본만 바꿔요.

- `config/admin.json`: `userStore.adapter` `local-dev` → `none`(개발용 로그인 숨김), `allowedProviders`·`fallbackChain`에서 `demo` 제거, `defaultProvider`가 `demo`면 체인 첫 실제 제공자로
- `manifest.json`: 이름 `좋은비유네용 (PoC)` → `좋은비유네용`. 로그인이 꺼져 있으면(`none`) 쓰이지 않는 `identity` 권한을 빼요. 다른 권한은 그대로
- `admin.json`에 서버 주소(`analogyServer.url`, `commonStore.url`, `userStore.baseUrl`)가 있으면 빌드가 멈춰요. 처리방침이 "제작자 서버로 보내는 정보 없음"이라서예요
- git에 추적되는 `extension/` 파일만 복사해요(`git ls-files extension`). 추적 안 되는 로컬 파일은 들어가지 않아요
- e2e 전용 파일(`e2e-hook.js`, `ort-smoke.*`, `add.onnx`), 소스맵, 테스트 파일이 있으면 빌드가 실패해요
- zip은 시스템 `zip` 명령으로 만들어요(맥·우분투 기본). `dist/`는 커밋하지 않아요

## 스크린샷

```bash
npm run store:screenshots   # prepare-e2e 사본 + 스토어 변환 + 가짜 LLM, 네트워크 없음
```

| 파일 | 장면 |
| --- | --- |
| `1-maple-bubble.png` | 예시 기사에서 Alt+호버 → 메이플 말풍선(쉬운 뜻·비유·근거 칩) |
| `2-restaurant-bubble.png` | 관심사를 식당으로 바꾼 말풍선(중립 테마) |
| `3-popup.png` | 툴바 팝업(관심사 선택, 이 사이트에서 끄기) + 설명 한 줄 |
| `4-options.png` | 설정 화면 "사용 방식"·"제외 사이트" |
| `5-feedback-chips.png` | 👎 뒤 다시 비유 + "더 맞는 개념"·이유 칩 |

- 문장은 테스트 페이지(`tests/e2e/page.html`) 문장만 써요. 실제 사이트·실존 인물·멸칭은 없어요(규칙 11).
- 비유와 근거는 가짜 LLM이 공통 그래프 후보로 만든 것이고, 뜻 풀이만 스크립트 안 문구로 바꿔 끼워요.
- 말풍선 아래 제공자 표시는 가짜 LLM(`custom/mock-model`) 대신 팝업과 같은 스토어 기본 제공자 `groq/openai/gpt-oss-120b`로 화면 글자만 바꿔 찍어요. 팝업은 Groq를 고르고 키를 넣은 상태로 찍어요(키는 자리표시 값).
- 호버할 문장은 기사 맨 아래 문단에 혼자 두어 말풍선이 본문을 가리지 않게 해요.
- 이 맥처럼 화면이 잠든 환경에서는 크롬 실행이 멈춰 시간 초과가 날 수 있어요. 다시 돌리면 대개 10초 안에 끝나요.

## 사람이 할 일

1. **개발자 계정 등록:** https://chrome.google.com/webstore/devconsole 에서 등록비(1회 5달러)를 내고 계정을 만들어요. 2단계 인증이 필요해요.
2. **제출 전 결정**
   - **서버 모드(analogy-api, T-404)·원격 공통 저장소·서버 계정 로그인을 켜서 배포하기 전에** 개인정보 처리방침 §1(보내는 정보와 받는 곳)과 §6(하지 않는 것: "제작자 서버로 보내는 정보 없음")을 먼저 고쳐야 해요. 그 전에는 스토어 빌드가 서버 주소를 막아요.
   - NVIDIA Build 무료 키는 개발·시험용 약관이에요(`docs/TASKS.md` 작업 로그 2026-10-18, "T-303 전에 확인"). 공개 배포에서 체인에 둘지 약관을 확인해요.
   - 확장 이름 표기(스토어 표시 이름 "좋은비유네용")와 판 번호(`manifest.json` `version`).
3. **처리방침 공개 URL:** `privacy-policy.md`의 `[시행일]`·`[연락처]`를 채워 dev → main에 병합한 뒤, 저장소 파일 링크(예: `https://github.com/roasted-penguin/good-metaphor/blob/main/docs/store/privacy-policy.md`)를 대시보드 "개인정보처리방침 URL"에 넣어요. 저장소가 공개라 로그인 없이 열려요.
4. **스토어 등록 정보**(초안)
   - 요약(132자 이내): `모르는 문장에 Alt를 누른 채 커서를 올리면, 메이플스토리나 식당에 빗대 한 줄로 쉽게 풀어 드려요.`
   - 설명:
     ```
     어려운 기사나 문서를 읽다가 모르는 문장이 나오면 Alt(맥: Option)를 누른 채 커서를 올려 보세요.
     좋은비유네용이 쉬운 뜻과 함께, 내가 고른 관심사(메이플스토리 또는 식당)에 빗댄 비유를 한 줄로 보여 드려요.

     · 비유는 관심사 그래프에 있는 사실만 근거로 만들어요. 근거가 없으면 억지로 만들지 않아요.
     · 말풍선에서 👎를 누르면 그 자리에서 다른 개념으로 다시 비유해요.
     · AI는 Groq·Google Gemini·NVIDIA 무료 키나 OpenAI·Anthropic 키, 내 컴퓨터의 Ollama 중에서 골라요. 키는 이 브라우저에만 저장돼요.
     · 메일·은행·로그인 페이지와 비밀번호 폼에서는 문장을 읽지 않아요. 사이트별로 끌 수도 있어요.
     ```
   - 카테고리: 생산성(또는 교육). 언어: 한국어.
   - 아이콘: `extension/icons/128.png`. 스크린샷: `screenshots/` 5장.
5. **업로드:** `npm run build:store` → `dist/good-metaphor-<판>.zip`을 대시보드 "새 항목"에 올려요.
6. **개인정보 보호 관행 탭:** 단일 목적·권한 사유는 `permissions.md`에서 붙여 넣어요. 원격 코드 사용 "아니요". 데이터 사용: "웹사이트 콘텐츠"(사용자가 고른 문장을 AI 제공자로 보냄)에 체크하고, 판매·무관한 용도·신용 평가에 쓰지 않는다는 세 항목에 동의해요.
7. **심사 제출:** 공개 범위(공개/미등록)를 고르고 제출해요. `<all_urls>` 콘텐츠 스크립트 때문에 심사가 길어질 수 있어요.

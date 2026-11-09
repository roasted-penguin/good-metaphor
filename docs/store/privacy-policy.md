# 좋은비유네용 개인정보 처리방침

시행일: [시행일]
연락처: [연락처]

좋은비유네용(이하 "확장")은 웹페이지의 문장을 사용자의 관심사에 빗대 풀어 주는 크롬 확장이에요. 이 문서는 확장이 어떤 정보를 어디로 보내고 무엇을 기기에 저장하는지 설명해요. 확장을 만든 사람은 자체 서버를 운영하지 않으며, 사용자 정보를 받아 보거나 저장하지 않아요.

## 1. 보내는 정보와 받는 곳

사용자가 보조키(기본 Alt)를 누른 채 문장에 커서를 올리면(설정에서 "머무르면 자동"을 고른 경우에는 커서가 정해진 시간 머물면) 아래 정보가 AI 제공자로 전송돼요.

- 커서 아래 문장 하나
- 그 앞 문장(최대 300자)
- 커서 아래 낱말
- 페이지 제목(최대 120자)
- 확장 안에 번들된 관심사 그래프에서 고른 개념 3개의 이름과 사실(사용자 정보 아님)

설정에서 "정밀 모드"를 켜면 호버 한 번에 제공자를 두 번 불러요. 첫 번째 호출에는 문장, 커서 아래 낱말, 페이지 제목만 보내 추상 구조를 받고, 두 번째 호출은 위와 같아요.

설정 화면의 "시험해 보기"에 사용자가 직접 입력한 문장도 같은 방식으로 전송돼요. 페이지 주소(URL), 페이지 전체 내용, 쿠키, 방문 기록은 보내지 않아요.

**받는 곳:** 사용자가 설정에서 고른 AI 제공자, 또는 고르지 않았으면 관리자 기본 제공자예요. 그 제공자가 요청 한도·서버 오류로 실패하면 미리 정한 다음 순위 제공자로 넘어가요. API 키가 없는 제공자는 부르지 않아요. 예외는 키가 필요 없는 로컬 Ollama(이 컴퓨터 안)와 사용자가 직접 넣은 OpenAI 호환 주소예요. 요청에는 사용자가 넣은 그 제공자의 API 키가 함께 가요.

| 제공자 | 처리방침 |
| --- | --- |
| Groq | https://groq.com/privacy-policy |
| Google Gemini API | https://policies.google.com/privacy , 추가 약관 https://ai.google.dev/gemini-api/terms |
| NVIDIA Build | https://www.nvidia.com/en-us/about-nvidia/privacy-policy/ |
| OpenAI | https://openai.com/policies/row-privacy-policy/ |
| Anthropic | https://www.anthropic.com/legal/privacy |
| OpenAI 호환 주소(사용자 지정) | 사용자가 직접 넣은 주소의 운영자 처리방침을 따라요. 확장은 그 주소의 출처에 대한 접근 권한을 사용자에게 먼저 물어봐요. |
| 로컬 Ollama | 사용자 컴퓨터(127.0.0.1) 안에서만 처리돼 기기 밖으로 나가지 않아요. |

제공자로 간 정보는 각 제공자의 처리방침과 약관에 따라 처리돼요. 특히 Google Gemini 무료 티어는 입력 내용이 Google 제품 개선에 쓰이고 사람이 검토할 수 있다고 Gemini API 추가 약관에 적혀 있어요(설정 화면에도 안내해요).

## 2. 보내지 않는 경우

- 보조키를 누르기 전(자동 모드가 아닐 때)에는 아무것도 읽어 보내지 않아요.
- 제외 사이트에서는 확장이 꺼져요. 메일(Gmail, 네이버·다음 메일, Outlook), 계정 로그인 페이지(Google, 네이버, 카카오, Microsoft), 은행(KB국민, 신한, 우리, 하나, NH농협, IBK기업, 카카오뱅크, 토스)이 기본으로 들어 있고, 사용자가 팝업의 "이 사이트에서 끄기"나 설정 화면에서 더하고 뺄 수 있어요. 제외 사이트 안에 들어간 다른 사이트의 iframe도 꺼져요.
- 비밀번호 입력칸이 있는 폼 안의 문장, 입력칸·편집 영역·코드 블록의 글자는 읽지 않아요.
- 팝업에서 확장을 끄면 어떤 페이지에서도 반응하지 않아요.

## 3. 임베딩 모델 다운로드

문장과 비슷한 개념을 찾는 검색 모델(`Xenova/multilingual-e5-base`)의 가중치 파일을 처음 한 번 Hugging Face(huggingface.co)에서 내려받아요. 이때 사용자 문장은 보내지 않고 모델 파일만 받아요. 검색(임베딩)은 브라우저 안에서 돌아요. Hugging Face 처리방침: https://huggingface.co/privacy

## 4. 기기에 저장하는 정보

모두 사용자 크롬 프로필 안의 이 확장 저장 공간(`chrome.storage`와, 검색 모델 파일은 브라우저 캐시 저장소)에만 있고, 확장을 지우면 함께 지워져요.

| 무엇 | 어디 | 지우는 방법 |
| --- | --- | --- |
| 설정(관심사, 띄우는 방법, 제외 사이트, 고른 제공자·모델, **API 키**) | `chrome.storage.local` | 설정 화면에서 바꾸거나 확장 삭제 |
| 말풍선 피드백 기록(👍/👎, 고른 개념, 이유, 그 문장 원문과 문장 벡터), 최대 500건, 넘으면 오래된 것부터 지워짐 | `chrome.storage.local` | 설정 화면 "내 피드백"에서 한 건씩 되돌리기 또는 "전부 지우기" |
| 날짜별 사용 횟수(피드백 통계용, 숫자만) | `chrome.storage.local` | 확장 삭제 |
| 관심사 그래프 벡터 캐시(번들 그래프에서 계산한 숫자, 최대 2,000개) | `chrome.storage.local` | 설정 화면 "검색 모델"의 "캐시 비우기" |
| 최근 결과 캐시(최대 200개), AI 요청 한도 대기 시간 | `chrome.storage.session`(브라우저를 닫으면 사라짐) | 브라우저 종료, 결과 캐시는 "캐시 비우기"로도 |
| 첫 실행 안내를 마쳤는지 | `chrome.storage.local` | 확장 삭제 |
| 검색 모델 파일 | 브라우저 캐시 저장소 | 확장 삭제 |

API 키는 이 크롬 프로필에만 저장되고, 그 제공자를 부를 때만 그 제공자에게 보내요.

설정 화면 "내 피드백"의 "JSON으로 내보내기"·"운영자용 교정 내보내기"는 사용자가 누를 때만 사용자 컴퓨터에 파일로 저장돼요. 어디로도 전송되지 않아요.

## 5. 피드백 보내기 동의

첫 실행 화면("보내기" / "내 기기에만")과 설정 화면 "내 피드백"("공통 그래프 개선에 보내기")에서 피드백을 보낼지 고를 수 있어요. 동의하면 앞으로 메일 주소·전화번호·긴 숫자·웹 주소를 가린 문장 일부, 고른 개념, 👍/👎를 서비스 개선용 서버로 보낼 예정이에요. **지금은 그 서버가 없어서 동의 여부만 저장하고, 피드백은 이 기기에만 쌓여요. 아무것도 전송하지 않아요.** 서버가 생기면 이 처리방침을 먼저 고쳐 알린 뒤 보내기 시작해요.

동의는 설정 화면 "내 피드백"의 "공통 그래프 개선에 보내기" 체크를 끄면 언제든 철회돼요. 기기에 쌓인 피드백은 같은 화면의 "전부 지우기"로 모두 지울 수 있어요.

## 6. 하지 않는 것

- 분석 도구, 광고, 추적 코드가 없어요.
- 정보를 팔거나 광고에 쓰지 않아요.
- 확장 제작자가 운영하는 서버로 보내는 정보가 없어요(로그인 기능은 이 판에서 꺼져 있어요).
- 원격 코드를 내려받아 실행하지 않아요.

## 7. 아동

이 확장은 만 14세 미만 아동을 대상으로 하지 않으며, 아동의 정보를 알면서 수집하지 않아요.

## 8. 바뀌는 경우

처리방침이 바뀌면 이 문서의 시행일을 고치고 확장 스토어 페이지에 알려요.

---

## English summary

Good Metaphor ("좋은비유네용") explains a sentence on a web page with an analogy from the user's chosen interest.

- **What is sent:** Only when the user holds the modifier key (Alt by default) over a sentence (or, if the user opts into auto mode, rests the cursor on it), the extension sends that sentence, the previous sentence (up to 300 characters), the word under the cursor, and the page title (up to 120 characters) to the AI provider the user selected (or the administrator default), plus facts from the bundled interest graph. If that provider fails, the next provider in the configured order is tried; providers without an API key are skipped, except the local Ollama and a user-entered OpenAI-compatible URL, which need no key. In precise mode (opt-in) each hover makes two provider calls; the first sends only the sentence, the word and the page title. Providers: Groq, Google Gemini, NVIDIA, OpenAI, Anthropic, a user-entered OpenAI-compatible URL, or a local Ollama on the user's own computer. Page URLs, full page content, cookies and history are not sent.
- **What is not sent:** nothing before the modifier key is pressed; nothing on excluded sites (mail, account login and banking sites by default, editable by the user); nothing from forms with a password field, input fields or code blocks.
- **Model download:** the embedding model weights are downloaded once from Hugging Face. No user text is sent there. Search runs inside the browser.
- **Stored on the device only** (`chrome.storage`, plus the model files in the browser cache storage): settings including API keys, up to 500 feedback records (with the original sentence), daily usage counts, a vector cache, and a session-only result cache. Feedback can be cleared from Settings → "내 피드백" → "전부 지우기".
- **Feedback sharing consent:** the user can opt in, but there is no server yet, so nothing is transmitted; only the choice is stored. It can be withdrawn at any time in Settings.
- **No** analytics, ads, tracking, data sale, developer-operated servers, or remote code.
- Contact: [연락처]

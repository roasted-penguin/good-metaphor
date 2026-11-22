# 0005 LLM 제공자는 레지스트리 + 관리자 설정으로 교체한다

- 상태: 채택 (2026-09-28)

## 결정
- `lib/providers.js`의 `PROVIDERS`가 유일한 목록. 호출 방식은 `kind` 네 가지(gemini, openai-compat, anthropic, demo)로 묶는다.
- 기본값은 무료 티어가 있고 품질이 높은 Google Gemini. 무료 대안 Groq, 유료 OpenAI·Anthropic, OpenAI 호환 주소(OpenRouter, Ollama), 키 없는 데모.
- 우선순위: `config/admin.json` < `chrome.storage.managed`(조직 정책) < 사용자 설정. `lockProvider`면 사용자 설정 무시.
- 모델 후보는 [Artificial Analysis 리더보드](https://artificialanalysis.ai/leaderboards/models)를 먼저 참고해 추리고, 스모크로 이 앱 기준을 잰 뒤 정한다(2026-10-18 추가). 처음 고른 Gemini·Groq 모델은 비교 없이 "무료 티어 + 대표 모델"로 정한 것이다.
- 키는 사용자 브라우저(`chrome.storage.local`)에만. 조직 공용 키(`sharedApiKeys`)는 내부 배포용이고, 외부 배포는 프록시(T-204).

# 0008 LLM 호출은 순위 fallback 체인 + 429 쿨다운으로 한다

- 상태: 채택 (2026-10-18, 사용자 요청, T-124)

## 배경
무료 티어 한도(Gemini 일일 할당량, Groq 출력 토큰 분당 한도)에 걸리면 429가 나고, 제공자 하나만 쓰면 그대로 호버가 실패한다. 2026-10-18 측정(T-122 사전 측정, Artificial Analysis 리더보드)에서 무료로 쓸 수 있는 모델 중 Groq `openai/gpt-oss-120b`가 가장 빨랐고(뜻까지 0.5~0.6초), Gemini `gemini-3.8-flash`가 느리지만(1.8~6초) 근거가 없으면 비유를 비우는 보수적 응답을 했다.

## 결정
- 체인 길이는 정해 두지 않는다. 처음 판(2026-10-18)은 Groq `openai/gpt-oss-120b`(1순위) → Gemini `gemini-3.8-flash`(2순위)였다. 같은 날 재측정에서 3.8 Flash가 느리고(thinking, 스트리밍 이득 없음) `gemini-3.5-flash-lite`가 첫 글자 1초 안팎이라 사용자 결정으로 **Groq → Gemini 3.5 Flash-Lite → NVIDIA Build `nvidia/nemotron-3.5-super-vl-120b-a12b`**로 바꿨다. 순위는 앞으로 더 붙을 수 있다. `config/admin.json`의 `fallbackChain` 배열 순서가 곧 순위다.
- 호출 순서 = 사용자가 고른 제공자·모델 → `fallbackChain`. 중복, 키 없음, 허용 안 됨은 건너뛴다. 데모는 체인을 타지 않는다.
- 429·503·네트워크·시간 초과면 다음 순서로. 키 오류(400·401·403)는 사용자가 고쳐야 하므로 넘기지 않고 보여 준다.
- 429를 받은 모델은 `Retry-After`(없으면 `cooldown.defaultMs` 60초, 상한 `maxMs` 10분) 동안 쿨다운한다. 기록은 `chrome.storage.session`. 쿨다운 중이면 부르지 않고 바로 다음으로 간다. 모두 쿨다운이면 가장 먼저 풀리는 것을 부른다.
- 다음 순서가 있으면 429에 같은 모델 재시도(T-121)를 하지 않는다. 마지막 순서에서는 기존 재시도를 그대로 한다.
- 호출 로직은 `lib/fallback.js` 한 곳. 제공자별 분기를 늘리지 않는다(규칙 7).

- **로컬 Ollama는 최종 방어선**(사용자 결정 2026-10-18, T-127): `PROVIDERS.ollama`(`http://127.0.0.1:11434/v1`, `local: true`, 키 없음). `buildChain`이 `local` 제공자를 사용자가 골랐든 체인 중간에 있든 맨 뒤로 보낸다. 다른 무료 모델이 무조건 먼저다. 꺼져 있으면 네트워크 오류로 끝나고, 앞 순위가 모두 실패했을 때만 그 오류가 보인다.
- Ollama가 확장 요청을 받으려면 `OLLAMA_ORIGINS=chrome-extension://*`가 필요하다. 포트는 127.0.0.1에만 연다(규칙 10).

## 결과
- NVIDIA Nemotron은 기본으로 생각부터 해서 첫 글자까지 14~30초다. `PROVIDERS.nvidia.extraBody`의 `chat_template_kwargs.enable_thinking: false`로 꺼서 0.3초 안팎으로 만든다.
- NVIDIA Build 무료 API는 키당 분당 약 40회(전 모델 공유)이고 개발·시험용 약관이다. 웹스토어 공개(T-303) 전에 약관을 다시 확인한다.
- `debug.provider`는 실제로 답한 모델, `debug.fallbacks`에 건너뛴 모델과 이유가 남는다.
- 결과 캐시 키는 사용자가 고른 제공자 기준이라, 뒤 순위가 답한 결과도 같은 키로 캐시된다.
- 두 제공자 키를 모두 넣어야 체인이 동작한다. 키가 하나뿐이면 지금과 같다.
- 순위는 측정이 바뀌면 `fallbackChain`만 고친다. 근거는 T-122에 날짜와 함께 남긴다.

## 순위를 더할 때
1. 후보는 Artificial Analysis 리더보드로 추리고 `npm run smoke:providers`로 잰다(T-122 기준: 뜻까지 시간, 존댓말, 근거 준수, JSON, 무료 한도).
2. 새 제공자면 `PROVIDERS`에 항목을 먼저 추가한다(규칙 7). 모델만 다르면 `models`에 추가.
3. `fallbackChain` 배열의 원하는 자리에 `{ "provider", "model" }`를 넣는다. 코드는 고치지 않는다.
4. 근거(측정 날짜·수치)를 `docs/TASKS.md` 해당 작업에 남기고, `intro.html` 제공자 표를 고친다.

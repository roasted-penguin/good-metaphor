# 0011 검색 평가는 실제 확장 안에서, 임베딩은 항상 한 문장씩

- 상태: 채택 (2026-11-01, T-128)

## 배경
T-102로 e5-base를 실제 크롬에서 확인하다가, 시험해 보기의 1위 개념이 `npm run eval`(Node)과 크게 다른 것을 발견했다. 원인은 두 가지였다.
1. **묶음 크기.** q8 모델은 활성값 양자화 스케일을 배치 단위로 잡아, 같은 문장도 함께 묶인 문장에 따라 벡터가 달라진다. e5-base는 36개 묶음 ↔ 한 문장씩의 최소 cos가 0.94였다. 오프스크린은 16개씩, 평가는 36개를 한 번에 넣고 있었다.
2. **계산 엔진.** 한 문장씩으로 맞춰도 Node(onnxruntime-node)와 브라우저(onnxruntime-web wasm)는 q8 결과가 달라 54문장 중 16개의 1위가 달랐다. Node용 transformers.js는 wasm 엔진을 지원하지 않는다.

q4·fp16은 묶음과 상관없이 같은 벡터를 내지만 e5-base 기준 785MB·530MB라 확장에 넣기 무겁다.

## 결정
- 확장 오프스크린과 평가 도구 모두 `lib/embed-each.js`의 `embedEach`로 **한 문장씩** 임베딩한다.
- `npm run eval`은 기본으로 **실제 확장(크롬)에서** 오프스크린 임베딩을 받아 잰다(`tools/browser-embedder.mjs`). 점수 계산(`retrieve`)은 같은 순수 함수를 Node에서 돌린다. `--node`는 빠른 확인용이고 출력에 "확장과 다를 수 있음"을 붙인다.
- 옵션 페이지에서 오프스크린 `embed`를 직접 부르는 계약은 e2e "평가 도구 계약" 테스트로 고정한다.
- `npm run check:embed`: 새 프로필로 모델을 받고, 평가셋·검증셋 전 문장에서 시험해 보기의 1위가 평가 계산과 같은지 본다.

## 결과
- 확인: 1위가 평가와 같음 54/54. e5-base 첫 로드(다운로드 포함) 39.4초, 캐시 3.2초, 호버 한 번 중간 119ms(최대 168ms).
- T-113 수치를 실제 확장 기준으로 바로잡았다: 평가셋 30 → **27/35(77%)**, hit@3 94%, 금융 10/12, 새 문장 12/19, 검증셋 12/14. 비교 기준(T-113 전 e5-small)은 18/35, 금융 4, 새 문장 8, 검증 6이라 e5-base 전환 판단은 그대로다.
- 이전에 Node 기준으로 기록한 EVAL_LOG 수치는 실제와 다를 수 있다(해당 줄은 그대로 두고 이 ADR 이후 줄만 브라우저 기준).
- 평가 한 번에 크롬을 띄워 수십 초가 걸린다. CI에서는 돌리지 않는다(지금과 같음).

## 덧붙임: Actions에서 실제 크롬 평가 (T-200, 2026-11-22)
- PR마다 돌리지는 않는다(위와 같음). 맥이 밤에 Ollama 작업으로 크롬을 못 띄울 때를 위해 **수동 실행 `eval` 워크플로**(`.github/workflows/eval.yml`)를 둔다. smoke처럼 Actions 탭 → eval → Run workflow, 또는 `gh workflow run eval.yml --ref <브랜치> -f suites=guard`. 기본 브랜치(dev)에 아직 없는 브랜치는 `eval/<이름>` 브랜치로 push하면 guard 프리셋이 돈다.
- 실행 목록은 로컬과 같은 `npm run eval:ci -- <프리셋>`(`tools/eval-ci-lib.mjs`): `guard`(가드 + 여유 가드), `full`(메이플 가드·여유 가드·홀드아웃 + 식당 가드·홀드아웃), `precomputed`(동봉 벡터 + 가드), `precise-judge-offline`(정밀 판정 캐시만), `custom`(입력 `args` 그대로). 가드·여유 가드가 실패하면 잡이 실패한다.
- 크롬은 로컬과 같은 headless Playwright chromium(ubuntu, CI 전용 플래그 없음 — e2e와 같다). 모델 파일은 크롬 프로필 `.tmp/ext-eval-profile`의 CacheStorage에 들어가므로 프로필째 `actions/cache`(열쇠: 모델 id + dtype + transformers.js 판본 + Playwright 판본)로 둔다. 200MB 미만 프로필(받다 실패)은 저장하지 않는다.
- 결과: 잡 요약(셋별 hit@1·@3·그룹, 회귀, 여유 가드 줄), 아티팩트 `eval-logs`(전체 로그), `judge-cache`(`.tmp/judge-*.json`, 다음 실행의 입력 `judge_cache_run`으로 받는다), `build_vectors`·`upload_vectors`면 `vectors`. API 키는 쓰지 않고, CI는 커밋하지 않는다(벡터는 내려받아 PR에 커밋).
- 수치를 EVAL_LOG에 옮길 때는 실행 번호(run id)를 함께 적는다. 리눅스 크롬과 맥 크롬의 q8 결과가 같은지는 첫 실행에서 맥 기록과 비교해 확인한다.

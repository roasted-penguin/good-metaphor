# 0002 임베딩은 브라우저 안(오프스크린 문서)에서 돌린다

- 상태: 채택 (2026-09-28)

## 배경
호버마다 문장을 임베딩해야 한다. 서버를 두면 비용과 개인정보 부담이 생긴다.

## 결정
- transformers.js + `Xenova/multilingual-e5-small`(q8, 약 120MB)를 확장 안에서 실행한다.
- MV3 서비스 워커는 동적 import가 막혀 있어 오프스크린 문서에서 실행한다.
- onnxruntime wasm은 `extension/vendor/`에 번들하고 `useWasmCache=false`(blob URL이 CSP에 막힘).
- 모델을 못 받으면 글자 n-gram 대체 임베더로 전환한다(`fallbackOnError`).
- 벡터 캐시 키 = 임베더 id + 텍스트 해시.

## 결과
- 외부로 나가는 호출은 LLM 1회뿐이다.
- 첫 실행에 모델 다운로드가 필요하다. 교차 분야 검색 품질은 T-103에서 검증한다.

# 0012 추상 태그는 공통 파일 tags.json, 합치는 곳은 런타임마다 로더 한 곳

- 상태: 결정 (2026-11-08, T-304)

## 배경
추상 태그 18개(통제 어휘, 규칙 9)가 관심사 그래프 `extension/data/common/maplestory.json` 안에 있었다. 두 번째 관심사 식당(T-302)과 커스텀 관심사(T-301)도 같은 태그를 써야 금융 문장과 구조가 같은 노드를 관심사와 상관없이 찾을 수 있다. 서버의 추출 어휘(T-412)와 질의 키워드 프롬프트도 같은 목록에서 나와야 한다. 태그가 메이플 파일에 묶여 있으면 관심사를 늘릴 때마다 복사본이 생기고 어긋난다.

## 결정
- 태그 원본은 `extension/data/common/tags.json`(`{ version, note, tags: [...] }`)이다. 관심사 그래프 파일에는 `tags`가 없고, 노드 `tags`에 태그 id만 적는다.
- **합치는 곳은 런타임마다 로더 한 곳이다.** 로더가 같은 폴더의 `tags.json`을 읽어 `{ ...graph, tags }`로 합친 "해석된 그래프"를 돌려주고, 그 아래(`mergeGraphs`, `retrieve`, `nodeText`, 서버 파이프라인·시드·추출)는 지금처럼 `graph.tags`를 쓴다.
  - 확장: `lib/stores.js` `loadCommonGraph`(병합 규칙은 `lib/graph.js` `resolveCommonGraph`)
  - Node 도구·테스트: `tools/load-graph.mjs` `loadCommonGraphFromDisk`
  - 서버: `app/config.py` `load_common_graph`(`Settings.common_graph()`). 경로는 `TAGS_PATH`, 기본값은 그래프 파일 옆(금칙어와 같은 규칙). 도커는 `/data/common/tags.json`.
- 태그 순서는 파일 순서 그대로다. 순서가 바뀌면 `nodeText`가 바뀌어 벡터 캐시와 검색 순위가 바뀐다. 분리할 때 순서를 그대로 옮겼고 단위 테스트가 순서와 `nodeText` 스냅숏을 고정한다.
- 공통 그래프 검증에서 노드가 태그 파일에 없는 id를 참조하면 **오류**다. 사용자 오버레이의 없는 태그는 지금처럼 `mergeGraphs`가 조용히 버린다.
- 하위 호환: 그래프에 `tags`가 이미 있으면(예전 형식의 원격 공통 저장소) 태그 파일 없이 그대로 쓴다. 원격 그래프에 `tags`가 없으면 같은 주소 폴더의 `tags.json`을 받는다.

## 결과
- 식당·커스텀 관심사가 같은 태그 파일을 참조할 수 있다. 관심사 파일은 노드·엣지만 가진다.
- 검색 결과는 분리 전과 같다(`npm run eval:fallback` 출력 동일, `nodeText` 스냅숏 동일).
- 추출 어휘와 키워드 프롬프트 어휘가 같은 `tags.json`에서 나오는지 서버 테스트가 확인한다(규칙 9).
- 서버 결과 캐시 키와 `/health` 판본은 여전히 관심사 그래프의 `version`이다. 태그를 바꾸면 `tags.json` `version`과 함께 관심사 그래프 `version`도 올린다(시드를 다시 넣고 캐시를 비우기 위해).
- 공통 그래프를 직접 `JSON.parse`/`json.loads`로 읽으면 태그가 빠진다. 새 도구·테스트는 위 로더를 쓴다.

---
description: 공통 저장소(메이플스토리) 그래프에 개념 노드를 안전하게 추가한다
argument-hint: "<개념 이름, 예: 에디셔널 잠재능력>"
---

먼저 `git fetch origin && git switch -c task/data-<영문-슬러그> origin/dev`로 브랜치를 만든 뒤, 공통 그래프 `extension/data/common/maplestory.json`에 "$ARGUMENTS" 노드를 추가해. 이 파일은 모든 사용자가 보는 사실 근거라서 아래 규칙을 지켜.

1. **사실 확인** 나무위키나 공식 가이드 같은 출처를 찾아 읽고, facts는 2~3개 문장으로 쓴다.
   - 시스템의 구조만 쓴다. 확률표, 최대 단계, 가격, 이벤트 날짜처럼 패치로 바뀌는 수치는 넣지 않는다.
   - 확신이 없는 문장은 넣지 않는다. 출처를 못 찾으면 멈추고 알려 줘.
   - 문장 끝은 "~다."로 통일.
2. **태그** 기존 태그(`extension/data/common/tags.json`, 규칙 9)에서 골라 노드 `tags`에 id만 적는다. 새 추상 태그가 꼭 필요하면 `tags.json` **맨 뒤에** 분야 중립적인 설명(`desc`)으로 추가하고(중간에 넣으면 순서가 바뀌어 검색 순위가 흔들린다, ADR 0012), 이 태그를 쓸 수 있는 다른 분야 예를 두 가지 들어 줘.
3. **출처·검수 날짜(T-118)** `sources`에 **실제로 열어 내용을 확인한** 공식 페이지(`maplestory.nexon.com` 패치 노트·가이드·공지) URL을 1개 이상, `verifiedAt`에 확인한 날(YYYY-MM-DD). 위키·인벤 URL은 넣지 않는다(D-5). 공식 출처를 못 찾으면 멈추고 알려 줘. 없으면 그래프 검증이 실패한다.
4. **엣지** 기존 노드와의 관계를 짧은 동사구(`rel`)로 1~2개.
5. `version`의 날짜·번호를 올린다. 태그를 바꿨으면 `tags.json`의 `version`도 올린다.
6. `npm run test:unit`(그래프 무결성 검사 포함)과 `npm run eval:fallback`을 돌린다. 실제 모델을 쓸 수 있으면 `npm run eval`.
7. 커밋 메시지: `data: 공통 그래프에 <개념> 추가`. 사용한 출처 링크를 커밋 본문에 남긴다.
8. `/ship` 절차로 push 후 dev로 PR. PR 본문에 출처 링크와 추가한 facts 전문을 넣어 검수자가 바로 확인할 수 있게 한다.

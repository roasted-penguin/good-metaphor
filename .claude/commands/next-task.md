---
description: 다음 작업을 골라 새 브랜치에서 구현하고, push 후 dev로 PR을 연다
argument-hint: "[작업 ID, 예: T-105] (생략하면 자동 선택)"
---

`CLAUDE.md`의 "지켜야 할 규칙"과 "작업 방식", 그리고 `docs/TASKS.md`를 읽고 아래 순서로 끝까지 진행해.

## 1. 준비
- `git status`가 깨끗하지 않으면 멈추고 무엇이 남아 있는지 알려 줘.
- `git fetch origin`. `origin/dev`가 없으면 멈추고 CLAUDE.md의 원격 설정 방법을 안내해.

## 2. 작업 고르기
- 인자가 있으면 그 작업: $ARGUMENTS
- 없으면 `origin/dev`의 `docs/TASKS.md`("한눈에 보기" 표) 기준으로 상태가 `대기`이고 "먼저 끝나야 할 것"이 모두 `완료`인 작업 중 우선순위(P0 → P1 → P2), 표 순서로 첫 번째.
- `결정 필요`(D-x)에 막혀 있으면 멈추고, 선택지와 추천을 요약해서 물어봐.
- `gh pr list --base dev --state open`으로 같은 ID의 PR이 이미 열려 있는지 확인. 있으면 그 작업은 건너뛴다.

## 3. 브랜치
- `git switch -c task/<ID>-<짧은-영문-슬러그> origin/dev` (예: `task/T-105-precompute-vectors`).
- `gh pr list --base dev --state merged`로 병합된 작업 중 TASKS.md에 아직 `리뷰`인 것이 있으면 `완료`로 바꾸고 `chore: 병합된 작업 상태 갱신`으로 먼저 커밋.
- 고른 작업 상태를 `진행`으로.

## 4. 계획 → 구현
- 작업의 "완료 기준"을 인용하고, 고칠 파일과 추가할 테스트를 5줄 이내로 적은 뒤 바로 진행(질문은 정말 막혔을 때만).
- 테스트를 먼저 쓸 수 있으면 먼저. 순수 로직은 `tests/unit`, 확장 동작은 `tests/e2e`. `src/offscreen-src.js`를 고치면 `npm run build`.
- 커밋은 논리 단위로 작게: `feat(<ID>): ...`, `fix(<ID>): ...`, `test(<ID>): ...`, `docs(<ID>): ...`.

## 5. 확인과 기록
- `npm test` 통과. 검색·생성에 영향이 있으면 `npm run eval`(모델을 못 받으면 `npm run eval:fallback`이라고 명시) 후 `docs/EVAL_LOG.md`에 한 줄.
- `docs/TASKS.md`: 상태 `리뷰`, 작업 로그에 날짜·ID·브랜치·내용(PR 칸은 비워 둠). 새로 발견한 문제는 새 T-번호로 표에 추가.

## 6. 올리기
`/ship` 절차를 그대로 따른다(push → dev로 PR → PR 링크 기록).

마지막에 PR 링크, 한 일, 확인하지 못한 것(예: 실제 키 없이 테스트함)을 3줄 이내로 알려 줘.

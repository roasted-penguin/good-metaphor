---
description: 단위·e2e 테스트와 대체 임베더 평가를 돌려 현재 상태를 점검한다
---

1. `npm run test:unit`
2. `npm run test:e2e` (브라우저가 없으면 `npx playwright install chromium` 후 재시도)
3. `npm run eval:fallback`
4. `git status`로 커밋 안 된 변경 확인

결과를 표 하나로 요약해: 항목 · 통과/실패 · 실패 원인 한 줄. 실패가 있으면 원인을 조사하고 고칠 방법을 제안해(바로 고치지는 말 것).

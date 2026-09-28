---
description: 현재 작업 브랜치를 push하고 dev로 PR을 연다
argument-hint: "[draft] (테스트가 실패한 채로 올려야 할 때)"
---

현재 브랜치를 원격에 올리고 `dev`로 PR을 열어.

1. **확인**
   - 현재 브랜치가 `main`이나 `dev`면 멈춘다.
   - 커밋 안 된 변경이 있으면 목록을 보여 주고 커밋할지 묻는다.
   - `npm test`. 실패하면 멈추고 원인을 알려 준다. 인자가 `draft`면 계속 진행하되 PR을 Draft로 열고 본문에 실패 내용을 적는다. (인자: $ARGUMENTS)
   - `git fetch origin` 후 `origin/dev`보다 뒤처져 있으면 `git rebase origin/dev`, 충돌이 나면 멈추고 알려 준다.
2. **push** `git push -u origin HEAD`. 리베이스로 이미 올린 이력이 바뀌었으면 `git push --force-with-lease`(이 브랜치에만).
3. **PR 본문** `.github/pull_request_template.md` 형식으로 `.tmp/pr-body.md`를 채운다. 작업 ID와 제목은 브랜치 이름과 `docs/TASKS.md`에서 가져오고, 완료 기준 체크리스트는 TASKS.md 해당 작업의 "완료 기준"을 그대로 옮겨 실제로 확인한 것만 체크한다.
4. **PR 열기**
   - 이 브랜치의 PR이 이미 있으면(`gh pr view`) 새로 열지 말고 링크만 알려 준다.
   - GitHub: `gh pr create --base dev --head <브랜치> --title "<ID> <작업 제목>" --body-file .tmp/pr-body.md` (draft면 `--draft`)
   - GitLab: `glab mr create --target-branch dev --source-branch <브랜치> --title "<ID> <작업 제목>" --description "$(cat .tmp/pr-body.md)"`
   - 둘 다 없으면 원격 주소로 PR 생성 URL을 만들어 알려 준다.
5. **링크 기록** `docs/TASKS.md` 작업 로그의 이 작업 줄 PR 칸에 링크를 넣고 `docs(<ID>): PR 링크 기록`으로 커밋·push.

끝나면 PR 링크 한 줄만 알려 줘.

# 커밋·PR·병합 메시지

## 제목

- 커밋, PR 제목과 최종 병합 커밋 제목은 `접두사: 한국어 설명`을 사용한다.
- 접두사는 `feat`, `fix`, `chore`, `refactor`, `test`, `docs`다. 선택적으로 `fix(auth): …` 같은 scope와 호환성 파괴를 뜻하는 `!`를 사용한다.
- 예: `feat: XLSX 파일 가져오기 지원`, `fix: 모바일 프로젝트 탭 이동 개선`, `chore: 라우트 코드 분할로 번들 경고 해소`.
- `Merge pull request #N from …`, PR 번호만 있는 제목, 의미 없는 squash 기본 제목은 사용하지 않는다.
- PR 제목이 규칙에 맞으면 병합 제목으로 그대로 사용한다. 관련 Issue, 링크와 `Closes #N` 등 자동 종료 키워드는 본문에 보존한다.
- squash 또는 merge 방식은 프로젝트에서 확정한다. 이 정책은 자동 병합 권한을 부여하지 않는다.

## Windows와 실제 저장 결과

- 안내에는 PowerShell과 Git Bash를 명시하고 서로의 문법을 섞지 않는다. PowerShell의 파일 복사는 `Copy-Item`이며 CMD의 `copy /Y`를 섞지 않는다.
- 한글 자동화는 UTF-8 입력·출력을 명시한다. 스크립트는 Node의 UTF-8 JSON 파싱과 인수 배열을 우선 사용한다. 제목을 셸 코드에 삽입하거나 `eval`로 실행하지 않는다.
- 직접 PowerShell 스크립트를 작성한다면 PowerShell 7을 기준으로 `[Console]::InputEncoding`, `[Console]::OutputEncoding`, `$OutputEncoding`을 UTF-8로 설정한다. Windows PowerShell 5.1을 같은 환경으로 간주하지 않는다.
- 병합 직전에 최신 head, 필수 CI, 독립 리뷰와 필요한 사람 승인을 확인하고, 예상 head를 지정해 병합한다.
- 병합 이후에는 PR API가 반환한 `merge_commit_sha`로 실제 커밋을 조회한다. `main`의 마지막 커밋은 다른 PR일 수 있으므로 검증 대상으로 추정하지 않는다.
- 실제 subject가 사전에 확인한 PR 제목과 정확히 일치하고 규칙에 맞아야 완료다. 한글 깨짐, 제목 불일치, 조회 실패는 후속 처리 실패로 보고한다.
- 제목 오류를 발견해도 이미 병합된 사실을 숨기거나 자동으로 재병합·force push·이력 재작성하지 않는다. 사람 판단을 받는다.

## 사용자 실행 도구

Node 22 이상과 로그인된 GitHub CLI가 있는 환경에서 실행한다. 아래 명령은 실제 병합을 수행하므로 필요한 사람 확인을 마친 뒤 사용자가 실행한다. workflow가 실행하지 않는다.

PowerShell 또는 Git Bash에서 같은 Node 명령을 사용할 수 있다.

```text
node .github/scripts/merge-pr.mjs owner/repo PR번호 squash
```

`merge`를 선택하려면 마지막 인수를 `merge`로 바꾼다. v1 게이트의 check run 이름은 `independent-review`로 고정한다. 이름 변경은 정책·workflow·브랜치 보호·병합 도구를 함께 변경하는 별도 높은 위험 작업이다.

이 도구는 기본 브랜치 대상 여부, 필수 검사, GitHub Actions 앱·승인된 workflow 출처, 최신 fingerprint와 실제 리뷰 근거를 검증한다. 병합 직전에 본문·base/head·관리자 확인·리뷰를 다시 조회한다. branch protection API에서 strict required checks와 검사 게시 앱 고정을 확인할 수 없으면 병합하지 않는다. 확인과 병합 사이 base 경쟁의 최종 방어는 이 GitHub 보호 설정이며, `--match-head-commit`만으로 base를 원자적으로 고정할 수 있다고 표현하지 않는다.

사람 승인은 GitHub 브랜치 보호로 강제하며 도구의 성공만으로 사람 승인 조건을 대체하지 않는다. CLI 응답·인증값은 오류 로그에 출력하지 않는다.

브라우저에서 병합할 때도 제목을 직접 확인하고 병합 후 같은 PR의 커밋을 조회한다. 로컬 기본 브랜치를 pull했다는 사실만으로 제목 검증을 대체하지 않는다.

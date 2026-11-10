# 로컬 독립 리뷰 결과 자동 게시

Claude Code 구현 → 같은 Claude 세션의 native Codex 플러그인 검토 → Claude 수정 → 변경된 HEAD 재검토 흐름을 유지한다. 아래 wrapper로 기존 리뷰와 자동 게시를 연결한다. wrapper와 별도로 같은 base/head의 `/codex:review`를 실행하지 않는다. Stop 리뷰 게이트와 GitHub Automatic reviews도 켜지 않는다.

```text
npm run review:publish -- yoobilee/photo-selector <PR번호> --plugin-root <설치된 Codex 플러그인 루트> --session <현재 Claude 세션 ID>
```

`CODEX_COMPANION_SESSION_ID` 또는 `CLAUDE_SESSION_ID`가 있으면 `--session`을 생략할 수 있다. 현재 Claude 세션이 실행한다. Codex 구현 PR에는 사용하지 않는다(Claude 독립 검토 필요). plugin cache, `.codex/config.toml`, hooks는 변경하지 않는다.

## 실행과 출력

1. 원격 PR·정책·파일·댓글·검사를 전체 조회해 대상과 fingerprint를 고정하고 로컬 HEAD를 확인한다.
2. 기존 `codex-companion.mjs review --wait --base <고정 base SHA> --scope branch --json`을 1회 실행한다. 모델·추론 강도는 기존 설정을 따른다. 이어 `result --json`으로 같은 세션·thread·완료 job을 수집한다. 별도 독립 리뷰를 중복 실행하지 않는다.
3. 원문·지적·현재 HEAD의 CI check·미실행/확인 불가 항목을 모은다. native plugin은 명령별 검사 결과의 구조화된 증명을 제공하지 않는다. 원문에 있는 검사 주장은 관리자와 CI가 따로 확인한다. 모르는 형식을 0건으로 읽지 않는다. unknown이나 미해결 critical/high/medium이면 원문과 `review-needs-attention`을 출력하고 게시하지 않는다.
4. 기존 `review-evidence.yml`의 고정된 기본 브랜치에 등록 요청만 전달한다. 개인 GitHub 인증으로 PR 댓글을 쓰지 않는다. workflow는 PR 코드·모델·설치·테스트를 실행하지 않고 기본 브랜치 코드와 최소 `GITHUB_TOKEN` 권한으로 미인증 자료를 게시한다.
5. workflow가 댓글 ID·본문을 확인한 뒤 `review-evidence-v2-<댓글 ID>-<본문 SHA-256>` 이름의 artifact를 만든다. 내용은 댓글 링크·ID·해시뿐이다. API가 artifact를 원본 run에 연결한 metadata가 게시 경로의 영수증이다. ZIP을 게이트에서 실행/추출하지 않는다.
6. 성공한 실행과 댓글을 다시 검증해 stdout JSON에 댓글 링크·해시·관리자가 직접 작성할 `/review-gate`를 출력한다. 보고서를 수동 게시할 필요가 없다. 확인 내용만 다시 조회하려면:

```text
npm run review:prepare -- yoobilee/photo-selector <PR번호> --confirmation
```

관리자는 원문·실행 이력·독립성·검사 한계를 확인하고 생성된 `/review-gate`를 직접 게시한다. High의 `/merge-approve`도 별도로 직접 게시한다. AI는 두 댓글을 대신 쓰지 않는다. fingerprint, evidence digest, proof v2, strict 보호와 필수 CI는 유지한다.

## 신뢰 경계

- `미인증 로컬 독립 리뷰 자료` 표시는 게시 후에도 유지한다. bot·완료 플래그·output hash·영수증은 Codex가 독립 검토했다는 인증이 아니다. 로컬 JSON·plugin job·ledger는 같은 기기의 사용자/Agent가 위조할 수 있다. 실제 실행·독립성은 사람이 확인한다.
- 게이트는 관리자 확인이 링크한 봇 보고서의 정확한 bot ID·앱 ID·유형, 재구성한 본문·해시, PR 번호·repo·base/head·fingerprint·정책 SHA, 승인된 게시 workflow/코드, 최초 실행 성공, run 소속 영수증을 확인한다. 출처 정보도 digest에 포함한다. 영수증만으로 자동 승인하지 않는다.
- `actions: read`는 게이트의 run/artifact 조회에 추가했다. 게시기는 기존 read 권한과 `issues: write`만 사용한다. 추가 쓰기·병합 권한·AI 인증은 없다. Actions token 댓글은 후속 workflow를 자동 실행시키지 않을 수 있으며 관리자 `/review-gate`가 기존 게이트를 실행한다.
- 관리자 인증 공유는 미해결이다. 현재 gh 로그인으로 dispatch를 요청하지만 같은 인증으로 AI가 임의 승인 댓글을 쓰는 것을 기술적으로 막지 못한다. 봇 게시와 사람 승인의 구분은 완전한 사람 증명이 아니다. 강한 보장이 필요하면 관리자 자격증명을 AI 환경에서 제거하고 비관리자 실행 계정/전용 게시 App과 사람 전용 승인 환경을 별도 구성·검증해야 한다. 이번 PR은 App 설치·권한을 변경하지 않는다.

## 실패·중복·복구

- `.git/photo-selector-review-<대상 식별자>.json`과 `.lock`은 로컬 실행 기록이며 보안 증거가 아니다. 동일 repo·PR·base/head에서는 완료 결과를 재사용한다. 본문·정책·세션이 바뀌면 자동 재검토하지 않고 중단한다. running ledger/lock은 프로세스 상태와 기존 plugin job을 사람이 확인하기 전 지우지 않는다.
- 같은 결과가 게시됐으면 정확한 원문·성공한 게시 실행·영수증을 검증해 재사용한다. 유사 봇 문구·다른 PR 결과는 사용하지 않는다. 중복 댓글이면 차단한다.
- HTTP 실패·시간 초과는 POST 자동 재시도를 하지 않는다. 댓글만 있고 artifact 기록/실행이 실패하면 미완료 자료로 남고 통과하지 않는다. Actions와 실제 댓글을 사람이 조사한다. wrapper를 재실행해도 기존 완료 ledger가 있으면 추가 AI 호출을 하지 않는다.
- 영수증은 90일 보존한다. 삭제·만료, 게시 코드 승인 버전 변경, 원문 수정, 최신 대상 변경은 차단한다. 복구에는 관리자 조사와 현재 대상의 재등록 결정이 필요하다.
- 마지막 조회와 쓰기 사이 경합을 원자적으로 제거하지 못한다. 이후 HEAD 등이 달라지면 이전 자료로 현재 게이트를 통과하지 못한다.

## 도입과 롤백

workflow는 기본 브랜치의 승인된 버전만 실행한다. 이 변경 PR에서는 실환경 활성화가 불가능하며 이전 workflow의 차단을 우회하지 않는다. main 반영 뒤 Claude 구현의 별도 PR에서 1회 실운영 검증이 필요하다. 이 PR 자체는 Codex 구현이므로 Claude 독립 검토와 사람 확인을 거쳐 기존 수동 보고서 경로로 도입한다.

문제가 있으면 wrapper를 중단하고 변경을 revert해 수동 보고서로 돌아간다. 기존 승인 댓글·보고서는 수정/삭제하지 않는다.

참고: [OpenAI App Server](https://learn.chatgpt.com/docs/app-server), [GitHub artifact API](https://docs.github.com/en/rest/actions/artifacts), [GITHUB_TOKEN](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token). 로컬 plugin 1.0.6 출력과 대조했으며 형식 변경은 추측해 수용하지 않는다.

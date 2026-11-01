# 리뷰 자료 수집과 봇 보고서 등록

## 제공 범위와 활성화 순서

이 도구는 SHA·fingerprint·정책 SHA·수집 digest·보고서 SHA-256을 계산하고, 기존 게이트의 실제 판정과 리뷰 자료를 조회한다. 명시적으로 요청하면 별도 Actions workflow가 보고서를 봇 명의로 등록한다. AI를 호출하거나 관리자 확인·승인·병합을 하지 않는다.

PR #11이 먼저 병합되어야 한다. 그 뒤 후속 PR의 base를 main으로 바꾸고 최신 CI·독립 리뷰·기존 관리자 확인을 거쳐 병합한다. `review-evidence.yml`이 기본 브랜치에 도입되기 전에는 dispatch가 실패한다. 기존 보호 설정과 `independent-review` 게이트는 계속 유지한다.

## 읽기 전용 사용

Node·npm·GitHub CLI의 기존 조회 권한을 사용한다. 읽기 전용 명령은 다음과 같다.

```text
npm run review:prepare -- yoobilee/photo-selector PR번호
npm run review:prepare -- yoobilee/photo-selector PR번호 --output review-packet.json
```

`--output`은 UTF-8로 저장하며 기존 파일을 덮어쓰지 않는다. PowerShell의 기본 리다이렉션 인코딩이나 npm 시작 문구가 JSON에 섞이는 문제를 피한다. 결과에는 현재 target, 자동 계산된 값, 기존 게이트 정책 재평가, 필수 검사의 관찰 결과, 로컬 결과용 template가 있다. 게시된 check의 workflow 출처나 실제 병합 가능 여부를 확정하는 검사는 기존 병합 도구가 담당한다. `gate.publishedSourceVerified`와 `mergeAuthorized`는 항상 false다.

PR·기본 브랜치 정책·전체 파일·댓글·리뷰·인라인·check 목록을 두 번 읽고 비교한다. 수집 사이 수정·삭제·권한·검사·정책 변경, 목록 누락·중복 ID, API 실패는 중단이다. 자동 AI 호출과 자동 재시도는 없다.

## 결과 수집과 자체/독립 리뷰

- 기존 게이트가 현재 대상으로 이미 검증한 관리자 보고서가 있으면 그 원문과 확인을 수집한다. 새 관리자 확인을 생성하지 않는다.
- Claude 구현의 Codex GitHub 리뷰는 기존 신뢰할 봇 ID·앱과 완료 파서로 수집한다. 요약·리뷰·인라인을 모두 읽는다. 스킵·누락·이전 HEAD·형식 불명·한도 초과는 완료가 아니다.
- Codex 구현의 Claude 등 로컬 결과는 `review-packet.json`의 `localResultTemplate`을 리뷰 세션에 함께 전달한다. 결과 수집 담당 Agent가 target을 그대로 보존한 `result.json`을 만든다. 사용자가 SHA나 fingerprint를 옮겨 적을 필요는 없다.
- 템플릿의 `findings: null`, `report: null`, `sessionId: null`은 미완성 값이다. 실제 리뷰 실행 결과로 채워야 한다. 빈 응답을 0건으로 채우거나 status만 completed로 바꾸지 않는다.
- 결과의 role은 self 또는 independent다. self는 구현 Agent와 같아야 하며 independent는 기존 정책의 다른 reviewer와 같아야 한다. 고위험 독립 검증에 자체 리뷰를 재사용하지 않는다.
- 로컬 sessionId와 보고서 파일만으로 실제 AI 실행을 인증할 수 없다. 결과는 `unverified-local-session`으로 표시하며 관리자 확인을 대체하지 않는다. GitHub 봇 조회 또는 기존 게이트 검증과 구분한다.

```text
npm run review:prepare -- yoobilee/photo-selector PR번호 --result result.json --output checked-packet.json
```

결과는 v, target, role, reviewer, status, reviewComplete, findings, report, source 필드를 정확히 가진 JSON이다. status는 completed/running/skipped/limit/failed, findings는 critical/high/medium/low/unknown의 음이 아닌 정수다. completed와 reviewComplete=true는 함께 있어야 한다. report는 비어 있지 않은 UTF-8 20,000바이트 이하, source는 `{"kind":"local-session","sessionId":"실제 세션 식별자"}`다. target은 템플릿을 프로그램으로 재사용한다. 알 수 없는 필드나 이전 target은 거부한다.

## 봇 보고서 등록

기본 브랜치 도입 후 결과 수집 담당 Agent가 다음처럼 요청한다.

```text
npm run review:prepare -- yoobilee/photo-selector PR번호 --result result.json --dispatch
```

현재 신뢰할 GitHub 리뷰 또는 기존 게이트가 확인한 보고서를 수집할 때는 `--result`를 생략할 수 있다. CLI는 고정된 `review-evidence.yml`과 기본 ref만 dispatch한다. 관리자 인증으로 댓글을 직접 쓰는 옵션은 없다. `--dispatch`가 없으면 workflow도 요청하지 않는다. 로컬 파일·보고서·해시를 stdout에 출력할 수 있으므로 결과 파일에 인증값을 넣지 않는다.

workflow는 기본 GITHUB_TOKEN만 사용한다. contents/pull-requests/actions는 read, issues는 보고서 작성을 위한 write다. checks·contents·actions write, 별도 Secrets, AI 인증은 없다. PR 코드·의존성·설치·캐시·임의 셸을 실행하지 않는다. workflow run ID·ref·HEAD·저장소·path·승인된 YAML을 확인하고 최초 attempt만 허용한다.

보고서는 불변 target과 수집 digest, 리뷰 역할·출처·완료 여부·집계를 명시한다. 같은 key와 동일 본문의 실제 GitHub Actions 봇 댓글만 재사용한다. 위조 작성자나 변경된 보고서를 같은 등록으로 인정하지 않는다. 게시 후 응답이 불명확하면 자동 재시도하지 않고, 다음 명시적 실행에서 실제 댓글로 복구한다. 요청 성공은 게시 완료가 아니며 Actions 실행 결과·댓글을 확인해야 한다. 봇 계정/앱 응답 형식은 실제 도입 후 확인하며 모르는 형식은 통과시키지 않는다.

## 남아 있는 승인 경계

봇 보고서만으로 현재 게이트는 성공하지 않는다. 기존 게이트는 관리자 명의 보고서와 `/review-gate`, High 병합 도구는 별도 `/merge-approve`를 요구한다. 이 도구가 수집·보고서 등록을 완료해도 그 절차를 대신 실행하지 않는다. 기존 게이트가 이미 성공한 경우에는 그 사실만 조회한다.

관리자 인증을 AI와 공유하는 운영 전체를 이 코드만으로 차단할 수는 없다. 승인자 인증 격리, 별도 게시 주체, 실제 사용자 1회 승인과 기존 승인 증명의 대체는 후속 고위험 작업이다. 이를 완료하기 전까지 `/review-gate` 수동 입력이 완전히 제거됐다고 보고하지 않는다. 승인 댓글을 봇이 흉내 내도록 허용하거나 현재 게이트의 작성자 검증을 완화하지 않는다.

| 행동 | 현재 | 이 단계가 기본 브랜치에 도입된 후 |
|---|---|---|
| SHA·fingerprint·hash 계산 | Summary/API에서 직접 확인·복사 | 수집기가 계산, target 파일을 Agent가 전달 |
| 리뷰 실행 | 구현자와 다른 리뷰 세션 확보 | 동일. 자체/독립 구분과 결과 상태를 기계적으로 검사 |
| 보고서 댓글 등록 | 관리자가 원문을 복사해 등록 | 자료용 봇 보고서는 dispatch로 등록 가능 |
| 기존 게이트가 인정하는 관리자 보고서·`/review-gate` | 관리자 직접 확인·입력 | 보호 유지로 여전히 필요. 대체 승인 경로는 후속 단계 |
| 최종 승인·병합 | 관리자 판단과 기존 절차 | 동일. 위임·자동 병합 없음 |

기술 근거: [GitHub CLI workflow run](https://cli.github.com/manual/gh_workflow_run)의 파일 입력, [GitHub token 권한](https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication)의 권한 제한을 따른다. 후속 사용자 승인 후보인 [보호된 Environment](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)는 별도 설정·인증 분리 검증 후 도입한다.

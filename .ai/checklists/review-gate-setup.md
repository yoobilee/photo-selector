# 비용 없는 독립 리뷰 게이트 설정

## 제공 범위

이 스타터는 AI를 실행하지 않는 GitHub 상태 게이트를 제공한다. 리뷰 자체는 선택한 기존 구독·GitHub 연동 또는 수동 독립 세션에서 수행한다. 자동으로 Claude/Codex를 실행하는 기능까지 완성됐다고 표현하지 않는다. AI 실행 연동은 별도 프로젝트 설정·보안 검증 후 도입한다.

기본 게이트는 GitHub 기본 토큰으로 API 조회와 PR head의 `independent-review` check run만 기록한다. commit status의 동명 success는 인정하지 않는다. AI 인증값·유료 API 호출·댓글 작성·코드 수정·병합·재시도 루프가 없다. GitHub Actions 실행 시간은 별도 자원이다. 공개·비공개 저장소의 계정별 Actions 과금 조건과 추가 지출 차단 설정을 확인한다.

## 1. 최초 도입

- [ ] 워크플로우·판정 스크립트·설정의 변경은 높은 위험으로 취급하고 독립 리뷰와 사람 확인을 확보한다.
- [ ] 최초 도입 PR에는 아직 기본 브랜치에 새 workflow가 없으므로 이 게이트로 자신을 검증하지 못한다. 독립 리뷰·기존 CI·사람 승인으로 도입하고 이후 PR에서 실제 게이트를 검증한다.
- [ ] 기본 브랜치에 직접 push 금지, 사람 승인과 필수 CI를 설정한다. 현재 제공된 병합 도구를 사용할 프로젝트는 **클래식 브랜치 보호**를 설정한다. ruleset만 설정하는 것은 이 도구의 보호 조건 조회를 충족하지 않는다. 관리자 우회 병합은 일상 작업에 사용하지 않는다.
- [ ] `independent-review` check run을 필수 검사로 등록하고 예상 게시 앱을 GitHub Actions로 고정한다. 동명의 commit status나 workflow 자체의 성공만으로 병합하지 않는다.
- [ ] 기본 브랜치 보호의 required status checks에서 `strict`(최신 base 요구)를 켠다. 병합 도구는 이 설정과 검사 앱 ID를 API로 확인하며, 설정 조회 실패·미설정이면 병합하지 않는다. 현재 도구는 이 branch protection API를 기준으로 한다. ruleset만 사용하는 프로젝트는 동등한 보호 검증을 별도로 구현하기 전까지 도구 병합을 사용하지 않는다.
- [ ] 병합 도구를 실행하는 GitHub CLI 계정이 브랜치 보호 설정을 조회할 수 있는지 확인한다. 403·404 등으로 조회하지 못하면 권한을 임의로 높이거나 보호 검증을 생략하지 않고 사람 확인으로 멈춘다.
- [ ] `.ai/review-config.json`을 프로젝트에 맞게 확정한다. 높은 위험 경로에 DB 마이그레이션·인증·권한 등의 프로젝트 경로를 추가한다. 경로만으로 의미상 위험을 완전히 자동 분류할 수는 없다.
- [ ] PR 제목은 Conventional Commit 접두사와 한국어 설명을 사용한다.
- [ ] PR 본문의 `ai-review` 영역은 한 개만 둔다. 구현자·위험도·민감 변경 여부를 실제 값으로 바꾼다. 고위험의 `unknown`은 완료로 인정되지 않는다.
- [ ] 기본 브랜치·리뷰 이벤트 후 전체 열린 PR이 다시 평가되는지 확인한다. 저장소 단위 동시성에서 대기 이벤트가 대체되더라도 남은 실행이 모든 PR을 확인한다. 일반 이슈 댓글과 외부 사용자의 issue_comment는 실행 대상에서 제외한다. 게이트 이벤트에는 AI 호출이 없어 중복 이벤트도 추론 사용량을 소모하지 않는다.

## 2. 사람 확인과 생략

기본 게이트는 관리자(`admin`/`maintain` 권한의 실제 사용자)가 근거를 확인하는 모델이다. 봇·권한 없는 사용자·PR 본문의 자체 PASS 선언은 확인자가 될 수 없다. 권한 조회 실패도 통과가 아니다.

Actions의 해당 실행 Summary에서 `fingerprint`를 복사한다. 위험도, 구현자, 제목, 전체 PR 본문(이슈 연결 포함), 설정, base/head 또는 파일 목록이 바뀌면 값도 바뀐다.

저위험 또는 정책상 독립 리뷰가 필요 없는 경우, 사람이 실제 변경을 확인한 뒤 다음 PR 댓글을 작성한다. 예시 placeholder는 실제 값으로 바꾼다.

````text
/review-gate
```json
{
  "fingerprint": "Summary의 fingerprint",
  "decision": "skip",
  "reason": "변경 범위와 리뷰 생략을 허용한 근거"
}
```
````

고위험 경로, 민감 변경과 의존성 변경은 `risk: low`라고 적어도 이 댓글로 생략할 수 없다. 기본값에서 중간 위험도 독립 리뷰를 요구한다.

## 3. 필수 독립 리뷰 완료 확인

1. 구현 Agent와 다른 리뷰 Agent를 선정하고 `.ai/prompts/independent-pr-review.md`로 실제 리뷰를 수행한다. 보고서에는 현재 base/head SHA와 실행·완료 여부가 포함되어야 한다.
2. 관리자가 실제 리뷰 결과를 읽고 확인한 보고서를 같은 PR에 댓글로 기록한다. 첫 줄을 `# 독립 리뷰 보고서`로 쓰고 실제 보고서, 원래 결과 링크·사용 도구, base/head SHA, 확인 경로, 테스트 결과와 남은 위험을 포함한다. 보고서를 읽지 않고 Agent의 자체 보고를 옮기는 것만으로 완료하지 않는다.
3. 그 댓글로 실행된 게이트 Summary에서 최신 fingerprint, 보고서 댓글 ID와 SHA-256을 확인한다.
4. 다음 확인 댓글을 작성한다. `evidence`는 해당 보고서 댓글 링크이며 `evidenceHash`는 Summary의 SHA-256이다. `findings`는 남아 있는 지적 수다.

````text
/review-gate
```json
{
  "fingerprint": "Summary의 fingerprint",
  "decision": "pass",
  "reviewer": "codex",
  "reviewComplete": true,
  "evidence": "https://github.com/owner/repo/pull/123#issuecomment-456",
  "evidenceHash": "Summary의 보고서 SHA-256",
  "findings": { "critical": 0, "high": 0, "medium": 0, "low": 0 }
}
```
````

Codex 구현 PR은 `reviewer: claude`를 사용한다. 관리자 결과 확인은 구현자의 실제 Agent 참여 이력을 자동으로 증명하는 기능이 아니다. 구현자가 정확하게 입력했는지 사람이 확인한다.

critical/high/medium이 남으면 실패다. medium을 사람이 오탐 또는 허용 가능한 위험으로 판단했다면 코드·요구사항 근거와 결정을 보고서에 남기고 미해결 집계를 갱신한다. critical/high 차단을 수치만 바꿔 면제하지 않는다.

새 커밋·base·전체 본문·정책 변경과 보고서 수정·삭제는 재확인을 요구한다. 저장소 쓰기·maintain·admin 권한이 있는 리뷰어의 유효한 변경 요청은 이전 커밋에서 제출됐어도 차단한다. COMMENTED 리뷰나 새 push는 요청을 해제하지 않으며, 실제 요청의 dismissal 또는 같은 리뷰어의 유효한 APPROVED가 필요하다. 권한 없는 외부 사용자의 의견은 병합 차단 승인이 아니지만 지적 내용 자체는 검토한다. 최신 관리자 확인 댓글이 잘못되었다면 과거 PASS로 되돌리지 않는다. 실패·스킵·한도 초과는 리뷰 완료가 아니다.

## 검사 출처와 병합 직전 확인

check run의 앱 고정만으로 같은 GitHub Actions 앱을 쓰는 다른 workflow까지 구별되지는 않는다. 병합 도구는 check의 대상 fingerprint, 실행 링크·workflow ID·경로·재실행 횟수·저장소와 실제 실행한 YAML의 승인 버전 일치를 추가 확인한다. 이어서 현재 관리자 확인·보고서·리뷰를 API로 다시 평가하며 저장된 success만 신뢰하지 않는다.

게이트는 check의 `external_id`에 proof v2 `{"v":2,"pr","fingerprint","evidenceDigest","runId","attempt"}`를 기록한다. `evidenceDigest`는 `review-gate-core.mjs`의 `gateEvidence`가 판정 근거를 정렬된 JSON으로 만든 SHA-256이다.

- 근거에 들어가는 것:
  - 최신 `/review-gate` 확인 댓글과 확인 댓글이 링크한 보고서: 각각 ID, 작성자 ID·login·유형, 작성·수정 시각, 본문 SHA-256, 작성자의 현재 저장소 권한
  - `admin`·`maintain`이 작성한 `/merge-approve` 댓글: 같은 정보
  - 해제되지 않은 변경 요청 리뷰: ID, 작성자 ID, 상태, 작성자의 현재 권한
- 근거에 들어가지 않는 것: 봇 안내, 리뷰 요청, 일반 댓글. 따라서 이런 댓글은 digest를 바꾸지 않는다.
- 근거 댓글에 값이 없으면 게이트 평가가 실패한다.
- `fingerprint`(PR 상태)와 `evidenceDigest`(판정 근거)는 따로 둔다. 확인 댓글이 fingerprint를 담고 있어 근거를 fingerprint에 넣을 수 없기 때문이다. fingerprint 계산은 바뀌지 않았으므로 기존 `/review-gate` 확인과 `/merge-approve` 승인은 그대로 유효하다.
- 병합 도구는 지금 다시 계산한 digest가 게이트 check의 digest와 같아야 기존 게이트 성공을 신뢰한다.
  - `v`가 없는 이전 proof(v1)는 자동으로 v2로 인정하지 않는다. 게이트를 다시 실행하라고 안내하고 차단한다.
  - 근거가 바뀌었는데 게이트가 다시 실행되지 않은 경우(확인자 권한 변경 등 게이트 이벤트가 없는 변경)에도 차단한다.
- 게이트 재실행 방법: Actions에서 해당 PR의 최신 `Independent review gate` 실행을 다시 실행하거나, 관리자 댓글 등 게이트 이벤트를 일으킨다.

브라우저 수동 병합에서는 이 추가 출처·최신성 검증을 도구가 대신 실행하지 못하므로 실제 승인된 workflow 실행과 현재 결과를 사람이 확인해야 한다. 앱 고정·strict 보호·필수 사람 승인·직접 push 및 우회 제한을 함께 적용한다. 저장소 관리자 또는 승인된 자동화·인증정보 자체가 악의적인 경우까지 보호한다고 표현하지 않는다.

workflow 성공은 모든 PR이 병합 가능하다는 뜻이 아니라 평가 작업이 끝났다는 뜻이다. PR별 check run 결과를 확인한다. 조회 실패로 check를 게시하지 못하면 누락된 필수 검사를 통과로 취급하지 않는다.

draft·제목 규칙·metadata 오류 등 개별 PR 평가 실패는 해당 PR의 failure check에만 반영한다. 실패 check를 정상 게시했다면 다른 PR의 정상 판정과 실행 출처는 유지한다. check 생성 또는 실패 결과 게시 자체가 실패하면 실행 전체는 실패하되, 이후 PR 평가와 Summary 작성을 계속 시도한다. 끝내 게시하지 못한 check는 누락·진행 중 상태로 남으며 병합 통과로 취급하지 않는다.

남는 한계: 병합 API의 예상 head 지정은 PR 본문을 원자적으로 잠그지 않는다. 병합 도구는 최종 재검증한 본문을 메시지로 사용하지만 그 직후 GitHub 본문이 편집될 가능성은 남는다. 또한 공개된 runId·fingerprint가 검사와 실행 사이의 암호학적 증명은 아니다. 브라우저 병합에서의 출처 확인과 관리자·보고서 확인 모델의 한계는 위 설명대로 유지한다. 이번 버전에서 이를 해결했다고 표현하지 않는다.

## 4. 구독 리뷰 연동을 추가할 때

- [ ] 구독 리뷰 한도·추가 사용량 결제를 확인하고 유료 API·추가 결제로 전환하지 않도록 한다.
- [ ] Codex 저장소 전체 Automatic reviews를 끄고 필요한 PR만 명시적으로 요청한다. 구독에 GitHub 리뷰가 제공되는지도 계정에서 확인한다.
- [ ] Claude 구독 실행을 Actions에 연결하려면 공식 토큰과 Environment Secrets를 사용한다. 기본 게이트에는 토큰을 등록하지 않는다.
- [ ] 요청당 1회, 자동 재시도 0회, 동시 실행 제한, 영속적인 중복 방지와 실행 상한을 실제 구현·검증한다.
- [ ] 리뷰 실행 단계 외에는 AI 인증값을 전달하지 않는다. PR 코드 실행과 인증 디렉터리 읽기를 기술적으로 제한한다. 프롬프트만으로 보호했다고 처리하지 않는다.
- [ ] 일반 댓글·리뷰 요약·인라인 지적 이벤트를 수집하더라도 새 리뷰를 다시 요청하지 않는다. 요청과 결과 수집 경로를 분리한다.
- [ ] 로컬 중복 자동 리뷰와 저장소 전체 자동 리뷰를 동시에 켜지 않는다.
- [ ] 연동 실패면 현재 게이트의 수동 독립 검증 경로를 사용한다. 필수 검증을 생략하지 않는다.

## 5. 로컬 검증

```text
node --test .github/scripts/review-gate.test.mjs
node --test .github/scripts/review-shadow.test.mjs
node --test .github/scripts/merge-pr-core.test.mjs
node --test .github/scripts/merge-pr.test.mjs
git diff --check
```

프로젝트 CI의 Test/Lint/Build는 기술 스택 선택 이후 별도로 구성한다. 이 게이트가 프로젝트 기능 테스트를 대체하지 않는다.

병합 도구의 판정·병합·브랜치 정리 시나리오(`merge-pr-core.test.mjs`)는 가짜 gh·git 함수를 주입해 모든 OS에서 실행한다. 실제 CLI 진입점의 인수 전달(`merge-pr.test.mjs`)은 Linux에서 가짜 실행 파일로 확인한다. 이 프로젝트는 게이트·Shadow·병합 도구 테스트를 `npm run test:gate`로 함께 실행하며 Linux CI의 `verify`에 포함된다. Windows·macOS 로컬에서는 CLI 테스트를 건너뛰고, `CI` 환경에서 Linux가 아니면 실패한다. 실제 원격 병합이나 Windows에서 실행한 결과를 뜻하지 않는다. Windows 최초 도입 시 사람이 실제 병합 제목을 확인한다.

## 6. Shadow 판정(관찰용)

게이트 실행마다 기존 판정을 check에 게시한 **뒤** 위험도별 자동 판정 후보를 계산해 Actions Summary에만 기록한다. 기존 `independent-review` 결론, 필수 검사, 병합 도구와 브랜치 보호에는 영향이 없고 별도 check를 게시하지 않는다. Shadow 조회·형식 오류는 Summary에 `판단 불가`로 남기며 기존 판정을 바꾸지 않는다. 자동 승인·자동 병합·Codex 자동 호출은 없다.

설정은 `.ai/review-config.json`의 `shadow`다.

| 키 | 의미 |
|---|---|
| `enabled` | Shadow 판정 기록 여부 |
| `lowRiskPaths` | Low로 인정하는 정확한 경로·디렉터리 허용 목록. 모든 변경 파일이 목록 안이고 metadata가 low일 때만 Low |
| `highRiskPaths` | 기존 `highRiskPaths`에 더해 High로 올릴 경로 |
| `requiredChecks` | 성공해야 하는 check 이름과 게시 앱 ID |
| `codexReviewer` | 신뢰할 Codex GitHub 리뷰 봇의 로그인·사용자 ID·앱 ID |
| `maxReviewRequests` | PR당 `@codex review` 요청 상한 |

위험도는 metadata보다 낮아지지 않는다. metadata high, 민감 변경 `yes`, 고위험 경로, 의존성·잠금 파일 변경은 High다. 허용 목록 밖 파일이 하나라도 있으면 최소 Medium이다.

| 위험도 | 자동 판정 후보 조건 |
|---|---|
| Low | 필수 CI 성공, 해제되지 않은 변경 요청 없음, PR head가 최신 base를 포함(compare `behind_by` 0) |
| Medium | Low 조건 + 구현 Agent가 claude 또는 human(Codex 구현 PR은 Codex 리뷰가 독립 검증이 아니므로 후보 아님) + 최신 head에 대한 Codex GitHub 리뷰 완료 + critical·high·medium·심각도 불명 지적 0건 + 요청 상한 이내 |
| High | Medium 조건 + 사용자 승인 |

Codex GitHub 리뷰 판정 기준:

- 봇 계정 ID·유형·로그인과 댓글의 앱 ID가 설정과 모두 같아야 한다. 이름만 같은 댓글, 다른 앱, 일반 댓글·PR 본문의 PASS 선언은 무시한다.
- 상태 댓글의 `codex-review-state:v1`에서 `commit_sha`가 최신 head 전체 SHA와 같고 `status`가 `completed`여야 한다. `running`은 진행 중, 그 밖의 상태·형식 오류는 판단 불가다. 완료 상태에서 `has_any_findings`와 `has_unresolved_findings`가 모두 참·거짓 값이어야 하며, 지적 없음인데 미해결 지적 있음처럼 모순되면 판단 불가다.
- `has_any_findings: true`면 같은 head의 봇 리뷰와 인라인 댓글을 모두 모아 첫 줄의 `P0`~`P3` 배지로 critical·high·medium·low를 집계한다. 세부 지적이 없거나 배지를 해석할 수 없으면 통과 후보가 아니다. 해결(resolve) 표시는 집계를 줄이지 않는다.
- 봇 리뷰 본문도 확인한다. 본문은 실제 안내문(`### 💡 Codex Review`, 리뷰 대상 커밋, `About Codex in GitHub` 접힘 영역)과 배지 지적 줄로만 구성돼야 한다. 그 밖의 내용, 다른 커밋 표시, 해석하지 못한 배지가 있으면 판단 불가다. 본문 지적은 집계에 더하되, 같은 리뷰의 인라인 지적과 심각도·제목이 같으면 한 번만 센다. 지적 없음 상태인데 본문·인라인 지적이 있거나 지적 있음인데 하나도 없으면 판단 불가다.
- 최신 head 결과가 없고 사용량 한도 댓글이 있으면 한도 초과, 그 밖에는 결과 없음이다. 둘 다 통과가 아니다.
- 댓글·인라인 댓글 목록 수는 목록 조회 **뒤에** 다시 받은 PR 정보의 수와 같아야 한다. 다르면(누락·목록 조회 뒤 새 댓글) 또는 조회 중 head가 바뀌면 전체 조회 실패로 판단 불가다. 실제 PR #7에서 실행 중 추가된 Codex 봇 안내 댓글 때문에 조회 **전** PR 정보와 비교하던 이전 규칙이 Shadow를 판단 불가로 만든 문제를 고쳤다.

사용자 승인(High)은 `admin`·`maintain` 사용자가 최신 head 전체 SHA와 현재 fingerprint를 적은 `/merge-approve <head SHA> <fingerprint>` 댓글을 PR 본문·제목·base의 마지막 변경 이후에 작성한 경우다. 새 커밋, 본문·제목·base·파일 목록·기본 브랜치 정책이 바뀌면 fingerprint가 달라져 이전 승인은 무효다. Summary와 병합 도구 dry-run이 현재 상태의 승인 명령을 보여 주지만, 변경을 확인한 관리자가 직접 작성한다. 기존 `/review-gate` 확인은 리뷰 근거 확인이며 병합 승인으로 대신 인정하지 않는다. 기존 게이트는 `/review-gate`로 시작하는 최신 관리자 댓글을 확인으로 읽으므로 승인은 이와 겹치지 않는 별도 명령을 쓴다. 이전 형식(`/merge-approve <짧은 SHA>`)은 승인으로 인정하지 않는다. main이 앞서 나가면 head가 같아도 이전 승인·CI·리뷰는 이전 base 기준이므로, 모든 위험도에서 최신 base 반영 여부를 함께 요구하고 조회 실패는 알 수 없음으로 둔다. 병합 도구는 High 병합에 이 승인을 요구하지만(§7), 승인 댓글 자체가 병합을 실행하거나 기존 필수 검사를 대신하지는 않는다. 구현 Agent와 관리자가 같은 GitHub 인증을 공유하면 이 댓글이 실제 사람의 판단이라는 것을 기술적으로 증명할 수 없다.

같은 PR 상태에서는 이벤트가 중복되거나 순서가 바뀌어도 같은 결과가 나온다. Summary의 `새 요청 가능/불가`는 같은 head 중복·응답 대기·상한·한도 초과를 계산한 참고값이며 Codex를 실제로 호출하지 않는다.

요청 댓글에는 대상 SHA가 없다. 최신 head의 check suite 중 가장 이른 생성 시각을 그 head가 처음 보인 시각으로 보고, 그 이후 요청만 최신 head 요청으로 센다. 리뷰 결과는 상태 댓글의 `commit_sha`로만 head에 연결하므로 이전 head의 늦은 결과는 최신 head 요청을 해소하지 않는다. 최신 head 요청이 있는데 결과가 없으면 응답 대기로 보고 새 요청을 막는다. head가 처음 보인 시각이나 요청 시각을 확인할 수 없으면 새 요청을 막는다. 같은 커밋이 PR 전에 다른 브랜치로 먼저 push됐다면 이 시각이 실제보다 이르지만, 그 경우 더 많은 요청을 최신 head 요청으로 세므로 중복 요청 쪽으로 틀리지 않는다.

지원하지 않는 응답: 진행 중·지적 있음 상태 댓글의 새 형식, P0·P3 배지, 리뷰 본문 속 지적, 보안 리뷰(`security_review`) 결과는 실제 응답을 아직 관찰하지 못해 기존 관찰 형식에서 파생한 테스트만 있다. 봇 댓글 생성·수정은 게이트 실행을 일으키지 않으므로 Summary는 다음 게이트 실행 시점의 상태다.

## 7. 병합 도구

`.github/scripts/merge-pr.mjs`는 개발자 컴퓨터에서 명시적으로 실행하는 수동 squash 병합 도구다.

- workflow에서 호출하지 않고, Actions에 인증정보를 전달하지 않으며, 상시 실행되는 자동 병합이 아니다.
- 판정은 기존 게이트·Shadow 코드(`evaluatePR`, `evaluateShadow`)를 그대로 재사용하고, 정책은 기본 브랜치의 `.ai/review-config.json`만 읽는다.
- 위험도 기준 자동 병합과 Codex 리뷰 자동 요청은 이 도구에 없다. 두 기능은 각각 인증 분리(Phase 4)와 영속적인 요청 이력 설계(Phase 3b)가 확정된 뒤 별도 PR로 다룬다.

```text
node .github/scripts/merge-pr.mjs owner/repo PR번호 --dry-run                  # 조회만: 판정·막는 이유·정리 계획
node .github/scripts/merge-pr.mjs owner/repo PR번호 squash --head <SHA>        # 수동 병합(사용자 지시)
```

### 병합 조건

조회 실패, 형식 오류, 설정 누락은 모두 차단이다.

- PR 상태
  - open이고 draft가 아니다.
  - 제목이 규칙에 맞고, 기본 브랜치 대상이다.
  - `--head`를 지정했으면 현재 head와 일치한다.
  - head가 최신 base를 포함한다.
- 기존 게이트
  - `independent-review` 판정이 성공이다.
  - 검사 출처와 proof v2 근거 digest가 일치한다(위 "검사 출처와 병합 직전 확인").
  - 해제되지 않은 변경 요청이 없다.
- 필수 CI
  - `verify`가 현재 head에서 성공했다.
  - 그 결과가 기본 브랜치에 승인된 `.github/workflows/ci.yml`의 `pull_request` 실행에서 나왔다. PR에서 이 workflow가 바뀌었으면 High만 허용한다.
  - `gh pr checks --required`를 통과한다.
- 기본 브랜치 보호: strict, 필수 검사의 게시 앱 고정, 관리자 포함 적용(`enforce_admins`)이 확인된다.
- High: 관리자가 직접 작성한 `/merge-approve <head SHA> <fingerprint>`가 있다(§6).
- 판정 코드 고정: 도구가 실행하는 판정 모듈이 기본 브랜치의 같은 파일과 blob SHA로 같다.
  - 대상 모듈: `merge-pr.mjs`, `merge-pr-core.mjs`, `review-gate*.mjs`, `review-shadow*.mjs`. 작업 트리의 CRLF는 LF로 되돌려 비교한다.
  - 다르거나 기본 브랜치에 없으면 실제 병합을 차단한다.
  - 우회 옵션은 없다. 새 코드는 dry-run과 테스트로 확인할 수 있다. dry-run은 다른 판정을 모두 계산해 보여 주고 "판정 코드: 기본 브랜치와 다름(참고용 결과, 실제 병합 불가)"로 표시한다.
  - 테스트는 가짜 GitHub 응답으로 기본 브랜치 파일 SHA를 흉내 낼 뿐 검사를 건너뛰지 않는다.
  - 따라서 이 도구를 바꾸는 PR은 병합 전까지 바뀐 도구로 병합할 수 없다.

### 실행 순서

1. 같은 PR의 잠금 파일을 만들어 동시 실행을 막는다.
2. 첫 점검을 한다.
3. 실행 직전에 전체를 다시 점검한다. head, fingerprint, 근거 digest, 위험도가 그대로여야 한다.
4. 최종 재확인을 한다.
5. `gh pr merge --squash --match-head-commit <head>`로 병합한다.
6. 실제 병합 커밋 제목을 검증한다.
7. 병합 후 감사를 한다.
8. 브랜치를 정리한다.

### 최종 재확인

기존 게이트 판정 전체(`evaluatePR`: PR, 파일, 댓글, 리뷰, 작성자 권한)를 다시 계산한다.

- PR 변경 감지: `review-gate-core.mjs`의 `assertPullRequestUnchanged` 하나로 첫 점검을 시작한 PR과 비교한다.
  - 비교 값: PR 번호, state(open), draft(false), 제목, 본문, head·base의 SHA·브랜치·저장소, 변경 파일 수
  - 값이 하나라도 없으면 차단한다.
- 목록 완전성: 댓글 목록을 모두 받은 뒤 다시 읽은 PR의 댓글 수와 목록 수가 같아야 한다.
- 다시 계산한 값의 일치 조건
  - 게이트 판정이 성공이고, fingerprint와 근거 digest가 첫 점검·두 번째 점검과 같다.
  - 최신 게이트 check의 proof v2 digest와도 같다.
  - 필수 CI가 현재 head에서 성공이다.
- 근거는 댓글 수가 아니라 digest로 비교한다. 그래서 다음은 모두 차단된다.
  - 보고서·확인 댓글·승인 댓글의 수정·삭제(본문이 같아도 수정 시각 변경 포함)
  - 같은 본문을 다른 ID로 재작성
  - 확인자·승인자 권한 변경
  - 변경 요청 리뷰 추가
- 무관한 봇 댓글은 근거가 아니므로 막지 않는다.
- High는 같은 `evaluateApproval`로 head, fingerprint, PR 변경 시각 조건을 다시 판정하고, 두 번째 점검과 같은 승인 댓글이어야 한다.

### 남는 경합

- 최종 재확인과 병합 API 호출 사이의 변경은 도구가 막을 수 없다. GitHub 병합 API가 원자적으로 고정하는 것은 다음뿐이다.
  - head: `--match-head-commit`
  - 최신 base 반영: 기본 브랜치 보호의 strict 필수 검사
- 이 사이 일어날 수 있는 다음 변경은 병합 API가 막지 않는다.
  - 확인·보고서·승인 댓글 수정·삭제, 작성자 권한 변경, 변경 요청 추가
  - base 재지정, 제목·본문 변경
- 다른 브랜치로 재지정되면 그 브랜치의 보호 설정이 적용된다.
- 근거 변경은 병합 후 감사로 **감지만** 한다. 이 경합을 해결했다고 표현하지 않는다.

### 병합 실패와 사용하지 않는 옵션

병합 명령이 실패하면 실제 PR 상태만 다시 조회하고 재병합하지 않는다. 관리자 우회(`--admin`), GitHub auto-merge, `gh`의 `--delete-branch`는 사용하지 않는다.

### 병합 후 감사

병합과 제목 검증이 끝나면 댓글·리뷰·작성자 권한을 다시 조회해 같은 `collectReviewBasis`로 근거 digest를 계산하고, 병합 직전 값과 비교한다.

- 다르거나 확인할 수 없으면 `[심각]` 경고를 출력하고 종료 코드 1로 끝난다.
- 병합은 자동으로 되돌리지 않는다. 사람이 조사할 수 있도록 브랜치 정리도 하지 않는다.

### 브랜치 정리

병합, 제목 검증, 감사가 성공한 뒤에만 정리한다.

- 원격
  - 저장소 설정 Automatically delete head branches(현재 켜짐)로 지워졌는지 최대 3회 확인한다.
  - 남아 있으면 다음 조건이 모두 맞을 때만 `git push --force-with-lease=<ref>:<head>`로 삭제한다: fork가 아님, 기본·보호 브랜치가 아님, 다른 열린 PR의 head·base가 아님, 원격 SHA가 검증된 head와 같음.
  - push URL이 모두 대상 저장소인 로컬 원격만 사용한다.
  - 하나라도 불확실하면 지우지 않고 보고한다.
- 로컬
  - 다음 조건이 모두 맞을 때만 `git update-ref -d <ref> <head>`로 삭제한다: 대상 저장소를 가리키는 로컬 Git 저장소임, 브랜치가 검증된 head와 같은 SHA임, 현재 체크아웃이나 다른 worktree에서 사용 중이 아님, 작업 트리가 깨끗함.
  - 병합 직후에는 보통 작업 브랜치를 체크아웃하고 있으므로, 이 경우 건너뛰고 보고한다.

### dry-run

`--dry-run`은 다음을 출력한다.

- 위험도, 필수 검사와 출처, 독립 리뷰
- 사용자 승인 필요 여부와 승인 명령
- 기존 게이트와 검사 출처(proof v2)
- 판정 근거 digest, 판정 코드 일치 여부
- Shadow 자동 판정 후보(관찰용)
- 현재 병합 가능 여부, 막는 이유, 병합 후 정리 계획

병합, 댓글, 브랜치 삭제, 잠금 파일 생성을 하지 않는다. 종료 코드는 병합 가능하면 0, 그 밖에는 1이다.

### 해결되지 않은 위험

구현 Agent와 관리자가 같은 GitHub 인증을 쓰면 `/merge-approve`와 `/review-gate` 댓글이 실제 사람의 판단이라는 것을 기술적으로 증명할 수 없다. 같은 인증으로 근거 댓글을 고친 뒤 게이트를 다시 실행하는 것도 막지 못한다. 이 문제는 해결되지 않았다.

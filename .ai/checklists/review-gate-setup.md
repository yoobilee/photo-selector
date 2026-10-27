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
node --test .github/scripts/merge-pr.test.mjs
git diff --check
```

프로젝트 CI의 Test/Lint/Build는 기술 스택 선택 이후 별도로 구성한다. 이 게이트가 프로젝트 기능 테스트를 대체하지 않는다.

병합 도구의 테스트는 Linux에서 가짜 GitHub CLI로 인수와 판정 흐름을 확인한다. 이 프로젝트는 게이트·Shadow·병합 도구 테스트를 `npm run test:gate`로 함께 실행하며 Linux CI의 `verify`에 포함된다. Windows·macOS 로컬에서는 병합 도구 테스트를 건너뛰고, `CI` 환경에서 Linux가 아니면 실패한다. 실제 원격 병합이나 Windows에서 실행한 결과를 뜻하지 않는다. Windows 최초 도입 시 사람이 실제 병합 제목을 확인한다.

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
| Low | 필수 CI 성공, 해제되지 않은 변경 요청 없음 |
| Medium | Low 조건 + 구현 Agent가 claude 또는 human(Codex 구현 PR은 Codex 리뷰가 독립 검증이 아니므로 후보 아님) + 최신 head에 대한 Codex GitHub 리뷰 완료 + critical·high·medium·심각도 불명 지적 0건 + 요청 상한 이내 |
| High | Medium 조건 + 사용자 승인 |

Codex GitHub 리뷰 판정 기준:

- 봇 계정 ID·유형·로그인과 댓글의 앱 ID가 설정과 모두 같아야 한다. 이름만 같은 댓글, 다른 앱, 일반 댓글·PR 본문의 PASS 선언은 무시한다.
- 상태 댓글의 `codex-review-state:v1`에서 `commit_sha`가 최신 head 전체 SHA와 같고 `status`가 `completed`여야 한다. `running`은 진행 중, 그 밖의 상태·형식 오류는 판단 불가다. 완료 상태에서 `has_any_findings`와 `has_unresolved_findings`가 모두 참·거짓 값이어야 하며, 지적 없음인데 미해결 지적 있음처럼 모순되면 판단 불가다.
- `has_any_findings: true`면 같은 head의 봇 리뷰와 인라인 댓글을 모두 모아 첫 줄의 `P0`~`P3` 배지로 critical·high·medium·low를 집계한다. 세부 지적이 없거나 배지를 해석할 수 없으면 통과 후보가 아니다. 해결(resolve) 표시는 집계를 줄이지 않는다.
- 최신 head 결과가 없고 사용량 한도 댓글이 있으면 한도 초과, 그 밖에는 결과 없음이다. 둘 다 통과가 아니다.
- 댓글·인라인 댓글 수가 PR 정보와 다르면 전체 조회 실패로 판단 불가다.

사용자 승인(High)은 기존 관리자 확인이 통과했거나, `admin`·`maintain` 사용자가 최신 head SHA(7자 이상)를 적은 `/merge-approve <SHA>` 댓글을 PR 본문·제목·base의 마지막 변경 이후에 작성한 경우다. 기존 게이트는 `/review-gate`로 시작하는 최신 관리자 댓글을 확인으로 읽으므로 승인은 이와 겹치지 않는 별도 명령을 쓴다. 이 승인 형식은 현재 관찰용이며 병합 권한을 주지 않는다. 구현 Agent와 관리자가 같은 GitHub 인증을 공유하면 이 댓글이 실제 사람의 판단이라는 것을 기술적으로 증명할 수 없다.

같은 PR 상태에서는 이벤트가 중복되거나 순서가 바뀌어도 같은 결과가 나온다. Summary의 `새 요청 가능/불가`는 같은 head 중복·응답 대기·상한·한도 초과를 계산한 참고값이며 Codex를 실제로 호출하지 않는다.

지원하지 않는 응답: 진행 중·지적 있음 상태 댓글의 새 형식, P0·P3 배지, 보안 리뷰(`security_review`) 결과는 실제 응답을 아직 관찰하지 못해 기존 관찰 형식에서 파생한 테스트만 있다. 봇 댓글 생성·수정은 게이트 실행을 일으키지 않으므로 Summary는 다음 게이트 실행 시점의 상태다.

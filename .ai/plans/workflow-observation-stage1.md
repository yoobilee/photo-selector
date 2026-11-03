# 1단계: 관찰 전용 검증기

구현 Codex, 위험도 high. workflow-automation-transition.md의 A 단계만 구현한다.
main 979c65b 기준 독립 브랜치이며 PR12의 수집기·workflow·미병합 커밋에 의존하지 않는다.

## 범위와 사용

- workflow-observation-core.mjs: receipt의 엄격한 필드·현재 대상·정책·역할·집계·원문 hash·실행 출처를 주어진 API 관찰값과 비교한다. 위험 분류는 기존 classifyRisk를 재사용하며 rename 이전 경로도 검사한다. 제품 파일은 Claude 구현만 허용한다.
- 독립 리뷰 반영: 기존 describe와 같은 전체 의존성 파일 감지 계약을 회귀로 대조한다. src/public/e2e/HTML은 제품 경로이며, 일반 작업은 명시한 인프라·문서 경로만 허용한다. 미분류 경로는 차단한다. shadow 설정을 검증하고 metadata를 상태 본문과 대조한다.
- canonical JSON과 stateDigest: PR 대상·정책·제목·본문·squash 요약·파일·CI·리뷰·권한을 포함한다. before/after digest가 다르면 동시 변경으로 차단한다. 배열 순서는 보존하므로 API 순서만 바뀌어도 보수적으로 차단할 수 있다.
- observe: 항상 mode=observation-only, mergeAuthorized=false, approvalVerified=false, sourceAuthenticated=false다. candidate는 순수 입력 비교 결과일 뿐 실제 출처 인증·전체 API 수집·기존 게이트 통과나 병합 후보 확정을 의미하지 않는다.
- workflow-preflight.mjs: `npm run workflow:preflight -- yoobilee/photo-selector [settings.json]`. GitHub CLI의 명시적 GET만 사용한다. 관리자 인증 공유, 기존 보호, App 공개 권한, Environment required reviewers/self-review/우회 설정을 진단한다. raw API 오류와 인증값은 출력하지 않는다.

settings.json의 비밀 아닌 설정 예시(가짜 ID이며 실제 설정으로 사용하지 않는다):

```json
{
  "evidence": { "appId": 100, "slug": "ps-review-evidence" },
  "merger": { "appId": 200, "slug": "ps-merge-executor" },
  "executorUserId": 300,
  "approverId": 400
}
```

조회 실패·App 미설정·과다/누락 권한·동일 App·동일 실행자/승인자는 진단 오류다. exit1은 현재 환경이 미완성이라는 뜻이며 설정을 자동 생성하거나 수정하지 않는다. 문제가 없더라도 ready=false: OS/credential manager 격리, 실제 installation 권한, workflow 실행자와 환경 branch 정책, 승인 API 연결은 후속 통합 검증이 필요하다. 설정 파일의 ID 자체는 실제 workflow 실행자 인증 증명이 아니다.

Environment 설정 진단은 승인자 단독 reviewer 집합과 정확한 main branch 규칙도 확인한다. ready=false인 1단계 CLI는 진단 issues가 없어도 항상 exit1이며 셸의 성공 종료를 승인 신호로 사용하지 않는다.

## 순수 검증 계약

receipt 필드: v=1, target(repository/number/head/base/fingerprint), policyHash, role, reviewer, status, findings(critical/high/medium/low/unknown), report, reportHash, source(appId/installationId/runId/attempt/workflow/executorSha/resultId). 알 수 없는 필드는 거부한다. 완료·차단 지적0·신뢰 설정 일치·API 관찰 원본의 대상/정책/역할/집계/본문 hash/실행 일치를 모두 요구한다. attempt는 현재1만 지원한다.

stateDigest 입력은 target, policyHash, title, body, summary, files, checks, reviews, permissions를 빠짐없이 요구한다. fingerprint·정책 digest의 실제 API 계산과 전체 목록의 완전성 검증은 후속 신뢰된 collector의 책임이다. 파일에서 받은 apiEvidence나 trust를 신뢰된 API 응답으로 승격하는 코드는 없다. 이 모듈에 네트워크·게시·실행/서명 broker는 없다.

required CI의 이름·앱·workflow와 완료/성공/HEAD를 비교하지만 URL·실제 run·승인된 YAML을 조회하는 기존 병합 도구의 출처 검증을 대체하지 않는다. 관찰 판단을 기존 check로 게시하거나 승인 receipt로 사용하는 것은 금지한다.

이 단계의 reviews는 검증할 현재 receipt 한 개를 보존하는 배열이다. 다른/복수 근거나 원본 요청을 병합해 해석하지 않는다. 실제 API 전체 리뷰 수집·승인 API·영속 잠금/동시 실행·쓰기 재시도 제어는 다음 단계이며 이번 테스트가 실행했다고 주장하지 않는다. 별도 JSON Schema 파일 대신 런타임 strict-key 검증을 사용한다.

## 테스트와 검증

test:gate에 새 회귀 파일을 추가한다. 정상 일반 자체 리뷰, 제품 독립 리뷰, high 독립 리뷰/사용자 승인 필요, 위조 신원·실행·집계, 미인증 로컬, 오래된 HEAD/base/정책, 누락·미완료·실패 CI, 동시 변경·권한 변경·rename 위험 경계, App 분리·환경 설정 실패를 검증한다. 기존 게이트/병합 코드·workflow·review-config는 수정하지 않는다.

npm run verify와 Linux CI, Codex 자체 리뷰, 구현에 참여하지 않은 Claude 독립 리뷰가 완료 조건이다. 기존 independent-review의 관리자 확인 조건은 그대로 유지한다. 이 PR의 자체 결과로 그 게이트를 통과시키지 않는다.

## 다음 단계와 실제 사용자 작업

다음 단계에서 실제 App ID/installation ID, 전용 issuer·gate·merger 권한을 확정하고 격리된 실행 broker와 API adapter를 연결한다. issuer의 서명이나 App 게시만으로 임의 로컬 JSON을 실제 리뷰 실행으로 인증하지 않는다.

관리자는 App 설치와 비밀 보관 위치, 별도 OS/기기의 승인 계정, Environment photo-selector-high-risk-merge의 required reviewer·prevent self-review·관리자 우회 금지·main 제한을 설정해야 한다. App/Environment 생성이나 권한 확대는 이번 단계에서 실행하지 않는다. 고위험 승인 API와 해당 run/attempt·불변 stateDigest 결합은 후속 단계의 실제 승인/거절·재실행 테스트가 필요하다.

롤백: 새 진단·관찰 모듈 사용을 중지한다. 기존 보호와 게이트는 전혀 바뀌지 않아 전환 작업이 필요 없다. 자동 병합·AI 자동 호출·추가 API 과금은 도입하지 않는다.

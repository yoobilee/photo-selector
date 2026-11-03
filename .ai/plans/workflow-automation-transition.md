# 개발·리뷰·승인·병합 자동화 전환안

작성: 2026-11-03, Codex. 상태: 구현 가능한 설계안, 운영 미활성화.
위험도: high. 적용 전 별도 독립 검증과 실제 사용자 최종 승인이 필요하다.
기준 main: 979c65b1278ab71c8f706b09866679ce8c1bd7ed.
기존 photo-selector-workflow/.ai/WORK_PLAN.md의 인증 분리·승인·자동 병합 후속 단계를 구체화한다. 원본 계획과 PR12는 수정하지 않는다.

## 1. 현재 관찰과 근본 원인

- PR12 OPEN/non-Draft, HEAD 48c96f3b482657301f43d3d8fb5645515e270d9b. 아직 병합하지 않는다.
- 현재 API 인증의 저장소 permissions.admin=true. Agent와 관리자의 인증 경계가 분리되지 않았다. 같은 계정의 별도 토큰이나 브라우저 탭은 보안 격리가 아니다.
- 현행 decide는 관리자 보고서 및 /review-gate를 요구하고, high 병합은 별도 /merge-approve를 요구한다. 보고서의 실제 AI 실행 여부는 사람이 확인하는 모델이다.
- main 보호: verify 및 independent-review를 GitHub Actions 앱15368에 고정, strict=true, enforce_admins=true. required_approving_review_count=0이며, 현재 실제 사람 판단은 댓글 계약에 의존한다.
- Environment 조회 결과0개. PR12 봇 보고서 기능도 아직 main에 없고, 그 기능만으로 관리자 승인 대체는 불가능하다.
- 일반 GitHub Actions 봇 신원만으로 workflow를 구별할 수 없다. 로컬 JSON을 그 봇으로 재게시하거나 서명만 추가해도 독립 리뷰의 실제 실행을 증명하지 못한다.

## 2. 확정할 목표 정책

| 작업 | 구현 | 필수 리뷰 | 최종 사용자 행동 |
|---|---|---|---|
| 일반 인프라·문서·보조 도구 low/medium | Codex | 실제 자체 리뷰 receipt + CI | 없음, 조건 충족 시 자동 squash |
| 제품 기능 low/medium | Claude Code | Codex 독립 리뷰 receipt + CI | 없음, 조건 충족 시 자동 squash |
| 보안·권한·게이트·CI/CD·병합 도구 및 그 밖의 high | 구현 담당자 | 구현에 참여하지 않은 reviewer + CI | 최신 대상 요약을 읽고 승인 화면에서 한 번 승인 |
| 위험도·구현 참여자 불명, 혼합 작업, fork, 미지원 출처 | 자동 허용 없음 | 근거 보완/별도 분류 | 미완료 상태로 차단 |

경로·의존성·의미상 민감 변경은 high를 강제하며 metadata로 낮출 수 없다. 문서라도 검증 정책 변경은 high다. 제품/일반 분류는 경로 규칙과 실제 diff의 일치가 필요하며 제품 코드가 섞이면 제품 경로를 적용한다. 같은 AI 자체 리뷰를 high 독립 리뷰로 승격하지 않는다. 필요 독립 리뷰가 한도·형식·인증 문제로 미완료면 자동 병합하지 않는다.

## 3. 인증 주체와 권한 결정안

전용 GitHub Apps는 Photo Selector 단일 저장소에만 설치한다. 아래 이름은 예약 후보이며 실제 app ID/installation ID는 생성 후 읽어 고정한다. 미설정 ID는 거부한다.

| 주체 | 권한 | 보관·실행 위치 / 금지 |
|---|---|---|
| ps-implementation | Contents write, Pull requests write, Metadata read | Agent 전용 OS 계정/격리 VM. Administration·Checks write·승인자 자격 없음. workflow 수정 권한은 별도 high 작업용 토큰 정책으로 검토; main 직접 push는 보호로 금지 |
| ps-review-evidence | Contents/PR/Actions read, Issues write, Checks write | 신뢰된 실행 broker의 게시 단계에만 짧은 installation token. 리뷰 결과와 receipt만 기록; 승인·병합 불가 |
| ps-policy-gate | Contents/PR/Issues/Actions read, Checks write, Administration read | 승인된 main의 검증 job만. 보호 조회 권한은 read뿐. gate check 전용, 관리자 승인 API 호출 금지 |
| ps-merge-executor | Contents/PR write, Issues/Actions/Checks/Administration read | 승인된 main의 최종 실행 단계만. high는 보호된 환경 통과 후에만 발급. Administration write·Actions write·보호 우회 없음 |
| 실제 관리자 | 현재 소유자 계정의 GitHub 웹 승인 | Agent가 읽거나 조작할 수 없는 별도 OS 사용자/기기. 토큰·브라우저 프로필·credential manager 접근도 격리 |

GitHub App 설치 토큰이 특정 작업 브랜치만 쓰도록 제한된다고 가정하지 않는다. main 보호·필수 검사·PR 강제와 승인된 실행 코드로 보완한다. App 자체는 승인자 목록에 넣지 않는다. 구현 App은 gate App의 토큰·키·승인 이력 생성 권한을 가져서는 안 된다.

현재 관리자 credential은 필요한 별도 App 설치·검증이 끝난 뒤 Agent 환경에서 제거/회수한다. 이 전환은 사용자 관리 작업이며 이 계획에서 실행하지 않는다. 같은 OS 계정에 관리자 자격이 남으면 분리 완료로 판정하지 않는다.

App 개인키는 로컬 checkout이나 저장소 일반 secret으로 흩뿌리지 않는다. 신뢰된 broker/job의 제한된 Environment secret에서만 토큰을 발급한다. 보호된 환경을 다른 workflow가 참조할 위험은 default-branch 코드 신뢰 경계로 관리한다. 승인된 main 자체가 악성일 때까지 안전하다고 주장하지 않는다.

## 4. 리뷰 실행과 근거 등록

실행 → 구조화 결과 확인 → receipt 생성 → 전용 App 게시 → gate 재수집으로 분리한다. 게시가 실행의 증명은 아니다.

- 기존 신뢰할 Codex GitHub 리뷰는 app/user ID, 저장소·현재 HEAD, 실제 완료 상태, 전체 요약·리뷰·인라인과 수정·기각을 API에서 검증한다.
- Codex 자체 리뷰와 로컬 Claude 리뷰는 **전용 실행 broker가 직접 실행하고 결과를 포착**해야 한다. 임의 result.json 업로드를 인증 receipt로 바꾸는 endpoint는 만들지 않는다. PR12의 미인증 로컬 게시 차단을 유지한다.
- broker는 승인된 프롬프트·정책·읽기 전용 스냅샷을 사용하고, 구현 프로세스와 다른 실행 권한을 가진다. PR 코드·설치·테스트·hooks·MCP·임의 도구를 리뷰 인증과 함께 실행하지 않는다. 네트워크·도구 제한은 프롬프트 문구가 아닌 실행 격리로 검증한다.
- receipt 필드: schema, repository ID, PR, base/head, 작업 종류·위험도, 구현 참여자, reviewer·self/independent, provider/session 또는 실제 API 원본 ID, executor 버전·workflow/run/attempt, 정책/프롬프트 digest, reportHash, 완료 상태, 전체 findings, 시작·종료 시각, 유일 request ID, issuer app ID.
- 전용 App의 check가 원본 receipt/report digest를 가리키고, gate는 API 신원·원본·내용을 검증한다. 임의 공개 run ID나 본문 서명만으로 인정하지 않는다. 동일 App의 key 유출은 별도 신뢰 침해이며 회수 후 해당 receipt를 무효화한다.
- 요청 중복 방지는 저장소/PR/base/head/정책/reviewer request ID로 영속 기록한다. 완료 상태를 저장하기 전에 중단되면 실제 run/check/comment부터 조회한다. 성공 불명확한 쓰기·AI 호출은 자동 재시도하지 않는다.
- 기존 구독만 사용한다. Claude/Codex의 무인 구독 실행 방식과 격리를 실제로 확인하기 전에는 broker를 활성화하지 않는다. 추가 API·추가 사용량 결제·자동 fallback은 금지한다. 이 연결이 미구현이면 완전 자동화를 달성했다고 보고하지 않는다.

## 5. /review-gate 대체

독립 리뷰 여부, 실제 완료·전체 지적, CI 출처, 변경 요청 리뷰, 정책·판정 코드 버전을 자동 평가한다. 일반 Codex 작업은 자체 리뷰 receipt가 요건이고, 제품·high는 독립 receipt가 요건이다. critical/high/medium/unknown은 차단, low는 근거와 후속 관리 기록을 남긴다.

표시용 보고서는 ps-review-evidence가 자동 등록한다. 승인에 쓰는 기준은 관리자 댓글도 본문의 PASS 문구도 아닌 검증된 receipt와 실시간 API 상태다. ps-policy-gate가 자동 판정을 check로 게시한다. /review-gate를 봇이 대신 쓰는 방식은 사용하지 않는다.

check는 최종 high 사용자 승인 전에는 success가 될 수 없다. low/medium은 충분한 자동 근거만으로 success를 허용한다. 필수 check와 merge executor가 같은 판정 함수를 사용한다.

## 6. /merge-approve 대체: 사용자 승인 화면

GitHub Environment `photo-selector-high-risk-merge`를 사용한다.

- required reviewer는 실제 관리자 user ID, prevent self-review=true, administrator bypass=false, 허용 deployment branch는 정확한 main만.
- 실제 workflow 시작 주체는 자동화 App으로 한다. 관리자가 직접 시작하고 self-review 금지에 걸리면 규칙을 끄지 말고 올바른 주체로 새 실행을 준비한다.
- GitHub Actions 실행 Summary와 승인 job에 PR 링크, 변경 요약, base/head, 위험 이유, CI·독립 리뷰 링크, 차단 지적 수, squash 제목·본문, stateDigest를 표시한다. 사용자에게 숫자를 옮기게 하지 않는다.
- 정상 사용자 흐름은 알림 링크 → Review deployments → 해당 환경의 Approve and deploy. 별도 댓글·명령어·추가 PR 승인 버튼을 요구하지 않는다. 거절하면 병합하지 않는다.
- 배포의 GitHub SHA는 main일 수 있으므로 이것을 PR HEAD 승인으로 간주하지 않는다. **승인 전에 고정한 PR 상태 digest를 해당 run/attempt·환경 ID에 결합**한다. 승인 후 최신 HEAD를 새로 채택하지 않는다.
- 서버 API의 review history에서 실제 승인자 ID·environment·run·시각을 확인한다. 승인 전 artifact/receipt digest, run/attempt 연결과 rerun 시 승인 재사용 방지를 실제 응답 fixture로 검증한다. API로 확정 못 하면 차단한다.
- high 승인 job에서만 merger 토큰을 발급하고, 승인 직후·병합 직전에 새 상태와 승인 전 digest가 같은지 비교한다. 변경 시 실행을 취소하고 새 승인 요청을 만들며 이전 승인을 재사용하지 않는다.

환경 보호는 공개 저장소에서 지원되는 공식 기능이지만, 저장소에서 실제 설정·권한·승인 API·self-review 동작 검증을 거친 뒤 사용한다. 단순 환경 생성만으로 사용자 인증 격리를 달성했다고 보지 않는다.

## 7. 자동 병합과 최신성 계약

stateDigest는 저장소/PR/base/head, 제목·본문·검증된 squash 요약, 파일 목록, 정책/판정 코드 SHA, 위험도/구현자, CI check ID·앱·run·attempt·결론, receipt ID·reportHash·원본 수정 시각, 유효 변경 요청·현재 권한으로 계산한다. 승인 receipt 자체는 이 digest에 포함하지 않아 순환을 피한다.

기본 브랜치의 고정 코드만 API 조회·조건부 squash를 실행한다. PR별 단일 실행 잠금, head 예상값, strict 보호, 필수 검사 성공을 요구한다. 파일·base·본문·리뷰·CI 재실행·권한·승인 취소 중 하나가 바뀌면 이전 승인은 무효다. 일반 작업도 동일 최신성 검사를 통과한 경우만 자동 병합한다.

squash 제목은 검증된 PR 제목, 본문은 검증된 변경 요약·테스트·리뷰·남은 제한·의도한 Issue 종료 키워드다. 전체 게이트 JSON이나 로그를 붙이지 않는다. 요약 hash도 승인 대상에 포함한다. 병합 후 PR API merge_commit_sha로 제목·본문·main 포함 여부와 당시 근거를 감사한다. 감사 실패는 브랜치 정리를 멈추고 실제 병합 사실과 경고를 보고한다.

GitHub 병합 API의 HEAD 고정은 base/본문/리뷰/권한 전체를 원자적으로 고정하지 않는다. 마지막 조회 이후의 경쟁 구간이 남음을 명시하며 strict 보호·최종 재조회·사후 감사를 모두 유지한다. 이것을 해결한 것처럼 표시하지 않는다.

## 8. 전환 PR 순서와 활성화 조건

| 단계 | 독립된 작은 PR | 완료·활성화 조건 |
|---|---|---|
| A (바로 다음) | 순수 schema/정책 분류/stateDigest/receipt 검증기와 fixture 테스트, 읽기 전용 설정 진단 | main 기준으로 구현. 새 workflow·secret·check 게시·승인·병합 없음. 자동 판정은 관찰 출력만. 기존 게이트 계속 사용 |
| B | 전용 App 신원·설정 검사와 격리된 리뷰 실행/게시 연결 | 사용자 App 설치 및 인증 격리, 필요한 구독 실행 1회·실패·위조·중복 검증. 미인증 입력은 계속 차단 |
| C | v2 게이트를 비필수 shadow check로 병행 | 기존/새 판정의 차이를 기록. 정상·공격 fixture와 실제 canary 통과, high 독립 리뷰 및 사용자 승인 |
| D | high Environment 승인과 merge executor의 dry-run | 실제 사용자 승인/거절·재실행·stale 처리 검증. 실제 병합과 legacy 승인은 계속 기존 정책 |
| E | 사전 승인된 통제 전환 | verify 유지. 먼저 새 전용 App check를 추가 필수로 설정하고 검증. 새 check가 모든 조건을 강제한 뒤 기존 independent-review의 명칭/앱 계약 전환 또는 legacy 필수 해제를 한 번의 감사 가능한 전환 절차로 수행. 보호 공백 금지 |
| F | low/medium 자동 squash, high 승인 후 자동 squash 활성화 | App 인증 격리·서버 승인·새 필수 gate·사후 감사 모두 검증. 대상별 점진 canary, 오류 시 중단 |

E는 기존 고정 앱15368 검사 계약과 관리자 댓글 계약을 **명시적으로 대체하는 보안 정책 변경**이다. 기존 검사를 영구 유지하며 댓글 요구만 사라진다고 주장하지 않는다. 대체 전에는 해제하지 않고, 등가 이상의 자동 근거·실제 승인 통제를 강제한 후 전환한다. 이 계획은 해당 설정을 바꾸는 실행 승인이 아니다.

전환 PR 자체는 high다. 새 정책을 이용해 자기 변경을 사전 승인하는 순환을 금지한다. 사용자에게 검토 가능한 고정된 전환 대상·보호 설정 diff를 제공하고, 격리된 관리자 화면에서 실제 승인 후 적용한다. 현행 정책이 그 전환에 요구하는 별도 승인 기록의 대체 여부도 이 최초 전환의 명시적 결정 대상이다. AI가 관리자 댓글을 생성해 순환을 풀지 않는다.

PR12는 현상 유지한다. A는 PR12에 의존하지 않아 먼저 구현할 수 있다. 이후 PR12를 병합하거나 새 구조에서 다시 검증할 때는 변경된 base/HEAD와 신뢰할 실행 receipt를 새로 확보한다. 기존 로컬 보고서를 사후에 인증된 것처럼 재게시하지 않는다. PR12의 최초 실제 봇 게시 canary도 적합한 OPEN PR이 없으면 미완료로 둔다.

## 9. 바로 다음 PR A의 파일·테스트·완료 조건

후보 파일: `.github/scripts/review-receipt-core.mjs`, `workflow-policy-core.mjs`, 대응 `*.test.mjs`, `.ai/schemas/review-receipt.schema.json`, 읽기 전용 `workflow-preflight.mjs`. 정확한 최종 파일 수는 기존 함수 재사용 여부에 따라 최소화한다. 기존 gate/merge 진입점에는 연결하지 않는다.

| 테스트 | 기대 |
|---|---|
| 일반 Codex self + 성공 CI / 제품 Claude + Codex independent | 올바른 경로만 자동 병합 후보, 실제 병합 호출0 |
| high self-only, unknown 구현자, 혼합 sensitive 경로 | 차단 또는 high 강제 |
| 봇 이름만 복사·잘못된 app/installation·다른 repo/run·임의 로컬 JSON | 거부 |
| 미실행·스킵·한도·빈 결과·집계 누락·medium/unknown | 거부 |
| HEAD/base/본문/요약/정책/원본 수정·삭제·CI 재실행 | stateDigest 변경, 이전 receipt/승인 무효 |
| 승인자 위장·자기 승인·취소·거절·다른 환경/run/attempt·만료 | 차단 |
| 두 실행 동시 시작·중복 이벤트·응답 유실 | 한 건만 상태 전이, 외부 성공 여부 확인 전 재시도 금지 |
| 보호 조회 실패·App 미설정·권한 과다·승인 API 불명 | fail-closed 진단, 임의 권한 수정0 |
| 모든 준비·shadow 경로 | 승인/댓글/병합/보호 변경 API 호출0 |

A는 mock fixture 테스트와 관련 전체 verify/Linux CI, 자체 리뷰, high 독립 리뷰 후 별도 PR로 제출한다. 테스트 계획만 작성된 현재 상태는 이 테스트들이 통과했다는 뜻이 아니다. B~F의 실제 토큰 격리·사용자 화면·API canary는 별도 통합 테스트이며 fixture로 대체하지 않는다.

## 10. 장애·롤백·사용자 작업

전환 전: 새 관찰 경로만 중지하면 기존 게이트가 유지된다. 전환 후: 새 자동 병합부터 중지하고, legacy 필수 검사 및 승인 경로를 복원·검증한 후에만 새 검사를 해제한다. 두 경로 모두 불명확하면 병합을 차단한다. 이미 병합된 변경을 자동 재작성하거나 강제 push하지 않는다.

사용자의 일회성 설정: 관리자 인증 격리, 전용 App 설치/ID 승인, Environment reviewer·self-review/우회 금지 설정, 고정된 보호 전환 diff 승인. 실행 가능한 자동화 없이 설정만 요구하지 않는다. 각 설정은 직전 단계의 코드·테스트·dry-run 결과를 먼저 제시한다.

완료 후 사용자는 일반 작업에서 추가 행동0, high 작업에서 최신 요약의 실제 승인1회만 한다. SHA/해시·보고서 등록·게이트 확인·squash 메시지·병합·감사는 자동 처리한다. 변경으로 승인이 무효화되면 새 변경에 대한 승인이 필요하다. 최초 승인 하나가 미래 모든 변경을 허용하지 않는다.

## 11. 공식 근거 (2026-11-03 재확인)

- [Environment 설정](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments): 공개 저장소 지원 및 보호 설정.
- [승인 화면](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/review-deployments): Review deployments/Approve and deploy, 자기 승인 및 관리자 우회 제어.
- [Workflow run API](https://docs.github.com/en/rest/actions/workflow-runs): 승인 이력과 실제 run 조회. 실제 응답의 attempt 결합은 구현 canary에서 검증해야 한다.
- [보호 브랜치 API](https://docs.github.com/en/rest/branches/branch-protection): 필수 검사 앱 고정과 보호 조회 권한.
- [execution protections 변경 공지](https://github.blog/changelog/2026-09-17-workflow-execution-protections-in-github-actions-generally-available/): 영향받는 공개 저장소의 pull_request_target 기본 차단 강제 일정은 2026-12-02. 현재 게이트는 이 이벤트를 사용한다. Insights/evaluate 결과를 먼저 확인하고 필요한 승인된 workflow만 좁게 허용하는 전환을 설계한다. 전역 보호 해제나 PR 코드의 privileged 실행으로 해결하지 않는다.

현재 작성 범위: 설계 문서만. App/Environment/보호 규칙·PR12·기존 main 미커밋4파일·AI 과금 설정은 변경하지 않았다.

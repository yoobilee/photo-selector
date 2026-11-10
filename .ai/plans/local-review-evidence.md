# 로컬 독립 리뷰 결과 게시 계획

- 구현: Codex. 기준 main `4c97943998ea77c33da677f13ae905484da2df58`. 위험도: 높음(게이트·workflow·신뢰 경계).
- 사용자 확인: 2026-11-11 요청에서 안전한 범위 구현, 전체 검증, commit/push/Draft PR까지 승인. 관리자 확인·병합은 미승인.
- 완료 조건: 기존 native Codex 플러그인 1회의 결과를 수집해 미인증 표시로 Actions 봇 게시, 영수증과 직접 관리자 확인 검증, 기존 수동 보고서/병합 계약 유지.

## 방식과 범위

기존 게시 workflow와 CLI를 확장한다. 로컬 수집 wrapper는 같은 Claude 세션에서 기존 plugin을 호출하며 base/head별 ledger·lock으로 같은 리뷰를 다시 실행하지 않는다. 게시 후 댓글 링크·본문 해시와 직접 작성할 `/review-gate`를 출력한다. 추가 모델 호출·외부 서비스·의존성은 없다.

관리자 개인 인증으로 댓글을 직접 쓰는 대안과 봇 신원만 믿는 대안은 제외한다. 승인된 기본 브랜치의 workflow 실행과 댓글 ID·내용 hash를 이름으로 묶은 artifact metadata를 함께 검증한다. 영수증은 게시 경로의 근거이며 로컬 실행의 인증서가 아니다.

주요 파일: `review-evidence*.mjs`, `review-plugin-cli.mjs`, `review-gate*.mjs`, `merge-pr-core.mjs`의 승인 코드 목록·감사 adapter, 게시/게이트 workflow, 관련 테스트·문서·npm scripts.

## 위험과 대응

- 로컬 결과·ledger는 위조 가능: 항상 미인증, 관리자 직접 원문·실행·독립성 확인 필수. 봇 보고서만으로 통과 불가.
- 동일 Actions 앱의 다른 workflow 위장: 승인된 workflow/코드 SHA, 최초 attempt, repo/ref, success와 API가 run에 연결한 영수증 확인. 실패·수정·누락·만료는 차단.
- 리뷰/게시 후 PR 변경: 최신 대상·전체 본문 fingerprint·정책 SHA 비교. 쓰기 직전 PR 재조회. API 호출 직후 경합은 제거됐다고 주장하지 않는다.
- 불명확한 쓰기: 재시도하지 않고 실제 댓글·영수증 재조회. 댓글만 있고 영수증이 없으면 차단.
- 인증 공유: 관리자와 Agent의 인증 격리는 미해결. 전용 App/비관리자 실행 인증과 사람 전용 승인 환경은 별도 사용자 설정이며 임의 변경하지 않는다.
- 롤백: wrapper 중단, 변경 revert 후 기존 수동 보고서 절차 복귀. 사진/DB 변경 없음.

## 검증

완료·실패·중단·한도·대상 변경·중복·위조·댓글 실패·영수증·관리자 없는 통과·기존 게이트/병합 회귀 테스트. 전체 `npm run verify`, diff 확인, 보존 파일/브랜치/평가 metadata 대조. Claude 독립 검토를 시도하고 미완료면 Draft에 명시한다. 새 workflow는 main 승인 전 활성화하지 않는다.

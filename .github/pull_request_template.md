<!-- ai-review
implemented-by: unknown
risk: high
sensitive-change: yes
-->

<!-- 위 영역이 구현자·위험도의 유일한 입력입니다. implemented-by: claude/codex/human/unknown, risk: low/medium/high, sensitive-change: yes/no. 미정 값은 안전한 기본값으로 남겨두되 병합 전에 실제 값으로 정리하세요. 제목은 feat/fix/chore/refactor/test/docs 접두사와 한국어 설명을 사용하세요. -->

## 변경 목적

<!-- 이 PR이 해결하는 문제와 목표를 적어주세요. -->

## 변경 범위

### 포함

-

### 포함하지 않음

-

## 위험도

metadata에 선택한 위험도의 판단 근거:

인증·권한·보안·결제·개인정보·DB·핵심 로직·CI/CD 변경은 높은 위험으로 분류합니다.

## 사용자 영향

- 기능·UI의 추가, 변경 또는 삭제:
- 호환성·반응형 영향:
- 접근성 영향:

## 검증 결과

| 검사 | 명령 | 결과 |
|---|---|---|
| Lint |  | 미실행 |
| Type Check |  | 미실행·해당 없음 |
| Test |  | 미실행·해당 없음 |
| Build |  | 미실행·해당 없음 |
| 화면·브라우저 |  | 미확인·해당 없음 |
| 접근성 수동 확인 |  | 미확인·해당 없음 |

실행하지 못했거나 실패한 검사:

## 보안·데이터·의존성

- [ ] 인증·권한 변경 없음
- [ ] 민감정보가 코드와 Git 이력에 포함되지 않음
- [ ] 데이터 구조·마이그레이션 변경 없음
- [ ] 새 핵심 의존성·유료 서비스·외부 SaaS 없음
- [ ] 잠금 파일 변경이 의존성 변경과 일치함

해당 변경 및 롤백 방법:

## CI/CD

- [ ] `.github/workflows/` 등 CI/CD 변경 없음
- [ ] CI/CD 변경이 있으며 높은 위험으로 분류하고 사람 확인을 받음
- [ ] fail-closed 조건을 확인함

## 독립 AI 검증

리뷰 보고서 링크 또는 미실행 사유:

<!-- reviewer·최신 SHA·통과 상태는 PR 본문에 중복 입력하지 않습니다. Actions Summary와 independent-review 상태가 판정 결과입니다. 사람이 실제 보고서를 확인하고 .ai/checklists/review-gate-setup.md의 확인 댓글을 작성합니다. -->

## 알려진 문제와 백로그

- 없음

## 배포·릴리스

- [ ] 버전 배포 없음
- [ ] `CHANGELOG.md` 갱신 필요
- [ ] `PATCH_NOTES.md` 갱신 필요
- [ ] 버전 기준 파일 갱신 필요
- [ ] `git tag vX.Y.Z`와 tag push 필요

버전과 배포 계획:

## 병합 확인

- [ ] 필요한 로컬 검증 완료
- [ ] 현재 변경이 포함된 상태에서 최신 검증 결과 확인
- [ ] CI 통과
- [ ] 필요한 리뷰와 사람 확인 완료
- [ ] 최신 변경의 `independent-review` 상태와 필수 CI 통과
- [ ] 병합 제목이 PR 제목과 일치하며 병합 후 실제 커밋 제목 검증 예정
- [ ] 자동 병합을 사용하지 않음

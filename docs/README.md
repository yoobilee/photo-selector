# 문서 목차

| 문서 | 내용 |
|---|---|
| [README](../README.md) | 제품 소개, 현재 기능, 핵심 한계, 실행 방법 |
| [제품 가이드](product-guide.md) | 기능 상세 동작, HEIC 지원·실기기 관찰, 계획한 기능 |
| [판정 구조](architecture.md) | 흐림·비슷한 사진 판정 방식, 임계값 근거, 알려진 한계 |
| [평가 가이드](evaluation-guide.md) | 평가 도구, 정답 데이터 형식, 1차 평가(18장) |

## 평가·실험 기록

날짜별 기록입니다. 수정하지 않고 후속 기록이 앞 기록을 참조하는 방식으로 쌓습니다.

| 문서 | 내용 |
|---|---|
| [iPhone 분석 불가 조사](sharpness-investigation.md) | 2026-11-08. 분석 불가 발생 경로, 합성 재현, 실제 사진 검증 절차 |
| [공개 실제 사진 평가](sharpness-real-photo-evaluation.md) | 2026-11-09~10. 판정 규칙 3(1/2 크기 재판정) |
| [브라우저 독립 축소](sharpness-browser-consistency.md) | 2026-11-13~15. 판정 규칙 4 |
| [1/2 크기 흔들림 보완](sharpness-half-scale-shake.md) | 2026-11-17. 판정 규칙 5, iPhone Safari 확인 목록 |
| [짧은 손떨림 한계](sharpness-short-shake-limits.md) | 2026-11-21. 짧은 실제 손떨림 미검출 원인 |
| [상대 비교 평가(기각)](sharpness-similar-group-comparison.md) | 2026-11-21. 묶음 안 선명도 상대 비교 |

평가 원본 사진·캐시는 저장소 밖 `DocumentsPhoto Selector Archiveevaluation-archive`에 있으며 저장소에 넣지 않습니다.

## 개발·리뷰·병합 절차

작업 규칙의 기준은 [AGENTS.md](../AGENTS.md)이고 세부 정책은 `.ai/`에 있습니다. 이 목차는 위치만 안내하며 정책 내용은 해당 문서가 기준입니다.

- 위험도·테스트·독립 검증·CI: [verification.md](../.ai/policies/verification.md)
- 리뷰 자동화: [review-automation.md](../.ai/policies/review-automation.md)
- 커밋·PR·병합 메시지와 병합 후 정리: [git-messages.md](../.ai/policies/git-messages.md)
- 버그·실패 원인 분석: [debugging.md](../.ai/policies/debugging.md)
- 디자인 방향: [design-direction.md](../.ai/policies/design-direction.md)
- 멀티 에이전트 협업: [multi-agent-collaboration.md](../.ai/policies/multi-agent-collaboration.md)
- 리뷰 게이트 설정·Shadow 판정·병합 도구: [review-gate-setup.md](../.ai/checklists/review-gate-setup.md)
- 리뷰 자료 자동 수집·봇 보고서 등록(`npm run review:prepare -- owner/repo PR번호`): [review-evidence.md](../.ai/checklists/review-evidence.md). 미인증 로컬 결과는 파일 출력까지만 허용하며 봇으로 게시하지 않습니다. 기존 관리자 확인·승인·병합 절차는 유지합니다.
- 로컬 독립 리뷰 결과 자동 게시, 차단 시 관리자 검토 자료, Codex 플러그인 리뷰 요청: [local-review-publishing.md](local-review-publishing.md)
- 새 프로젝트 설정: [project-init.md](../.ai/checklists/project-init.md)
- 과거 PR의 작업 계획·전환 설계 기록: [`.ai/plans/`](../.ai/plans/) (기록용이며 현재 정책이 아닙니다)
- 후속 확인 항목: [BACKLOG.md](../.ai/BACKLOG.md)

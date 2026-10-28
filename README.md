# Photo Selector

여러 장의 사진에서 실패한 사진과 유사 사진을 구분하고 좋은 사진을 추천하는 웹앱입니다. 최종 선택은 사용자가 합니다.

> 현재 사진 가져오기와 갤러리까지 구현되어 있습니다. 분석·추천 기능은 아직 구현되지 않았습니다.

## 현재 기능

- **사진 가져오기**: 파일 선택기로 여러 장을 선택합니다. JPEG, PNG, WebP만 지원하며 확장자가 아닌 파일 앞부분의 시그니처로 실제 형식을 확인합니다.
- **안전한 건너뛰기**: 지원하지 않는 형식, 손상되어 디코딩할 수 없는 파일, 이미 추가된 사진은 추가하지 않고 사유별로 안내합니다.
- **중복 기준**: 바이트가 완전히 같은 파일을 같은 사진으로 봅니다. 이름이 달라도 내용이 같으면 중복이고, 이름이 같아도 내용이 다르면 다른 사진입니다. 크기가 같은 파일끼리만 내용을 나눠 읽어 비교합니다.
- **갤러리**: 썸네일 그리드와 총 개수를 표시하고 사진 추가와 개별 목록 제거를 지원합니다. 목록 제거는 앱 안에서만 일어나며 기기의 원본 파일은 삭제하지 않습니다.
- **원본 보존**: 선택한 `File` 객체를 그대로 보관합니다. 썸네일은 원본과 분리된 화면 표시용 JPEG 미리보기이며 Object URL은 제거·화면 종료 시 해제합니다. 새로고침하면 목록은 유지되지 않습니다.

## 계획한 기능

1. **빠른 정리**: 흔들림, 초점 불량, 눈 감김, 중복·유사 사진 탐지
2. **베스트 컷 추천**: 표정, 선명도, 조명, 구도 등을 고려한 추천
3. **사용자 선택**: 추천 결과 수정, 즐겨찾기, 원본 사진 내보내기
4. **개인화**: 사용자 선택 이력을 반영한 취향 학습(후속 단계)

## 원칙

- 원본 사진은 바이트 단위로 보존합니다. 재압축, 재인코딩, 자동 수정과 자동 삭제를 하지 않습니다.
- 분석은 브라우저 안에서 수행하며 사진을 외부 서버로 전송하지 않습니다.
- 분석용 이미지와 원본 파일을 분리하고, 내보내기에는 원본만 사용합니다.

## 기술 구성

- React + Vite + TypeScript, Tailwind CSS
- Vitest + Testing Library, Playwright + axe-core
- Vercel 정적 배포, MVP에서는 서버·DB 없음
- 향후 PWA와 Capacitor로 모바일 앱 확장

## 실행 방법

Node.js `^22.22.2 || ^24.15.0 || >=26.0.0`과 npm이 필요합니다. 범위 밖의 Node에서는 `npm ci`가 실패합니다.

```bash
npm ci
npx playwright install chromium webkit   # E2E 테스트를 처음 실행할 때 한 번
npm run dev                              # 개발 서버
```

| 명령 | 내용 |
|---|---|
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript 타입 검사 |
| `npm run test` | Vitest 단위 테스트 |
| `npm run build` | 프로덕션 빌드 (`dist/`) |
| `npm run test:e2e` | Playwright E2E. 빌드 결과물을 대상으로 하므로 먼저 `npm run build`가 필요합니다 |
| `npm run test:gate` | GitHub 리뷰 게이트와 병합 도구 테스트. 병합 도구 테스트는 Linux 전용이라 다른 OS에서는 건너뛰고, CI에서 건너뛰면 실패합니다 |
| `npm run verify` | 위 검사를 모두 순서대로 실행 |

GitHub Actions의 [CI 워크플로우](.github/workflows/ci.yml)가 모든 PR과 `main` push에서 Node 24.15.0으로 `npm ci`와 `npm run verify`를 실행합니다.

## 개발 규칙

Agent와 사람이 함께 따르는 작업 규칙은 [AGENTS.md](AGENTS.md)와 `.ai/` 아래 정책 문서에 있습니다.

### Claude Code에서 Codex 리뷰 요청

Claude Code로 구현한 변경은 [Codex plugin for Claude Code](https://github.com/openai/codex-plugin-cc)로 독립 리뷰를 요청할 수 있습니다. 플러그인은 개발자 컴퓨터에 선택적으로 설치합니다.

- 이 저장소의 `.codex/config.toml`이 Codex 모델(`gpt-6.1-sol`)과 추론 강도(`high`)를 지정합니다. Codex가 이 프로젝트를 신뢰된 프로젝트로 인식할 때만 적용됩니다.
- 역할은 **Claude 구현 → 구현에 참여하지 않은 Codex 검토 → Claude 수정 → 필요한 재검토**로 나눕니다.
- 자동 리뷰(Stop 리뷰 게이트, 저장소 전체 Automatic reviews)는 끄고, 구현과 로컬 검사가 끝난 시점에 `/codex:review --base main`으로 직접 요청합니다.
- PR 전체를 검토할 때는 최신 기준 브랜치와 작업 브랜치의 전체 차이를 대상으로 합니다. 결과에는 base/head 커밋, 검토 범위, 지적사항과 실행하지 못한 검사를 남깁니다.
- 실행 중·취소·스킵·한도 초과는 검토 완료가 아닙니다. 구독 한도에 도달하면 멈추고 유료 API나 추가 결제로 전환하지 않습니다.
- 로컬 로그인 정보와 인증 파일을 저장소에 복사하거나 커밋하지 않습니다.

이 플러그인은 기존 CI, 필요한 독립 검증, PR 결과 기록과 사람 확인을 대체하지 않습니다.

## GitHub 리뷰 게이트

기본 `independent-review` 게이트는 **AI를 호출하지 않고**, 최신 변경에 대한 리뷰 근거와 관리자의 확인 기록을 검사합니다. Codex 리뷰 실행과는 별개의 검사입니다. 자동 병합은 사용하지 않습니다.

게이트는 같은 실행에서 위험도별 **Shadow 판정**도 계산해 Actions Summary에만 남깁니다. Low·Medium·High 자동 판정 후보 여부, 필수 CI, Codex GitHub 리뷰 결과, 사용자 승인, 기존 게이트와의 차이를 보여 주며 병합 조건에는 쓰이지 않습니다. 설정과 판정 기준은 [리뷰 게이트 설정](.ai/checklists/review-gate-setup.md#6-shadow-판정관찰용)에 있습니다.

- [리뷰 게이트 설정과 확인 댓글 형식](.ai/checklists/review-gate-setup.md)
- [위험도와 독립 검증 기준](.ai/policies/verification.md)
- [리뷰 자동화 정책](.ai/policies/review-automation.md)
- [커밋·PR·병합 메시지 규칙](.ai/policies/git-messages.md)

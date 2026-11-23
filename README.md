# Photo Selector

여러 장의 사진에서 실패한 사진과 유사 사진을 구분하고 좋은 사진을 추천하는 웹앱입니다. 최종 선택은 사용자가 합니다.

> 현재 사진 가져오기, 갤러리, 흐릿한 사진(흔들림·초점 불량) 감지, 비슷한 사진 묶기와 크게 비교, 남길 사진 표시까지 구현되어 있습니다. 눈 감김 분석과 추천 기능은 아직 구현되지 않았습니다.

## 현재 기능

- **사진 가져오기**: JPEG, PNG, WebP, HEIC(HEIF)를 여러 장 선택합니다. 파일 앞부분의 시그니처로 실제 형식을 확인하고, 지원하지 않는 형식·손상 파일·이미 추가된 사진(바이트가 완전히 같은 파일)은 사유별로 안내하며 건너뜁니다.
- **갤러리**: 썸네일 그리드, 개별 목록 제거. 목록 제거는 앱 안에서만 일어나며 기기의 원본 파일은 삭제하지 않습니다.
- **흐릿한 사진 감지**: 기기 안의 Web Worker에서 분석해 `흔들림 의심`·`초점 불량 의심`·`흐림 의심`·`분석 불가`를 사유와 함께 표시합니다. 판정은 참고 정보이며 사진을 자동으로 지우거나 바꾸지 않습니다.
- **비슷한 사진 묶기**: 연속 촬영처럼 화면상 같거나 비슷한 사진을 `거의 같은 사진`·`비슷한 사진` 묶음으로 보여 줍니다.
- **크게 비교**: 묶음 사진을 화면 전체로 비교합니다. 원본 파일을 그대로 보여 주며 복사하거나 다시 인코딩하지 않습니다.
- **남길 사진 표시**: 사진마다 직접 `남기기`를 표시하고 `남길 사진만 보기`로 모아 봅니다. 남기지 않은 사진도 지우거나 숨기지 않습니다.

기능별 상세 동작은 [제품 가이드](docs/product-guide.md)를 참고하세요.

## 핵심 한계

- **눈 감김 분석, 베스트 컷 추천, 원본 내보내기, 취향 학습은 아직 구현되지 않았습니다.** ([계획한 기능](docs/product-guide.md#계획한-기능미구현))
- **HEIC**는 브라우저가 직접 디코딩할 수 있을 때만 추가됩니다. 알려진 범위는 Safari 17 이상(iOS·macOS)이며 Chrome·Edge·Firefox에서는 안내만 보여 줍니다. 실제 촬영한 고해상도 HEIC 원본은 실기기에서 확인하지 않았습니다. ([HEIC 사진](docs/product-guide.md#heic-사진))
- 흐림·비슷한 사진 판정의 기준값은 **실제 카메라 사진 묶음으로 보정하지 않았습니다.** 짧은 실제 손떨림, 잡음이 많은 사진, 큰 원본의 약한 흐림은 놓치거나 `분석 불가`가 될 수 있고, 원인 표시(흔들림·초점 불량)는 추정입니다. ([판정 구조와 알려진 한계](docs/architecture.md))
- 사진 목록과 남길 사진 선택은 브라우저 메모리에만 있어 **새로고침하면 사라집니다.**

## 개인정보와 원본 보존

- 원본 사진은 바이트 단위로 보존합니다. 재압축, 재인코딩, 자동 수정과 자동 삭제를 하지 않습니다.
- 분석은 브라우저 안에서 수행하며 사진을 외부 서버로 전송하지 않습니다.
- 분석용 이미지와 원본 파일을 분리하고, 내보내기에는 원본만 사용합니다.
- 사진 목록과 선택은 서버·DB에 저장하지 않으며 외부 CDN·분석 도구를 사용하지 않습니다.

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
npm run calibrate                        # 개발용 흐림 판정 평가 도구(/calibration.html)
```

| 명령 | 내용 |
|---|---|
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript 타입 검사 |
| `npm run test` | Vitest 단위 테스트 |
| `npm run build` | 프로덕션 빌드 (`dist/`) |
| `npm run test:e2e` | Playwright E2E. 빌드 결과물을 대상으로 하므로 먼저 `npm run build`가 필요합니다. 평가 도구용 빌드(`dist-calibration`)는 E2E가 직접 만듭니다 |
| `npm run test:gate` | GitHub 리뷰 게이트와 병합 도구 테스트. 병합 도구 테스트는 Linux 전용이라 다른 OS에서는 건너뛰고, CI에서 건너뛰면 실패합니다 |
| `npm run verify` | 위 검사를 모두 순서대로 실행 |

GitHub Actions의 [CI 워크플로우](.github/workflows/ci.yml)가 모든 PR과 `main` push에서 Node 24.15.0으로 `npm ci`와 `npm run verify`를 실행합니다.

## 문서

전체 목차는 [docs/README.md](docs/README.md)입니다.

- [제품 가이드](docs/product-guide.md): 기능 상세, HEIC 지원, 계획한 기능
- [판정 구조](docs/architecture.md): 흐림·비슷한 사진 판정 방식, 임계값 근거, 알려진 한계
- [평가 가이드](docs/evaluation-guide.md): 평가 도구, 정답 데이터, 날짜별 평가·실험 기록
- [Agent·개발 규칙](AGENTS.md)과 `.ai/` 정책 문서: 작업 규칙, 리뷰·게이트·병합 절차. 요약은 [개발·리뷰 절차](docs/README.md#개발리뷰병합-절차)

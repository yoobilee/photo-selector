# 로컬 독립 리뷰 결과 자동 게시

Claude Code 구현 → 같은 Claude 세션의 native Codex 플러그인 검토 → Claude 수정 → 변경된 HEAD 재검토 흐름을 유지한다. 아래 wrapper로 기존 리뷰와 자동 게시를 연결한다. wrapper와 별도로 같은 base/head의 `/codex:review`를 실행하지 않는다. Stop 리뷰 게이트와 GitHub Automatic reviews도 켜지 않는다.

```text
npm run review:publish -- yoobilee/photo-selector <PR번호> --plugin-root <설치된 Codex 플러그인 루트> --session <현재 Claude 세션 ID>
```

`CODEX_COMPANION_SESSION_ID` 또는 `CLAUDE_SESSION_ID`가 있으면 `--session`을 생략할 수 있다. 현재 Claude 세션이 실행한다. Codex 구현 PR에는 사용하지 않는다(Claude 독립 검토 필요). plugin cache, `.codex/config.toml`, hooks는 변경하지 않는다.

기존 수집기의 계약대로 PR은 open·Ready 상태여야 한다. PR 번호가 없거나 Draft이면 먼저 검토 대상을 준비하고 실행한다. 이 자동화 도입 PR 자체는 Draft를 유지하며 wrapper로 검토하지 않는다.

## 실행과 출력

1. 원격 PR·정책·파일·댓글·검사를 전체 조회해 대상과 fingerprint를 고정하고 로컬 HEAD를 확인한다.
2. 기존 `codex-companion.mjs review --wait --base <고정 base SHA> --scope branch --json`을 1회 실행한다. 모델·추론 강도는 기존 설정을 따른다. 이어 `result --json`으로 같은 세션·thread·완료 job을 수집한다. 별도 독립 리뷰를 중복 실행하지 않는다.
3. 원문·지적·현재 HEAD의 CI check·미실행/확인 불가 항목을 모은다. native plugin은 명령별 검사 결과의 구조화된 증명을 제공하지 않는다. 원문에 있는 검사 주장은 관리자와 CI가 따로 확인한다. 관찰한 지적 없음 선언과 검사 문장의 전체 문법만 허용하며, 뒤에 알 수 없는 산문이 있으면 unknown으로 둔다. 결과(v3)는 아래 정보를 서로 다른 필드로 기록한다(자세한 규칙은 "코드 지적과 리뷰어 로컬 검사 구분").
   - `findings`: 코드 지적(critical/high/medium/low)과 판단 불가(unknown)
   - `status`·`reviewComplete`: 리뷰 완료 여부
   - `reviewerChecks`: 리뷰어가 원문에 보고한 로컬 검사의 통과(`passed`)·실패(`failed`)·미실행(`not-run`)·건너뜀(`skipped`)과 리뷰어가 밝힌 환경 원인 주장
   - `checks`: GitHub API가 반환한 현재 HEAD의 원격 CI 상태

   unknown이나 미해결 critical/high/medium이면 원문과 `review-needs-attention`을, 코드 지적은 없지만 리뷰어가 로컬 검사 실패를 보고했으면 `review-checks-need-attention`을 출력하고 게시하지 않는다. 지적 배지는 집계하되 나머지 문맥의 완전성을 증명할 수 없어 unknown도 함께 남긴다. 출력의 `codeFindings`는 저장된 결과(리뷰 당시 해석)이고, `interpretation.current.unknownReasons`는 현재 parser가 unknown마다 원문의 어느 문장에서 해석이 멈췄는지 알려 준다.
   원문이 게시 가능해도 새 게시 요청 전에 같은 job의 plugin 로그를 대조한다. 로그를 확보·대조하지 못했거나, 리뷰 완료 증거가 없거나, exit 0이 아닌 명령·완료 기록 없는 명령·실행 여부를 구분할 수 없는 줄이 있으면 `review-job-log-needs-attention`으로 게시하지 않는다(아래 "unknown 원인 진단과 job 실행 기록 대조").
4. 기존 `review-evidence.yml`의 고정된 기본 브랜치에 등록 요청만 전달한다. 개인 GitHub 인증으로 PR 댓글을 쓰지 않는다. workflow는 PR 코드·모델·설치·테스트를 실행하지 않고 기본 브랜치 코드와 최소 `GITHUB_TOKEN` 권한으로 미인증 자료를 게시한다.
5. workflow가 댓글 ID·본문을 확인한 뒤 `review-evidence-v2-<댓글 ID>-<본문 SHA-256>` 이름의 artifact를 만든다. 내용은 댓글 링크·ID·해시뿐이다. API가 artifact를 원본 run에 연결한 metadata가 게시 경로의 영수증이다. ZIP을 게이트에서 실행/추출하지 않는다.
6. 성공한 실행과 댓글을 다시 검증해 stdout JSON에 댓글 링크·해시·관리자가 직접 작성할 `/review-gate`를 출력한다. 보고서를 수동 게시할 필요가 없다. 확인 내용만 다시 조회하려면:

```text
npm run review:prepare -- yoobilee/photo-selector <PR번호> --confirmation
```

관리자는 원문·실행 이력·독립성·검사 한계를 확인하고 생성된 `/review-gate`를 직접 게시한다. High의 `/merge-approve`도 별도로 직접 게시한다. AI는 두 댓글을 대신 쓰지 않는다. fingerprint, evidence digest, proof v2, strict 보호와 필수 CI는 유지한다.

## 신뢰 경계

- `미인증 로컬 독립 리뷰 자료` 표시는 게시 후에도 유지한다. bot·완료 플래그·output hash·영수증은 Codex가 독립 검토했다는 인증이 아니다. 로컬 JSON·plugin job·ledger는 같은 기기의 사용자/Agent가 위조할 수 있다. 실제 실행·독립성은 사람이 확인한다.
- 게이트는 관리자 확인이 링크한 봇 보고서의 정확한 bot ID·앱 ID·유형, 재구성한 본문·해시, PR 번호·repo·base/head·fingerprint·정책 SHA, 승인된 게시 workflow/코드, 최초 실행 성공, run 소속 영수증을 확인한다. 출처 정보도 digest에 포함한다. 영수증만으로 자동 승인하지 않는다.
- `actions: read`는 게이트의 run/artifact 조회에 추가했다. 게시기는 기존 read 권한과 `issues: write`만 사용한다. 추가 쓰기·병합 권한·AI 인증은 없다. Actions token 댓글은 후속 workflow를 자동 실행시키지 않을 수 있으며 관리자 `/review-gate`가 기존 게이트를 실행한다.
- 관리자 인증 공유는 미해결이다. 현재 gh 로그인으로 dispatch를 요청하지만 같은 인증으로 AI가 임의 승인 댓글을 쓰는 것을 기술적으로 막지 못한다. 봇 게시와 사람 승인의 구분은 완전한 사람 증명이 아니다. 강한 보장이 필요하면 관리자 자격증명을 AI 환경에서 제거하고 비관리자 실행 계정/전용 게시 App과 사람 전용 승인 환경을 별도 구성·검증해야 한다. 이번 PR은 App 설치·권한을 변경하지 않는다.

## 코드 지적과 리뷰어 로컬 검사 구분

### 문제

PR #28의 Codex native 리뷰는 코드 지적이 0건이었지만 리뷰어 읽기 전용 환경에서 `privacyGuard`가 임시 폴더 권한 제한으로 실패했다고 보고했다. parser v2는 지적 없음 선언(한국어 포함)과 검사 실패 문장을 한 덩어리로 다뤄 `unknown: 1`로 차단했다. 차단 자체는 의도한 안전 동작이었지만, 관리자는 "코드 지적이 있는지"와 "리뷰어 환경에서 검사가 실패했는지"를 구분해 볼 수 없었다.

같은 리뷰의 plugin job 로그에는 원문에 없는 `git diff --check` exit 1도 남아 있었다. 리뷰 원문이 실행한 모든 명령과 실패를 나열한다는 보장은 없다.

### 해결 (parser v3, 결과 v3)

- 원문을 처음부터 끝까지 문장 단위로 해석한다. 첫 문장은 관찰한 지적 없음 선언(영어 3종과 Issue #41에서 추가한 "No actionable defects/regressions were identified …" 문형, PR #28 한국어 1종)이어야 한다. 이어지는 문장은 "검사 목록 + 통과/실패/미실행/건너뜀" 문형만 받는다. 검사 이름은 정해진 어휘(Lint, TypeScript, Build, E2E, 단위·선명도 테스트 등), 숫자, 코드 식별자(`privacyGuard`, `` `npm run test:gate` `` 등)로 제한한다. 해석하지 못한 문장이 하나라도 있으면 unknown이다.
- 실패 원인은 리뷰어가 샌드박스·환경 권한 제한을 명시한 좁은 문형만 `cause: { kind: 'environment-claimed', text }`로 기록한다. 이 값은 리뷰어의 주장이며 확인된 사실이 아니다. 원인을 밝히지 않은 실패는 코드 결함일 수 있으므로 unknown을 하나 더한다. 다른 원인(assertion error 등)이나 추정 표현은 문법 밖이라 unknown이다.
- 실패는 어떤 경우에도 통과로 바꾸지 않는다. 원격 CI 성공은 `checks`에 따로 남기며, 리뷰어 로컬 검사가 성공했다는 근거로 쓰지 않는다.
- 리뷰어가 로컬 검사 실패를 보고하면 코드 지적이 0건이어도 자동 게시하지 않는다(`review-checks-need-attention`, 종료 코드 2). 출력에는 `codeFindings`, `reviewerCheckFailures`, 전체 `reviewerChecks`, 원격 `remoteChecks`, 원문 전체가 함께 나온다. 관리자는 함께 생성되는 관리자 검토 초안(아래 "자동 게시 차단 시 관리자 검토 자료")으로 원문과 plugin job 기록을 확인한 뒤 판단한다.
- 통과·건너뜀·미실행만 보고한 원문은 지금처럼 게시할 수 있다. 미실행 항목은 게시된 JSON의 `reviewerChecks`에 그대로 남는다.
- 서버는 같은 parser로 원문을 다시 해석한다. 제출한 `reviewerChecks`가 해석 결과와 하나라도 다르면(실패 삭제·통과 변조·원인 변경·항목 추가) 거부하고, 지적 수를 원문보다 줄인 제출도 계속 거부한다.
- 봇 보고서에 리뷰어 로컬 검사 실패가 있으면 `review:prepare --confirmation`과 게이트가 그 보고서를 관리자 확인 근거로 쓰지 않는다. 수동 dispatch로 기록된 경우도 같다.
- parser v2가 지적 없음으로만 보던 영어 문장 "The full unit run encountered a sandbox EPERM in privacyGuard; ..."는 v3에서 `privacyGuard` 실패로 기록되고 자동 게시하지 않는다. 의도한 강화다.

### 게시 코드 버전 확인

서버 workflow는 기본 브랜치의 parser와 검증 코드를 실행한다. wrapper는 dispatch 직전에 로컬 게시·판정 모듈(`publicationModules`)의 Git blob SHA를 기본 브랜치와 비교한다. 다르면 `review-publication-code-mismatch`로 중단하고 `publicationRequested`를 기록하지 않는다. 서버가 다른 parser로 거부할 요청을 보내 영수증 없는 "요청됨" 상태에 빠지는 것을 막는다. parser·검증 코드를 바꾸는 PR(이 변경 포함)은 자기 리뷰를 자동 게시할 수 없으며 수동 리뷰 보고 절차를 사용한다.

### 한계

- 문법은 관찰한 문형만 받는다. 새 표현은 unknown이 되어 수동 절차로 넘어간다. 문법 확장은 실제 원문과 회귀 테스트를 근거로 별도 high-risk PR에서 한다.
- 원문에 없는 실패(PR #28의 `git diff --check`)는 parser가 알 수 없다. native plugin이 명령별 결과를 구조화해 제공하지 않으므로 관리자가 job 기록을 확인해야 한다.
- 결과 v3 도입으로 v2 형식 결과는 새로 게시할 수 없다. 실제 게시된 v2 봇 보고서는 없다(PR #23·#28 모두 미게시).

## 자동 게시 차단 시 관리자 검토 자료

### 문제

PR #34에서 native Codex 리뷰는 완료됐고 ledger도 `completed`였지만, 원문의 테스트 실패 문장이 문법 밖이라 `review-needs-attention`으로 자동 게시가 차단됐다(의도한 fail-closed 동작). 관리자는 ledger·plugin job 로그·원격 CI를 직접 대조해 보고서를 쓰고, 댓글 해시를 계산해 `/review-gate`를 손으로 만들어야 했다. 자동 게시 도입(Issue #22) 이전의 수동 복사 부담이 차단 사례마다 되살아난 셈이다. 게다가 plugin job과 로그는 Claude 세션 종료 시 플러그인이 지우므로(`session-lifecycle-hook`의 SessionEnd 정리) 나중에는 job 실행 기록을 확인할 수 없었다.

### 해결

차단 정책은 바꾸지 않는다. 자동 게시가 막힌 결과만 관리자가 판단하기 쉬운 자료로 바꾼다.

1. wrapper가 unknown·차단 지적(`findings`), 리뷰어 로컬 검사 실패(`reviewer-check-failed`)나 job 실행 기록 차단(`job-log-unverified`·`job-command-failed`·`job-log-incomplete`, Issue #41)으로 게시를 멈추면, 같은 실행에서 출력 JSON의 `adminDraft`에 관리자 검토 초안 경로를 알려 준다. 종료 코드는 기존과 같이 2다.
   - 완료 ledger(복구 v3가 있으면 그 파일)는 **읽기만** 한다. 현재 PR 대상(base/head/fingerprint/정책 SHA)과 완전히 같고 게시 요청 기록이 없을 때만 초안을 만든다.
   - plugin의 `result <job ID> --json`으로 같은 job의 저장 기록만 조회한다. 리뷰를 실행하지 않는다. job ID·thread·turn·세션·완료 시각·원문이 ledger와 모두 같을 때만 로그를 `<ledger>.job-log.json`에 한 번 복사한다(덮어쓰지 않음). 다음 실행은 사본을 재사용하므로 job을 다시 조회하지 않는다. 일치하지 않거나 이미 정리됐으면 "확인 불가"로 표시한다.
   - 초안은 `<ledger>.attention-<내용 hash 12자리>.md`에 쓴다. 같은 내용이면 같은 파일을 재사용하고 기존 파일을 덮어쓰지 않는다. 초안 생성이 실패해도 차단 결과는 그대로이며 `adminDraft.state: failed`로 알린다.
2. 초안은 게이트가 읽는 관리자 보고서 형식(`# 독립 리뷰 보고서`, base/head SHA 포함)을 따르고 출처별로 절을 나눈다.
   - 검토 대상: 저장소·PR·구현자·위험도·base/head·fingerprint·정책 SHA·job/thread/turn·원문 SHA-256·ledger SHA-256
   - 1 자동 게시 차단 사유, 2 코드 지적 집계(unknown 포함), 3 리뷰어가 원문에 보고한 로컬 검사(주장, 환경 원인은 "확인 안 됨"), 4 job 로그의 명령·exit 코드, 5 표준 검사(Lint·Type Check·단위·Build·E2E·게이트·verify)별 job 실행 기록과 "기록 없음/확인 불가", 6 원격 필수 CI, 7 불확실성, 8 관리자 판단(빈칸), 부록 원문 전체
   - plugin은 이벤트 줄을 빈 줄 없이 쓰고, 리뷰어가 쓴 글(`Assistant message`·`Review output`·`Reasoning summary`·`Final output` 등)은 빈 줄과 제목 줄로 시작하는 블록으로 쓴다. 블록에는 끝 표시가 없어 이후 줄이 실제 이벤트인지 리뷰어 글인지 구분할 수 없다. 그래서 첫 블록 이후의 명령 형식 줄은 실행 기록으로 세지 않고 "확인 불가"로만 표시한다(PR #37 리뷰 지적). 명령 문자열의 사용자 홈 경로는 `~`로 바꾼다. 리뷰 원문은 대조를 위해 그대로 둔다.
   - 표준 검사 표(5절)는 명령 전체가 그 검사의 직접 실행일 때만 센다(`npm run lint`, `npm run test -- …`, 셸 감싸기 한 겹 허용). 검색 명령(`Select-String … 'npm run lint'`), 파이프·연결·리디렉션, 잘린 명령은 세지 않고 4절 전체 명령 표에만 남긴다(PR #37 리뷰 지적).
   - 표 칸의 `|`는 `\|`로 바꿔 결과 칸이 밀리지 않게 한다. 명령 목록은 종류별로 80건까지 보여 주고, 초안이 60,000자(GitHub 댓글 상한 65,536자보다 작게)를 넘으면 명령 목록을 생략한다. 원문·대상·marker는 항상 유지하며, 그래도 넘으면 초안을 만들지 않고 실패로 알린다.
   - 초안에는 `/review-gate`·`/merge-approve` 명령 줄이 없고, 통과 판단을 미리 채우지 않는다.
3. 세션이 끝난 뒤에도 같은 checkout에서 초안을 다시 만들 수 있다. 세션 ID·plugin 호출이 필요 없고, job 로그 사본이 없으면 "확인 불가"로 남긴다.

```text
npm run review:attention -- yoobilee/photo-selector <PR번호>
```

### 관리자 판단 이후

1. 관리자가 초안을 열어 원문·기록을 확인하고 "8. 관리자 판단"을 작성한 뒤 **본인 계정으로 직접 게시**한다(예: `gh pr comment <PR번호> --repo yoobilee/photo-selector --body-file "<초안 경로>"`). Agent는 이 명령을 대신 실행하지 않는다.
2. 게시한 댓글로 확인 문구를 준비한다. 이 명령은 GitHub에 쓰지 않는다.

```text
npm run review:attention -- yoobilee/photo-selector <PR번호> --confirm <게시한 보고서 댓글 URL 또는 ID>
```

3. 출력된 `confirmationPath` 파일(`/review-gate` 형식)을 확인하고 관리자가 직접 게시한다. High는 `/merge-approve`도 관리자가 직접 작성한다.

`--confirm`은 다음을 모두 만족할 때만 문구를 만든다. 하나라도 어긋나면 고정 안내만 출력하고 파일을 쓰지 않는다.

- 이 PR의 댓글이고, 작성자가 admin/maintain 권한의 사용자(`User`)다. 봇·쓰기 권한 사용자의 댓글은 거부한다.
- 본문이 보고서 제목으로 시작하고 현재 head/base SHA, 현재 ledger·원문·job에서 계산한 초안 marker, 리뷰 원문 전체를 포함한다. 다른 대상·이전 head·다른 결과의 초안은 거부한다.
- 같은 대상의 봇 보고서가 없고, 변경 요청 리뷰와 critical/high/medium 지적이 없다. unknown은 줄이지 않고 그대로 넣는다.
- 현재 HEAD의 필수 CI가 성공했고 workflow 출처가 맞다(`verifyEvidenceCi`).
- 만든 확인 내용이 기존 게이트 판정 함수(`decide`)에서 통과 조건을 만족한다.

확인 내용의 `evidenceHash`는 실제로 게시된 댓글 본문(줄바꿈 LF 정규화)에서 계산하므로 관리자가 판단 절을 작성해도 맞는다. 게이트가 실제로 읽는 확인(가장 최근 관리자 `/review-gate`)이 준비한 내용과 같을 때만 `already-confirmed`와 댓글 ID를 알려 주고 다시 게시하지 말라고 안내한다. 과거에 같은 내용이 있었어도 더 최근 관리자 확인이 덮었으면 다시 게시가 필요하다고 안내한다(PR #37 리뷰 지적).

### 유지한 경계와 한계

- 게이트·fingerprint·evidence hash·proof v2·브랜치 보호·봇 게시 경로는 바꾸지 않았다. 게이트는 지금처럼 관리자가 쓴 보고서와 `/review-gate`만 읽는다. 이 도구의 출력은 관리자 확인이 아니다.
- 관리자와 Agent가 같은 GitHub 인증을 공유하는 문제는 그대로다. 도구는 쓰기 API를 호출하지 않지만, 같은 인증으로 Agent가 직접 댓글을 쓰는 것을 기술적으로 막지는 못한다.
- job 로그는 차단 직후 같은 Claude 세션에서만 복사할 수 있다. 이미 정리된 기록(예: PR #34)은 "확인 불가"로 남는다. 로그의 명령 문자열은 96자에서 잘리고, 실패한 테스트 파일·원인은 로그만으로 특정되지 않는다. Windows에서는 명령이 `powershell.exe -Command '…'`로 감싸져 실제 명령이 잘리므로 표준 검사 표가 "기록 없음"으로 보일 수 있다(PR #37 실제 로그에서 확인). 관리자는 전체 명령 표를 함께 본다.
- ledger·job 로그·초안은 로컬 미인증 자료다. 관리자가 원문과 실행 기록을 직접 확인해야 한다.
- CI workflow 자체를 바꾸는 PR은 `verifyEvidenceCi`가 출처를 확정하지 못해 `--confirm`이 거부한다. 이때는 초안을 참고해 기존 수동 절차로 `/review-gate`를 작성한다.
- 초안 marker는 현재 ledger에서 계산한다. 초안을 만든 뒤 `--recover`로 복구 v3 기록이 생기면 marker가 달라지므로 초안을 다시 만들어 게시한다.

## unknown 원인 진단과 job 실행 기록 대조 (Issue #41)

### 문제

PR #28·#30·#34·#37·#40에서 Codex native 리뷰는 완료됐고 코드 지적(critical/high/medium)도 없었지만 `unknown: 1`로 자동 게시가 반복 차단됐다. 관리자는 매번 원문을 직접 읽어 왜 unknown인지 찾아야 했다. PR #40 최종 job에는 exit 1인 명령 2건이 있었는데, 원문은 "… passed"라고만 적었다. 원문 문법만 넓히면 이런 리뷰가 원인을 모르는 채 자동 게시될 수 있었다.

### 원인 (로컬 ledger 원문을 현재 parser로 재현)

| 리뷰 | 원문 첫머리 | 차단 지점 | job 기록 |
|---|---|---|---|
| PR #30 재리뷰 `7c15203` | No actionable defects were identified in the changes. | 선언이 문법 밖. 선언을 받아도 "parser" 검사 어휘와 "full gate validation was limited by …"(검증 제한)에서 멈춤 | 사본 없음 |
| PR #34 `20a0887` | No actionable regressions found; … | 쌍반점으로 이어진 선언. 고쳐도 "one suite failed because the read-only environment …"(원인 문형 밖 실패)에서 멈춤 | 정리됨(확인 불가) |
| PR #37 최종 `1118f8f` | No actionable regressions were identified in the changes against the specified base. | 선언과 "the full verification suite"(검사 어휘 밖)만 문법 밖 | 명령 12건 모두 exit 0 |
| PR #40 첫 리뷰 `d011b44` | No actionable regressions were identified. | 선언 뒤 산문("Documentation content remains …"). "git diff --check reported only extra blank lines"(실패 보고)도 있음 | exit 1 명령 2건 |
| PR #40 최종 `b352c1f` | No actionable regressions were identified in the documentation reorganization or configuration changes. | 검토 범위를 좁히는 수식어가 붙은 선언. 고쳐도 백틱 없는 `git diff --check`, "checks of 74 local documentation links", "runtime tests"에서 멈춤 | exit 1 명령 2건(`git grep -n -F 'RE...`, `node --input-type=...`) |

다섯 건 모두 첫 문장(지적 없음 선언)에서 해석이 멈춰 뒤의 검사 문장은 하나도 기록되지 않았다. 차단 자체는 의도한 fail-closed 동작이었다. 다만 관리자에게는 "unknown 1"만 보여 어느 문장이 문법 밖인지 알 수 없었다.

PR #40 최종 job의 exit 1 명령 2건은 원인을 확인할 수 없었다. plugin 1.0.6은 native 리뷰를 `ephemeral: true` thread에서 실행해 Codex 세션 rollout을 남기지 않는다. job 로그에는 `shorten(item.command, 96)`으로 잘린 명령과 exit 코드만 쓰고 stdout/stderr는 쓰지 않는다. `git grep`의 exit 1은 "일치 없음"일 수 있지만, 명령이 잘려 뒤에 다른 명령이 연결됐는지 알 수 없어 확정할 수 없다.

### 비교한 개선안

| 안 | 내용 | 안전성 | 판단 |
|---|---|---|---|
| A. 진단·기록 대조 강화 | unknown 사유를 문장 위치와 함께 출력. 새 게시 요청 전 job 로그의 실패·미완료·확인 불가 명령을 차단 사유로 추가 | 게시 범위를 넓히지 않고 오히려 좁힌다. 서버 판정 변경 없음 | 채택 |
| B. 관찰한 안전 문형만 추가 | 실제 관찰한 "… were identified …" 선언과 검사 어휘 `verification`만 parser에 추가. 서버도 같은 parser를 쓴다 | 통과·미실행 주장만 새로 해석한다. 실패·검증 제한·범위 축소·산문은 계속 unknown. A와 함께 써야 원문과 job 기록이 상충할 때 막을 수 있다 | A와 함께 채택 |
| C. 구조화된 결과 | plugin의 `outputSchema`(review-output.schema.json)는 adversarial-review 전용이다. native `review/start`에는 구조화 결과·명령 출력 보존 옵션이 없다 | 리뷰어 종류·프롬프트가 바뀌어 프로젝트 검토 계약(native `/codex:review`) 변경이 필요하다. plugin 수정·자체 app-server 클라이언트는 범위 밖이다 | 보류(공식 지원 시 재검토) |

명령 전체·출력 보존은 공식 경로가 없다. plugin cache 수정, Codex 내부 DB·로그 조회, 별도 app-server 클라이언트 구현은 하지 않았다. 리뷰 원문만으로 "환경 문제"나 "검색 결과 없음"을 확정하지 않는다.

### 해결

1. parser에 `explainReviewText`를 추가했다. unknown마다 사유(`declaration-unrecognized`, `sentence-unrecognized`, `unexplained-check-failure`, `incomplete-review-phrase`, `malformed-badge`)와 해석이 멈춘 위치의 원문 발췌를 돌려준다. 사유 수는 항상 같은 parser가 계산한 `findings.unknown`과 같다. wrapper 출력(`interpretation.current.unknownReasons`), `review:attention` 출력과 관리자 초안 2절에 표시한다. 이전 parser로 저장한 결과와는 개수가 다를 수 있어 따로 표시한다(아래 "독립 검토 지적 반영" 3). 게시 결과 형식(v3)과 서버 검증은 바꾸지 않았다.
2. 관찰한 선언 `No actionable (defects|regressions) were identified[ in the changes[ against the specified base]].`와 검사 어휘 `verification`을 추가했다. 그 결과 PR #37 최종 원문은 `All 127 targeted tests`(통과), `the full verification suite`(미실행)로 해석된다. 미실행은 미실행으로 남는다. 범위를 좁힌 선언("in the documentation … changes"), "regressions identified"(동사 없음), 쌍반점 선언은 받지 않는다.
3. wrapper가 새 게시를 요청하기 전에 같은 job의 저장 기록(`result <job> --json`)만 조회해 로그 사본을 남기고 대조한다. 리뷰는 다시 실행하지 않는다. 아래 중 하나라도 있으면 `review-job-log-needs-attention`(종료 코드 2)으로 게시하지 않고 관리자 초안을 만든다.
   - `job-log-unverified`: 로그를 조회·저장하지 못했거나 사본이 ledger의 job·원문과 맞지 않음
   - `job-command-failed`: exit 0이 아니거나 종료 코드가 없거나(`exit ?`) 완료가 아닌 상태(declined 등)의 명령
   - `job-log-incomplete`: 완료 기록 없이 시작만 기록된 명령, 또는 리뷰어 글 블록 이후의 명령 형식 줄
   - `job-log-not-completed`: 리뷰 완료 증거가 하나라도 없음(아래 "독립 검토 지적 반영" 1)
4. 원문이 이미 차단된 경우에도 job 기록 차단 사유를 함께 표시한다(PR #40은 `findings`와 `job-command-failed`). 이미 게시됐거나 게시 요청한 결과는 기존 영수증 확인 경로를 그대로 쓰며 job 로그를 다시 조회하지 않는다.

로컬 ledger에 적용한 결과는 아래 "독립 검토 지적 반영"의 표에 있다. PR #37 최종 원문은 새 리뷰라면 게시 대상이지만, 저장된 ledger는 이전 parser 해석이라 `parser-mismatch`로 차단된다. job 사본이 없는 과거 기록은 `job-log-unverified`로도 차단된다.

### 독립 검토 지적 반영 (PR #42, 검토 HEAD `1fb9dcc`)

별도 Codex CLI 독립 검토가 Medium 2건, Low 1건을 지적했다. 세 건 모두 수정 전 코드에서 재현한 뒤 고쳤다.

1. **Medium: 빈 로그·불완전한 로그 허용.**
   - 원인: `jobLogBlockers`는 실패·미완료·확인 불가 명령만 셌다. 그래서 0바이트 로그나 시작 이벤트만 남은 로그는 명령 목록이 비어 차단 사유가 `[]`였고, wrapper가 게시를 요청했다(재현: dispatch 1).
   - 수정: 명령 개수와 별개로 리뷰 완료 증거를 요구한다. codex-companion 1.0.6 코드와 실제 로그 6건에서 확인한 증거는 세 가지다.
     - 첫 줄 `Starting Codex Review.`와 `Reviewer started: …`
     - 첫 블록 직전 마지막 이벤트 `Review output captured.`와, 그 직후 저장된 원문과 같은 본문의 `Review output` 블록
     - 마지막 블록인 `Final output`(원문 포함)
   - 하나라도 없으면 `job-log-not-completed`로 차단한다. 해당하는 경우는 0바이트 로그, 시작만 남은 로그, 리뷰 원문 전·최종 출력 전에 잘린 로그, 다른 job 원문의 로그, 최종 출력 뒤 다른 블록이다.
   - 증거가 모두 있고 명령이 0건이면 명령 없이 정상 종료한 job으로 보고 기존 게시 경로를 쓴다. 원문의 미실행은 미실행으로 남는다.
   - 실제 로그 6건은 모두 완료 증거를 갖춰 새로 차단되지 않는다.
2. **Medium: 기존 v3 ledger 호환성.**
   - 원인: 이 PR의 parser 문법 추가로 같은 원문의 해석이 달라졌다. 이전 parser가 저장한 v3 결과(실제 PR #37 최종 ledger `ad0bf470…`: unknown 1, 검사 기록 없음)는 새 parser로 검증하면 "원문과 다른 리뷰어 검사 기록"으로 실패했다. 그 결과 wrapper와 `review:attention` 모두 관리자 초안을 만들 수 없었다. 또 `--recover`가 이 결과를 unknown 0으로 재해석해 게시를 요청했다(재현: dispatch 1).
   - 수정:
     - parser 버전을 4로 올렸다. 새 완료 ledger에는 `parserVersion`을 기록한다.
     - 저장된 결과는 다시 해석해 바꾸지 않는다. 현재 해석과 다르면 `parser-mismatch`로 차단하고 관리자 초안을 만든다. 판정과 확인 문구에는 두 해석 중 큰 지적 수를 쓴다.
     - 원본 ledger, 이전 코드가 만든 `.recovered.v3.json`, 게시 요청 기록, job 로그 사본은 읽기만 한다.
     - 해석이 다른 v3 원본에 `--recover`를 쓰면 `review-recovery-manual`로 중단한다. 복구 파일은 만들지 않는다.
     - 이미 게시 요청한 결과의 해석이 다르면 `review-parser-mismatch`로 중단하고 재요청하지 않는다.
     - v2 결과의 `--recover`(이전 형식 복구)와, 해석이 같은 v3 ledger의 처리는 그대로다.
3. **Low: unknown 진단 불일치.**
   - 원인: 출력과 초안이 저장된 `findings.unknown`(리뷰 당시 parser)과 현재 parser의 `unknownReasons`를 한 덩어리로 보여 줬다. 그래서 개수가 다를 수 있었다(위 ledger: 저장 1, 현재 사유 0).
   - 수정: wrapper와 `review:attention` 출력의 `interpretation`이 `stored`(리뷰 당시 parser 버전·집계)와 `current`(현재 parser 버전·집계·사유)를 구분한다. 관리자 초안 2·3절은 두 해석을 별도 행·표로 보여 준다.
   - 현재 사유로 설명되지 않는 저장 unknown은 `unexplainedStoredUnknown`으로 표시하고 지우거나 통과로 처리하지 않는다.

로컬 ledger 11건(v3 9건, v2 2건)에 새 코드를 읽기 전용으로 적용한 결과다. ledger 파일은 바뀌지 않았다.

| 리뷰 | 해석 일치 | 차단 사유 |
|---|---|---|
| PR #30 `72bec49`·`7c15203`, PR #34 `20a0887` | 일치 | `findings`, `job-log-unverified`(job 사본 없음) |
| PR #37 `e64171b`·`a72091d`, PR #40 `d011b44`·`b352c1f`, PR #42 `1fb9dcc` | 일치 | `findings`, `job-command-failed` |
| PR #37 최종 `1118f8f` | 불일치(저장 unknown 1, 현재 0) | `findings`, `parser-mismatch` |
| PR #23 `3351890`, PR #28 `d3be5f4` | v2 결과 | 복구 경로만 해당 |

### 유지한 경계와 한계

- 실패·미실행·검증 제한·원인 미상 명령 오류를 통과로 바꾸지 않는다. `git grep` exit 1처럼 무해할 수 있는 실패도 원인을 확인할 수 없으므로 자동으로 허용하지 않는다. 관리자가 초안 4절에서 판단한다.
- job 로그 대조는 로컬 wrapper의 추가 차단 조건이다. 서버는 로컬 로그를 볼 수 없어 지금처럼 원문만 다시 해석한다. 로컬 기록은 계속 미인증 자료이며 관리자 확인, `/review-gate`, High의 `/merge-approve`, 영수증·fingerprint·proof v2 검증은 바뀌지 않았다.
- job 로그가 없으면 자동 게시하지 않는다. plugin은 Claude 세션이 끝나면 job과 로그를 지우므로 wrapper는 리뷰를 실행한 같은 세션에서 실행해야 한다.
- 리뷰어 글 블록(Reasoning summary 등)이 명령 실행 중간에 쓰이면 그 뒤 실제 명령도 확인 불가로 분류돼 차단된다. 관찰한 로그에서는 블록이 모든 명령 뒤에 있었다.
- 이 PR은 parser(`publicationModules`)를 바꾸므로 자기 리뷰를 자동 게시할 수 없다(`review-publication-code-mismatch`). 실제 봇 게시 canary(Issue #22)는 병합 뒤 정상 Claude 구현 PR에서 확인한다.
- 롤백: 이 변경을 revert하면 이전 parser·wrapper로 돌아간다. 새로 생기는 로컬 파일은 `<ledger>.job-log.json`뿐이며 기존 ledger·초안은 수정하지 않는다. 새 완료 ledger에 추가한 `parserVersion` 필드는 이전 wrapper가 읽지 않는 필드다.

## 실패·중복·복구

### 문장 수집 실패 뒤 기존 완료 결과 복구

PR #23에서 실제 완료 문장이 기존 허용 문법 밖이라 `unknown: 1`로 분류됐다. 수집기와 서버는 이제 같은 parser로 관찰한 전체 문장을 검사한다. 검사 생략·Build/E2E 미실행은 원문 그대로 보존하며, 임의 후속 산문·원인 불명 실패·한도·미완료·지적 혼재는 `unknown` 또는 차단 지적으로, 원인을 밝힌 실패는 `reviewerChecks`의 실패로 남긴다. 서버는 원문보다 지적 수를 줄인 제출과 원문과 다른 검사 기록도 거부한다.

동일 대상의 **아직 게시 요청하지 않은 completed ledger**가 있을 때만 다음 복구 명령을 사용한다.

```text
npm run review:publish -- yoobilee/photo-selector <PR번호> --plugin-root <설치된 Codex 플러그인 루트> --session <원래 Claude 세션 ID> --recover
```

`--recover`는 native `result --json`만 조회하며 새 리뷰를 호출하지 않는다. 원래 ledger·원문·job은 수정하지 않고 `<원래 ledger>.recovered.v3.json`에 원본 ledger hash와 parser 버전을 포함한 파생 결과 및 게시 상태를 저장한다. parser v2가 만든 `<원래 ledger>.recovered.json`은 읽기만 하고 수정·삭제하지 않는다. 그 파일이 정확히 v2 복구 형식이고, 게시 요청·게시 기록이 없으며, 같은 원본 ledger hash·세션·대상·원문·출처에서 파생됐을 때만 모델 재호출 없이 v3로 다시 해석하고 그 파일의 hash를 `legacyRecoveredHash`로 남긴다. 게시 요청 기록이 있거나 알 수 없는 필드·부분 기록처럼 요청 여부가 불명확하면 `review-recovery-manual`로 중단하고 사람이 실제 댓글·Actions·영수증을 확인한다. v2 복구 파일만 있는 대상에서 `--recover` 없이 실행해도 원래 ledger로 되돌아가지 않고 같은 이유로 중단한다. 원래 ledger의 결과는 이전 형식(v2)이어도 되며 대상·완료 상태·출처 종류·원문 hash만 확인한다. 파생 결과는 항상 현재 형식(v3)으로 다시 만든다. 원래 결과가 이미 v3이면 저장 당시 해석이 현재 parser와 같을 때만 복구한다. 다르면 `review-recovery-manual`로 중단하고 복구 파일을 만들지 않는다. 이때는 `--recover` 없이 실행해 `parser-mismatch` 관리자 초안을 쓴다(재해석으로 저장된 unknown·검사 기록을 줄이지 않는다). 같은 옵션으로 다시 실행하면 그 상태를 재사용한다. job·세션·원문·완료 시각·base/head·정책/fingerprint가 다르거나 이미 게시 요청했다면 중단한다. unknown이 남으면 게시하지 않는다. 원래 ledger가 없거나 running/captured인 경우 이 옵션으로 새 모델 실행을 시작하지 않는다. captured의 기존 조회 복구는 기본 wrapper 경로를 사용한다.

PR #23처럼 이미 병합됐거나 base가 바뀐 결과는 복구 게시 대상으로 삼지 않는다. parser 수정은 옛 결과를 새 base에 재연결하는 허가가 아니다.

봇 게시기는 결과 JSON hash 외에도 같은 저장소·PR·base/head의 기존 봇 보고서를 대조한다. 다른 parser 집계나 job으로 바뀌었어도 같은 대상의 두 번째 댓글은 쓰지 않는다. 기존 댓글이 손상됐거나 영수증이 누락됐으면 사람이 조사해야 하며 자동 재게시하지 않는다.

게시 전과 `/review-gate` 내용 준비 시 현재 필수 CI의 성공·앱·check suite·pull_request run·저장소·head·workflow blob을 자동 검증한다. CI workflow 자체가 바뀐 경우에는 자동 게시를 중단하고 별도 수동 검증이 필요하다. 이 검사는 리뷰어가 로컬에서 검사를 실행했다는 증명이 아니며 관리자 직접 확인과 High의 `/merge-approve`는 그대로다.

wrapper는 요청 자료 준비를 마치고 실제 dispatch하기 직전에 서버와 같은 `verifyEvidenceCi`를 실행한다. CI가 진행 중·실패·불명확하거나 workflow 출처가 맞지 않으면 `publicationRequested`를 기록하지 않는다. completed 결과·원문·기존 검사 상태는 보존하며, CI 성공 뒤 같은 명령을 재실행하면 모델 호출 없이 게시를 이어간다. 복구 모드도 파생 ledger만 사용하며 원본 ledger는 그대로 둔다. 요청 자료 준비 실패도 같은 방식으로 재처리할 수 있다. 실제 요청 직전에 기록한 뒤 응답을 잃은 경우는 자동 재요청하지 않는다. 확인과 dispatch 사이의 변경 가능성 때문에 서버의 대상·CI 재검증도 유지한다.

같은 대상에 다른 job/결과 또는 중복 보고서가 있으면 일반 시간 초과 대신 게시 결과 충돌로 중단한다. 게시·wrapper·확인 준비는 같은 보고서 선별 함수를 사용한다. 대상·형식·원문이 손상됐거나 구형 v1이라 출처를 확인할 수 없는 봇 보고서는 자동으로 무시하지 않는다. 기존 댓글·영수증을 보존하고 사람이 조사해야 하며, 이를 지우거나 다른 결과를 재게시해 우회하지 않는다.

이 변경의 도입 PR은 Codex 구현이므로 Claude Code 독립 리뷰 및 기존 수동 관리자 보고서 경로로 검증한다. main 도입 이후 다음 정상 Claude 구현 PR에서 실제 Actions 댓글·영수증·중복 방지를 확인하기 전에는 Issue #22의 실환경 검증을 완료 처리하지 않는다. 단일 Environment 승인과 자동 병합은 이번 단계에 포함하지 않는다.

- `.git/photo-selector-review-<대상 식별자>.json`과 `.lock`은 로컬 실행 기록이며 보안 증거가 아니다. 동일 repo·PR·base/head에서는 완료 결과를 재사용한다. 본문·정책·세션이 바뀌면 자동 재검토하지 않고 중단한다. running ledger/lock은 프로세스 상태와 기존 plugin job을 사람이 확인하기 전 지우지 않는다.
- native 호출이 JSON 결과를 반환하면 즉시 `captured`로 원문을 먼저 저장하고 job ID·기록도 검증 전에 저장한다. job 조회 실패는 다음 실행에서 조회만 재시도하고 리뷰를 다시 호출하지 않는다. 원문 16,000바이트 상한 초과는 이유를 알리고 원문·job을 보존한다. 대상을 임의로 재연결하거나 원문을 잘라 완료 결과로 만들지 않는다. JSON 응답 자체를 받기 전 실패한 running 기록은 plugin 원본 job을 사람이 조사해야 한다.
- 같은 결과가 게시됐으면 정확한 원문·성공한 게시 실행·영수증을 검증해 재사용한다. 유사 봇 문구·다른 PR 결과는 사용하지 않는다. 중복 댓글이면 차단한다.
- HTTP 실패·시간 초과는 POST 자동 재시도를 하지 않는다. 댓글만 있고 artifact 기록/실행이 실패하면 미완료 자료로 남고 통과하지 않는다. Actions와 실제 댓글을 사람이 조사한다. wrapper를 재실행해도 기존 완료 ledger가 있으면 추가 AI 호출을 하지 않는다.
- 영수증은 90일 보존한다. 삭제·만료, 게시 코드 승인 버전 변경, 원문 수정, 최신 대상 변경은 차단한다. 복구에는 관리자 조사와 현재 대상의 재등록 결정이 필요하다.
- 마지막 조회와 쓰기 사이 경합을 원자적으로 제거하지 못한다. 이후 HEAD 등이 달라지면 이전 자료로 현재 게이트를 통과하지 못한다.
- 병합 후 감사는 병합 직전 PR·base SHA의 정책/게시 승인 코드를 snapshot으로 고정해, 병합 자체가 정책을 바꾸는 경우와 근거 변조를 구분한다. 댓글·작성자 권한·영수증은 병합 후에도 실제 API로 다시 확인하며 삭제·변조는 차단한다.

## 도입과 롤백

workflow는 기본 브랜치의 승인된 버전만 실행한다. 이 변경 PR에서는 실환경 활성화가 불가능하며 이전 workflow의 차단을 우회하지 않는다. main 반영 뒤 Claude 구현의 별도 PR에서 1회 실운영 검증이 필요하다. 이 PR 자체는 Codex 구현이므로 Claude 독립 검토와 사람 확인을 거쳐 기존 수동 보고서 경로로 도입한다.

문제가 있으면 wrapper를 중단하고 변경을 revert해 수동 보고서로 돌아간다. 기존 승인 댓글·보고서는 수정/삭제하지 않는다.

참고: [OpenAI App Server](https://learn.chatgpt.com/docs/app-server), [GitHub artifact API](https://docs.github.com/en/rest/actions/artifacts), [GITHUB_TOKEN](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token). 로컬 plugin 1.0.6 출력과 대조했으며 형식 변경은 추측해 수용하지 않는다.


## 부록: Codex 플러그인 리뷰 요청과 게이트 변경 이력

README에서 옮긴 내용입니다. 정책의 기준은 [AGENTS.md](../AGENTS.md)와 `.ai/`이며, 아래는 운영 설명과 과거 이력입니다.

### Claude Code에서 Codex 리뷰 요청

Claude Code로 구현한 변경은 [Codex plugin for Claude Code](https://github.com/openai/codex-plugin-cc)로 독립 리뷰를 요청할 수 있습니다. 플러그인은 개발자 컴퓨터에 선택적으로 설치합니다.

- 이 저장소의 `.codex/config.toml`이 Codex 모델(`gpt-6.1-sol`)과 추론 강도(`high`)를 지정합니다. Codex가 이 프로젝트를 신뢰된 프로젝트로 인식할 때만 적용됩니다.
- 역할은 **Claude 구현 → 구현에 참여하지 않은 Codex 검토 → Claude 수정 → 필요한 재검토**로 나눕니다.
- 이 검토는 구현 세션 안에서 진행합니다. 구현과 로컬 검사가 끝나면 Claude가 플러그인 리뷰어(`/codex:review --base main`과 같은 리뷰어)를 실행하고, 수정한 뒤 바뀐 head만 다시 검토합니다.
- 자동 리뷰(Stop 리뷰 게이트, 저장소 전체 Automatic reviews)는 위 검토와 중복되므로 끕니다.
- 위 검토와 별개인 Codex CLI 독립 리뷰(새 세션, 별도 보고서)는 사용자가 직접 요청할 때만 실행합니다.
- PR 전체를 검토할 때는 최신 기준 브랜치와 작업 브랜치의 전체 차이를 대상으로 합니다. 결과에는 base/head 커밋, 검토 범위, 지적사항과 실행하지 못한 검사를 남깁니다.
- 실행 중·취소·스킵·한도 초과는 검토 완료가 아닙니다. 구독 한도에 도달하면 멈추고 유료 API나 추가 결제로 전환하지 않습니다.
- 로컬 로그인 정보와 인증 파일을 저장소에 복사하거나 커밋하지 않습니다.

이 플러그인은 기존 CI, 필요한 독립 검증, PR 결과 기록과 사람 확인을 대체하지 않습니다.

기존에는 로컬 리뷰 결과를 관리자가 보고서 파일에서 복사해야 했습니다. 이제 위 자동 게시 wrapper가 같은 native 플러그인 검토 1회와 Actions 봇 게시를 연결합니다. 로컬 결과는 계속 **미인증 자료**이며, 승인된 게시 실행·댓글 해시·영수증을 확인한 뒤 관리자가 `/review-gate`와 `/merge-approve`를 직접 작성합니다. 관리자 인증 공유와 로컬 실행 인증의 한계는 해결됐다고 취급하지 않습니다.

### 게이트 변경 이력

PR #23(문장 수집 실패), #28(리뷰어 로컬 검사 실패), #34(관리자 검토 자료)는 위 해당 절(`문장 수집 실패 뒤 기존 완료 결과 복구`, `코드 지적과 리뷰어 로컬 검사 구분`, `자동 게시 차단 시 관리자 검토 자료`)에 기록되어 있습니다. 아래는 다른 곳에 기록이 없던 이력입니다.

PR #25 독립 리뷰에서는 필수 CI가 끝나기 전에 게시 요청 이력이 기록돼 재처리가 막히는 문제를 발견했습니다. 회귀 테스트로 재현한 뒤, 요청 자료 준비와 서버와 동일한 CI 출처 검증을 마친 실제 dispatch 직전에만 요청 이력을 기록하도록 수정했습니다. 요청 전 실패는 완료 결과를 보존해 모델 재호출 없이 이어가고, 실제 요청 후 응답 불명확은 재요청하지 않습니다. 다른 게시 결과와의 충돌은 즉시 구분하며, 손상된 봇 보고서는 게시와 확인 경로에서 함께 차단합니다. 확인과 요청 사이 경합은 서버 재검증으로 방어하며 실제 게시 canary는 여전히 후속 검증이 필요합니다.

PR #10에서는 GitHub가 검사 링크를 `/runs/<check ID>`로 반환해 `/actions/runs/<workflow run ID>`만 허용하던 출처 검증이 정상 검사를 차단했습니다. 실제 API 응답으로 재현한 뒤 두 형식을 각각 해당 ID와 정확히 비교하도록 수정했습니다. 링크가 맞아도 앱·PR HEAD·fingerprint·근거 digest와 실제 workflow 실행 ID·저장소·재실행 횟수·승인된 YAML 검증은 모두 통과해야 합니다. 이 검증은 같은 GitHub Actions 앱의 악의적인 workflow나 유출된 관리자 인증까지 완전히 방어한다는 뜻은 아닙니다.

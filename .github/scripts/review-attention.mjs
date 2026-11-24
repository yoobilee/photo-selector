import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { canonical, same, validatePluginResult, localReportsForTarget, verifyEvidenceCi, pluginResultVersion } from './review-evidence-source.mjs';
import { decide, isReportBody, normalizeNewlines, parseConfirmation, reportHash, sha256 } from './review-gate-core.mjs';
import { permissionReader } from './review-gate.mjs';
import { analyzeReviewText, explainReviewText, parserVersion, unknownReasonText } from './review-result-parser.mjs';

// 자동 게시가 차단된 독립 리뷰(unknown·리뷰어 로컬 검사 실패)를 관리자가 판단할 수 있게 자료를 준비한다.
// 기존 완료 ledger와 plugin job 기록은 읽기만 한다. 모델 호출·게시 요청·댓글 작성·승인을 하지 않는다.
// 관리자가 직접 게시한 보고서 댓글을 검증해 기존 게이트 형식의 `/review-gate` 문구만 만든다. 게시는 관리자가 직접 한다.

export const draftMarker = 'photo-selector-admin-review-draft:v1';
export const maxJobLogBytes = 2_000_000;
const maxListedCommands = 80;
const blockingLevels = ['critical', 'high', 'medium'];

export const nodeFiles = {
  exists: existsSync,
  read: path => readFileSync(path, 'utf8'),
  writeNew: (path, content) => writeFileSync(path, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' }),
};

const stop = (code, message) => { throw Object.assign(new Error(message), { code }); };

// wrapper와 같은 대상 식별자. 설명·정책이 바뀌어도 같은 base/head의 ledger를 찾는다. 대상 전체 일치는 따로 확인한다.
export const ledgerKey = target => sha256(canonical({ repository: target.repository, number: target.number, head: target.head, base: target.base }));
export const ledgerFileName = target => `photo-selector-review-${ledgerKey(target)}.json`;

export function attentionPaths(originalPath) {
  return {
    original: originalPath,
    recovered: `${originalPath}.recovered.v3.json`,
    legacyRecovered: `${originalPath}.recovered.json`,
    lock: `${originalPath}.lock`,
    jobLog: `${originalPath}.job-log.json`,
    draft: hash => `${originalPath}.attention-${hash.slice(0, 12)}.md`,
    confirmation: hash => `${originalPath}.review-gate-${hash.slice(0, 12)}.md`,
  };
}

// 내용 hash가 파일명에 들어가므로 같은 내용은 재사용하고 기존 파일을 덮어쓰지 않는다.
export function writeNewOrSame(files, path, content) {
  if (files.exists(path)) {
    if (files.read(path) !== content) stop('review-attention-file-conflict', '같은 이름의 다른 자료 파일이 있음');
    return 'reused';
  }
  files.writeNew(path, content);
  return 'created';
}

// 저장된 결과와 현재 parser 재해석, 복구 기록이면 원본 ledger의 결과까지 함께 비교한다(PR #42 독립 검토·재검증 지적).
// - stored: 판정에 쓰는 기록(복구 기록이 있으면 복구 기록)의 저장 결과. 리뷰 당시 parser의 해석이다.
// - original: 복구 기록일 때 원본 ledger의 저장 결과(v2 결과는 검사 기록이 없다).
// - current: 같은 원문을 현재 parser로 다시 해석한 결과(참고, 저장 결과를 바꾸지 않는다).
// 판정·확인 문구에는 세 해석 중 가장 큰 지적 수(effectiveFindings)와 모든 검사 실패(failedChecks)를 쓴다.
// 그래서 재해석·복구로 unknown·지적·검사 실패가 줄어드는 경로가 없다. 줄었으면 `recovery-reduced`로 따로 알린다.
const findingLevels = ['critical', 'high', 'medium', 'low', 'unknown'];
const count = (findings, level) => Number.isSafeInteger(findings?.[level]) ? findings[level] : 0;
const recordedChecks = value => Array.isArray(value) ? value : null;
export function interpretStoredResult(result, storedParserVersion = null, original = null) {
  const parsed = analyzeReviewText(result?.report);
  const unknownReasons = explainReviewText(result?.report);
  const stored = { parserVersion: storedParserVersion, findings: result?.findings, reviewerChecks: result?.reviewerChecks };
  const current = { parserVersion, findings: parsed.findings, reviewerChecks: parsed.reviewerChecks, unknownReasons };
  const views = [stored, current, ...(original ? [original] : [])];
  const failedChecks = views.flatMap(view => (recordedChecks(view.reviewerChecks) ?? []).filter(item => item?.status === 'failed'))
    .filter((item, index, all) => all.findIndex(other => same(other, item)) === index);
  // 복구 기록이 원본보다 지적을 줄였거나 원본의 검사 기록(실패·미실행 포함)을 빼거나 바꿨는지.
  const recoveryReduced = Boolean(original) && (findingLevels.some(level => count(original.findings, level) > count(stored.findings, level))
    || (recordedChecks(original.reviewerChecks) ?? []).some(item => !(recordedChecks(stored.reviewerChecks) ?? []).some(other => same(other, item))));
  return {
    consistent: same(stored.findings, current.findings) && same(stored.reviewerChecks, current.reviewerChecks),
    stored, original, current, recoveryReduced, failedChecks,
    effectiveFindings: Object.fromEntries(findingLevels.map(level => [level, Math.max(...views.map(view => count(view.findings, level)))])),
    // 저장된 unknown(원본 포함) 중 현재 parser가 사유를 재현하지 못한 수. 사유가 없어도 저장된 unknown을 지우지 않는다.
    unexplainedStoredUnknown: Math.max(0, Math.max(count(stored.findings, 'unknown'), count(original?.findings, 'unknown')) - unknownReasons.length),
  };
}

const checkStatuses = ['passed', 'failed', 'not-run', 'skipped'];
const validStoredCheck = item => item && typeof item === 'object' && !Array.isArray(item)
  && same(Object.keys(item).sort(), ['cause', 'count', 'name', 'status']) && typeof item.name === 'string' && item.name.length > 0 && item.name.length <= 500
  && checkStatuses.includes(item.status) && (item.count === null || (Number.isSafeInteger(item.count) && item.count >= 0))
  && (item.cause === null || (same(Object.keys(item.cause ?? {}).sort(), ['kind', 'text']) && item.cause.kind === 'environment-claimed' && typeof item.cause.text === 'string'));
const validFindings = findings => Boolean(findings) && typeof findings === 'object' && !Array.isArray(findings)
  && same(Object.keys(findings).sort(), [...findingLevels].sort()) && Object.values(findings).every(n => Number.isSafeInteger(n) && n >= 0);
const validChecks = checks => Array.isArray(checks) && checks.length <= 200 && checks.every(validStoredCheck);

// 저장된 결과 검증. 현재 parser와 해석이 같으면 기존 검증(validatePluginResult) 그대로다.
// 다르면 저장된 집계·검사 기록은 형식만 확인하고, 나머지(대상·출처·원문 hash·형식)는 같은 검증 함수로 확인한다. 결과는 저장된 값 그대로 돌려준다.
export function validateStoredResult(input, target, implementedBy, interpretation = interpretStoredResult(input)) {
  if (typeof input?.report !== 'string') throw new Error('저장 결과 원문 오류');
  if (interpretation.consistent) return validatePluginResult(input, target, implementedBy);
  if (!validFindings(input.findings)) throw new Error('저장 결과 지적 집계 형식 오류');
  if (!validChecks(input.reviewerChecks)) throw new Error('저장 결과 검사 기록 형식 오류');
  const validated = validatePluginResult({ ...input, findings: interpretation.effectiveFindings, reviewerChecks: interpretation.current.reviewerChecks }, target, implementedBy);
  return { ...validated, findings: input.findings, reviewerChecks: input.reviewerChecks };
}

// 출력용 해석 요약. 원본(복구 기록일 때)·저장 결과·현재 재해석을 다른 필드로 둔다.
export const interpretationSummary = interpretation => ({
  consistent: interpretation.consistent,
  original: interpretation.original && { parserVersion: interpretation.original.parserVersion, resultVersion: interpretation.original.resultVersion,
    findings: interpretation.original.findings, reviewerChecksRecorded: Array.isArray(interpretation.original.reviewerChecks) },
  stored: { parserVersion: interpretation.stored.parserVersion, findings: interpretation.stored.findings },
  current: { parserVersion: interpretation.current.parserVersion, findings: interpretation.current.findings, unknownReasons: interpretation.current.unknownReasons,
    reviewerChecksMatch: same(interpretation.stored.reviewerChecks, interpretation.current.reviewerChecks) },
  recoveryReduced: interpretation.recoveryReduced, effectiveFindings: interpretation.effectiveFindings, unexplainedStoredUnknown: interpretation.unexplainedStoredUnknown,
});

// 복구 대상이 될 수 있는 원본 결과(v2·v3). 재해석에 쓰는 대상·완료 상태·출처·원문만 확인한다.
export const recoverableOriginal = (result, target) => [2, pluginResultVersion].includes(result?.v) && same(result.target, target)
  && result.status === 'completed' && result.reviewComplete === true && typeof result.report === 'string' && result.report.trim().length > 0
  && result.source?.kind === 'codex-plugin' && result.source.outputHash === reportHash(result.report);

const manualRecovery = message => stop('review-recovery-manual', message);
const parseJson = (text, onError) => { try { return JSON.parse(text); } catch { return onError(); } };

// 완료 ledger를 읽는 공통 기준. wrapper 일반 실행·--recover·관리자 초안·`--confirm`이 모두 이 함수로 같은 기록·판정을 얻는다.
// 복구 기록(.recovered.v3.json)이 있으면 그 기록으로 판정하되 원본 ledger 검증을 생략하지 않는다.
// 원본은 완료 상태·같은 대상·같은 세션·게시 요청 기록 없음·복구 가능한 결과여야 하고, 복구 기록과 같은 원문·출처(job·thread·turn·완료 시각·원문 hash)·
// 원본 hash·v2 복구 파일 hash로 연결돼야 한다. 하나라도 어긋나면 `review-recovery-manual`로 중단한다. 어떤 파일도 쓰지 않는다.
export function loadStoredLedger({ paths, target, implementedBy, files, session = null, ignoreLock = false, rejectRequested = false }) {
  if (!ignoreLock && files.exists(paths.lock)) stop('review-attention-busy', '리뷰 wrapper 실행 중 lock 존재');
  const recovered = files.exists(paths.recovered);
  if (!recovered && files.exists(paths.legacyRecovered)) manualRecovery('v2 복구 기록은 사람이 확인');
  const path = recovered ? paths.recovered : paths.original;
  if (!files.exists(path)) stop('review-attention-no-ledger', '완료 ledger 없음');
  const text = files.read(path);
  const ledger = parseJson(text, () => stop('review-attention-ledger-invalid', 'ledger 형식 오류'));
  if (ledger?.state !== 'completed' || !same(ledger.target, target) || (session !== null && ledger.session !== session)) {
    stop('review-attention-ledger-invalid', '완료 상태가 아니거나 현재 PR 대상·세션과 다름');
  }
  let original = null;
  if (recovered) {
    if (!files.exists(paths.original)) manualRecovery('복구 기록의 원본 ledger 없음');
    const originalText = files.read(paths.original);
    const source = parseJson(originalText, () => manualRecovery('원본 ledger 형식 오류'));
    const legacyExists = files.exists(paths.legacyRecovered);
    const legacyHash = ledger.recovery?.legacyRecoveredHash ?? null;
    if (source?.state !== 'completed' || !same(source.target, target) || source.session !== ledger.session
        || source.publicationRequested !== undefined || source.publication !== undefined
        || ledger.recovery?.originalLedgerHash !== sha256(originalText)
        || !recoverableOriginal(source.result, target) || !validFindings(source.result.findings)
        || (source.result.v === pluginResultVersion && !validChecks(source.result.reviewerChecks))
        || ledger.result?.report !== source.result.report || !same(ledger.result?.source, source.result.source)
        || (legacyExists ? legacyHash !== sha256(files.read(paths.legacyRecovered)) : legacyHash !== null)) {
      manualRecovery('복구 기록과 원본 ledger 연결 불일치');
    }
    original = { parserVersion: source.parserVersion ?? null, resultVersion: source.result.v, findings: source.result.findings,
      reviewerChecks: source.result.v === pluginResultVersion ? source.result.reviewerChecks : null };
  }
  const publicationRequested = ledger.publicationRequested !== undefined || ledger.publication !== undefined;
  if (rejectRequested && publicationRequested) stop('review-attention-publication-requested', '이미 게시 요청한 결과');
  // 복구 기록은 복구 시점 parser 버전, 원래 ledger는 기록한 parser 버전(이 기록을 남기기 이전 wrapper는 없음)을 쓴다.
  const storedParserVersion = (recovered ? ledger.recovery?.parserVersion : ledger.parserVersion) ?? null;
  const interpretation = interpretStoredResult(ledger.result, storedParserVersion, original);
  let result;
  try { result = validateStoredResult(ledger.result, target, implementedBy, interpretation); } catch (error) {
    if (error.code === 'review-report-too-large') throw error;
    stop('review-attention-ledger-invalid', '완료 결과 형식 오류');
  }
  return { path, ledgerHash: sha256(text), ledger, session: ledger.session, result, interpretation, recovered, storedParserVersion, publicationRequested };
}

// 관리자 자료(초안·`--confirm`)용. 공통 기준으로 읽고, 이미 게시 요청한 결과는 다루지 않는다. 차단 여부는 job 로그와 함께 requireBlocked로 판단한다.
export const readAttentionLedger = ({ paths, target, implementedBy, files, ignoreLock = false }) =>
  loadStoredLedger({ paths, target, implementedBy, files, ignoreLock, rejectRequested: true });

// job 실행 기록 기준 자동 게시 차단 사유(Issue #41). 원문이 지적 없음·검사 통과로 해석돼도
// 로그를 확인할 수 없거나 exit 0이 아닌 명령, 완료 기록 없는 명령, 실행 여부를 구분할 수 없는 줄이 있으면 게시하지 않는다.
// 로그의 명령은 96자에서 잘리고 출력이 없어 실패 원인을 판단할 수 없다. 원인 미상 실패를 통과로 처리하지 않는다.
// 명령 개수만으로는 판단하지 않는다(PR #42 독립 검토 지적). 0바이트·시작 이벤트만 남은·중간에 잘린 로그도 명령 목록은 비어 있다.
// 리뷰 시작부터 원문 기록·최종 출력까지 완료 증거(completion)가 모두 있어야 "명령 없이 정상 종료"로 본다.
export const jobLogCompleted = jobLog => Boolean(jobLog?.completion?.reviewStarted && jobLog.completion.reviewOutput && jobLog.completion.finalOutput);
export function jobLogBlockers(jobLog) {
  if (jobLog?.status !== 'captured') return ['job-log-unverified'];
  const blockers = [];
  if (jobLog.commands.some(item => item.status !== 'completed' || item.exitCode !== 0)) blockers.push('job-command-failed');
  if (jobLog.unfinished.length || jobLog.ambiguous.length) blockers.push('job-log-incomplete');
  if (!jobLogCompleted(jobLog)) blockers.push('job-log-not-completed');
  return blockers;
}
// 원문 기준 차단 사유. 원본·저장·현재 해석 중 하나라도 지적·unknown·검사 실패가 있으면 차단한다.
// 해석이 하나뿐(일치, 복구 아님)이면 기존 판정(localPublicationBlockers)과 같다.
// 저장 결과와 현재 재해석이 다르면 `parser-mismatch`, 복구 기록이 원본 판정을 줄였으면 `recovery-reduced`를 더한다.
export function reportBlockers(result, interpretation = interpretStoredResult(result)) {
  const blockers = [];
  if (['critical', 'high', 'medium', 'unknown'].some(level => interpretation.effectiveFindings[level] !== 0)) blockers.push('findings');
  if (interpretation.failedChecks.length) blockers.push('reviewer-check-failed');
  if (!interpretation.consistent) blockers.push('parser-mismatch');
  if (interpretation.recoveryReduced) blockers.push('recovery-reduced');
  return blockers;
}
// 이미 게시 요청한 기록도 해석이 서로 다르거나 복구가 판정을 줄였으면 영수증·재요청 경로에 넣지 않는다.
export const interpretationDisagrees = interpretation => !interpretation.consistent || interpretation.recoveryReduced;
export const attentionBlockers = (result, jobLog, interpretation = interpretStoredResult(result)) => [...reportBlockers(result, interpretation), ...jobLogBlockers(jobLog)];
export function requireBlocked(result, jobLog, interpretation = interpretStoredResult(result)) {
  const blockers = attentionBlockers(result, jobLog, interpretation);
  if (!blockers.length) stop('review-attention-not-blocked', '자동 게시 대상 결과');
  return blockers;
}
export const blockedState = blockers => blockers.includes('findings') ? 'review-needs-attention'
  : blockers.includes('reviewer-check-failed') ? 'review-checks-need-attention'
    : blockers.includes('recovery-reduced') ? 'review-recovery-needs-attention'
      : blockers.includes('parser-mismatch') ? 'review-parser-needs-attention' : 'review-job-log-needs-attention';

// plugin job 로그(Codex 명령 실행 기록). codex-companion 1.0.6은 이벤트 줄을 빈 줄 없이 쓰고,
// 리뷰어가 쓴 글(Assistant message·Review output·Reasoning summary·Final output 등)은 빈 줄 + 제목 줄로 시작하는 블록으로 쓴다.
// 블록 본문은 끝 표시가 없어 그 뒤 줄이 실제 이벤트인지 리뷰어 글인지 구분할 수 없다.
// 그래서 첫 블록(첫 빈 줄) 이후의 명령 형식 줄은 실행 기록으로 세지 않고 확인 불가(ambiguous)로만 센다.
const timestamp = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z`;
const completedLine = new RegExp(`^\\[(${timestamp})\\] Command ([A-Za-z]+): (.+) \\(exit (-?\\d+|\\?)\\)$`);
const startedLine = new RegExp(`^\\[(${timestamp})\\] Running command: (.+)$`);
const blockTitleLine = new RegExp(`^\\[${timestamp}\\] (?:Final output|Assistant message|Review output|Reasoning summary|Subagent .+ (?:message|reasoning summary))$`);
const eventLine = new RegExp(`^\\[${timestamp}\\] `);
const event = text => new RegExp(`^\\[${timestamp}\\] ${text}$`);
const jobStartLine = event(String.raw`Starting Codex Review\.`);
const reviewerStartedLine = event('Reviewer started: .+');
const reviewCapturedLine = event(String.raw`Review output captured\.`);
const reviewOutputTitle = event('Review output');
const finalOutputTitle = event('Final output');
const reviewerFinishedLine = event(String.raw`Reviewer finished\.`);

// 리뷰 완료 증거(codex-companion 1.0.6 코드와 실제 로그 확인).
// - 쓰는 방식: appendLogLine은 "[시각] 메시지" 한 줄, appendLogBlock은 빈 줄 + "[시각] 제목" + 본문을 쓴다. 블록 본문에는 끝 표시가 없다.
// - 순서: "Starting Codex Review." → (thread 준비) → "Reviewer started: …" → 명령 이벤트·진행 블록(Assistant message·Reasoning summary·Subagent …)
//   → "Review output captured." + 원문 블록(Review output, 본문 = 리뷰 원문) → "Reviewer finished." → … → job 완료 기록 뒤 마지막 Final output 블록.
// 진행 블록 본문은 리뷰어가 쓴 글이며 plugin이 따로 보관하지 않아(Assistant message) 본문이 어디서 끝나는지 알 수 없다.
// 그래서 판별은 내용을 아는 부분만으로 한다.
// - reviewStarted: 첫 블록 전(신뢰 구간)의 첫 줄 "Starting Codex Review."와 "Reviewer started: …". 블록 안의 같은 문장은 세지 않는다.
// - reviewOutput: [Review output captured. / 빈 줄 / Review output 제목 / 저장된 원문과 정확히 같은 본문 / Reviewer finished.]의 고정 순서가
//   로그 전체에서 정확히 한 번 나타남. 진행 블록이 앞에 있어도 된다. 블록 안에 같은 순서를 위조해 두 번 이상 나타나면 실제 기록을 특정할 수 없어 인정하지 않는다.
// - finalOutput: 원문 블록 뒤의 마지막 블록이 Final output이고 본문에 원문이 있음.
// 한계: 진행 블록 안에 이 순서 전체를 위조하고 실제 원문 블록이 없는 로그는 구분할 수 없다. 완료된 native 리뷰는 원문 블록을 항상 쓰므로
// 실제 기록에서는 생기지 않지만, 로컬 로그는 미인증 자료이며 관리자 확인이 계속 필요하다. 진행 블록 뒤의 명령 줄은 parseJobCommands가 확인 불가로 센다.
function jobCompletion(lines, report) {
  const expected = typeof report === 'string' ? normalizeNewlines(report).trimEnd() : '';
  const firstBlock = lines.findIndex(line => !line.trim() || blockTitleLine.test(line));
  const trusted = lines.slice(0, firstBlock < 0 ? lines.length : firstBlock);
  const reviewStarted = jobStartLine.test(trusted[0] ?? '') && trusted.some(line => reviewerStartedLine.test(line));
  const body = expected ? expected.split('\n') : null;
  const ends = [];
  if (body) {
    for (let i = 0; i + body.length + 4 <= lines.length; i++) {
      if (!reviewCapturedLine.test(lines[i]) || lines[i + 1] !== '' || !reviewOutputTitle.test(lines[i + 2])) continue;
      if (body.every((line, offset) => lines[i + 3 + offset] === line) && reviewerFinishedLine.test(lines[i + 3 + body.length])) ends.push(i + 3 + body.length);
    }
  }
  const reviewOutput = ends.length === 1;
  let lastBlock = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i - 1] === '' && blockTitleLine.test(lines[i])) lastBlock = i;
  const finalOutput = reviewOutput && lastBlock > ends[0] && finalOutputTitle.test(lines[lastBlock]) && lines.slice(lastBlock + 1).join('\n').includes(expected);
  return { reviewStarted, reviewOutput, finalOutput };
}

export function parseJobCommands(log, report = null) {
  const commands = []; const unfinished = []; const ambiguous = [];
  let trusted = true;
  const lines = normalizeNewlines(log).split('\n');
  for (const line of lines) {
    if (!line.trim() || blockTitleLine.test(line)) { trusted = false; continue; }
    if (!trusted) {
      const looks = completedLine.exec(line) ?? startedLine.exec(line);
      if (looks) ambiguous.push(completedLine.test(line) ? looks[3] : looks[2]);
      continue;
    }
    const done = completedLine.exec(line);
    if (done) {
      const index = unfinished.indexOf(done[3]);
      if (index >= 0) unfinished.splice(index, 1);
      commands.push({ at: done[1], status: done[2], command: done[3], exitCode: done[4] === '?' ? null : Number(done[4]), truncated: done[3].endsWith('...') });
      continue;
    }
    const started = startedLine.exec(line);
    if (started) unfinished.push(started[2]);
  }
  return { commands, unfinished, ambiguous, completion: jobCompletion(lines, report) };
}

const jobMatches = (job, source) => job && job.id === source.jobId && job.threadId === source.threadId && job.turnId === source.turnId
  && job.completedAt === source.completedAt && job.outputHash === source.outputHash;

// 저장한 job 로그 사본을 ledger의 job·원문 hash와 대조한다. 없거나 다르면 확인 불가로 표시한다.
export function loadJobLog({ paths, result, files }) {
  if (!files.exists(paths.jobLog)) return { status: 'missing', reason: 'job 로그 사본이 없습니다. plugin job은 Claude 세션 종료 시 정리되므로 wrapper가 차단 직후 같은 세션에서만 저장할 수 있습니다.' };
  let snapshot;
  try { snapshot = JSON.parse(files.read(paths.jobLog)); } catch { snapshot = null; }
  if (snapshot?.v !== 1 || !jobMatches(snapshot, result.source) || typeof snapshot.log !== 'string' || sha256(snapshot.log) !== snapshot.logSha256) {
    return { status: 'invalid', reason: 'job 로그 사본이 ledger의 job·원문과 일치하지 않거나 손상됐습니다.' };
  }
  return { status: 'captured', logSha256: snapshot.logSha256, capturedAt: snapshot.capturedAt, ...parseJobCommands(snapshot.log, result.report) };
}

// 차단 직후 기존 job 기록만 조회해 로그 사본을 남긴다. `result <job>`은 저장된 결과 조회이며 리뷰를 실행하지 않는다.
export function captureJobLog({ plugin, result, paths, files, now }) {
  if (files.exists(paths.jobLog)) return loadJobLog({ paths, result, files });
  const unavailable = reason => ({ status: 'unavailable', reason });
  const source = result.source;
  let stored;
  try { stored = plugin(['result', source.jobId, '--json']); } catch { return unavailable('plugin job 기록을 조회하지 못했습니다. 세션 종료로 정리됐을 수 있습니다.'); }
  const job = stored?.storedJob;
  if (!job || job.id !== source.jobId || job.threadId !== source.threadId || job.turnId !== source.turnId || job.completedAt !== source.completedAt
      || job.sessionId !== source.sessionId || typeof job.result?.codex?.stdout !== 'string' || normalizeNewlines(job.result.codex.stdout) !== result.report) {
    return unavailable('plugin job 기록이 ledger의 job·세션·원문과 일치하지 않습니다.');
  }
  if (typeof job.logFile !== 'string' || !job.logFile) return unavailable('plugin job 기록에 로그 파일 경로가 없습니다.');
  let log;
  try { log = files.read(job.logFile); } catch { return unavailable('plugin job 로그 파일을 읽지 못했습니다.'); }
  if (Buffer.byteLength(log) > maxJobLogBytes) return unavailable('plugin job 로그가 크기 상한을 넘었습니다.');
  const snapshot = { v: 1, id: source.jobId, threadId: source.threadId, turnId: source.turnId, completedAt: source.completedAt,
    outputHash: source.outputHash, capturedAt: now(), logSha256: sha256(log), log };
  files.writeNew(paths.jobLog, JSON.stringify(snapshot));
  return { status: 'captured', logSha256: snapshot.logSha256, capturedAt: snapshot.capturedAt, ...parseJobCommands(log, result.report) };
}

// 초안 marker. 같은 대상·ledger·원문·job에서 만든 초안만 `/review-gate` 준비에 쓴다.
export const draftKey = ({ target, ledgerHash, result }) => sha256(canonical({ v: 1, target, ledgerHash, outputHash: result.source.outputHash, jobId: result.source.jobId }));

// 표준 검사는 명령 전체가 그 검사의 직접 실행일 때만 인식한다(PR #37 리뷰 지적: 부분 문자열 일치는 검색 명령도 실행으로 셌다).
// 셸 감싸기(powershell/pwsh/bash/sh/cmd -Command|-c|/c '...')는 한 겹만 벗긴다. 잘린 명령, 파이프·연결(|, ;, &&, ||, >, <),
// 그 밖의 형태는 분류하지 않는다. 분류하지 않은 명령도 4절 전체 명령 표에는 남는다.
const standardChecks = [
  ['Lint', 'npm run lint', /^npm(?:\.cmd)? run lint(?: --(?: \S+)*)?$/],
  ['Type Check', 'npm run typecheck', /^npm(?:\.cmd)? run typecheck(?: --(?: \S+)*)?$/],
  ['단위 테스트', 'npm run test', /^npm(?:\.cmd)? (?:run )?test(?: --(?: \S+)*)?$/],
  ['Build', 'npm run build', /^npm(?:\.cmd)? run build(?: --(?: \S+)*)?$/],
  ['E2E', 'npm run test:e2e', /^npm(?:\.cmd)? run test:e2e(?: --(?: \S+)*)?$/],
  ['리뷰 게이트 테스트', 'npm run test:gate', /^npm(?:\.cmd)? run test:gate(?: --(?: \S+)*)?$/],
  ['전체 검증', 'npm run verify', /^npm(?:\.cmd)? run verify(?: --(?: \S+)*)?$/],
];
const shellWrapper = /^(?:"[^"]*[\\/](?:powershell|pwsh|bash|sh|cmd)(?:\.exe)?"|(?:\S*[\\/])?(?:powershell|pwsh|bash|sh|cmd)(?:\.exe)?)(?: -NoProfile)? (?:-Command|-c|\/c) (?:'([^']*)'|"([^"]*)")$/i;
export function directInvocation(command) {
  if (typeof command !== 'string' || command.endsWith('...')) return null;
  const wrapped = shellWrapper.exec(command);
  const inner = (wrapped ? wrapped[1] ?? wrapped[2] : command).trim();
  if (!inner || /[|;&<>`$()]/.test(inner)) return null;
  return inner;
}
export const classifyCheck = command => {
  const inner = directInvocation(command);
  return inner === null ? null : standardChecks.find(([, , pattern]) => pattern.test(inner))?.[0] ?? null;
};
const checkStatus = { passed: '통과', failed: '실패', 'not-run': '미실행', skipped: '건너뜀' };
const blockerText = {
  findings: '`findings`: 코드 지적(critical/high/medium) 또는 판단 불가(unknown)가 0건이 아님',
  'reviewer-check-failed': '`reviewer-check-failed`: 리뷰어가 원문에서 로컬 검사 실패를 보고함',
  'job-log-unverified': '`job-log-unverified`: plugin job 실행 기록을 확보·대조하지 못함(4절)',
  'job-command-failed': '`job-command-failed`: job 기록에 exit 0이 아니거나 종료 코드가 없는 명령이 있음. 명령이 잘리고 출력이 없어 원인을 판단할 수 없음(4절)',
  'job-log-incomplete': '`job-log-incomplete`: job 기록에 완료 기록 없는 명령 또는 실행 여부를 구분할 수 없는 명령 형식 줄이 있음(4절)',
  'job-log-not-completed': '`job-log-not-completed`: job 기록에 리뷰 시작·원문 기록·최종 출력의 완료 증거가 모두 있지 않음. 빈 로그·잘린 로그·다른 job 로그일 수 있으며 명령 0건을 미실행이나 정상 종료로 보지 않음(4절)',
  'parser-mismatch': '`parser-mismatch`: 리뷰 당시 저장된 해석(지적 집계·리뷰어 검사)과 현재 parser 재해석이 다름. 저장 결과를 유지하고 재해석으로 바꾸거나 게시하지 않음(2·3절)',
  'recovery-reduced': '`recovery-reduced`: 복구 기록이 원본 ledger보다 지적·unknown을 줄였거나 원본의 검사 기록을 빼거나 바꿈. 원본 판정을 유지하고 게시하지 않음(2·3절)',
};
const completionText = completion => [['리뷰 시작(Starting Codex Review·Reviewer started)', completion?.reviewStarted],
  ['리뷰 원문 기록(Review output captured + 원문 일치)', completion?.reviewOutput], ['최종 출력(마지막 Final output 블록, 원문 포함)', completion?.finalOutput]]
  .map(([name, ok]) => `${name} ${ok ? '있음' : '없음'}`).join(', ');
const parserLabel = version => version ? `parser v${version}` : 'parser 버전 기록 없음(이 기록을 남기기 이전 wrapper)';

const cell = text => String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const code = text => {
  const value = String(text).replace(/\r?\n/g, ' ');
  const ticks = '`'.repeat(Math.max(0, ...[...value.matchAll(/`+/g)].map(m => m[0].length)) + 1);
  return ticks.length > 1 ? `${ticks} ${value} ${ticks}` : `\`${value}\``;
};
// GFM 표에서는 코드 표기 안의 `|`도 칸을 나눈다. `\|`로 바꾸면 코드 안에서 `|`로 표시된다(PR #37 리뷰 지적).
const cellCode = text => code(String(text).replace(/\|/g, '\\|'));
// 리뷰어 글에서 나온 줄은 길이 제한 없이 들어올 수 있어 표시 길이를 줄인다.
const clip = (text, limit = 160) => text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
const fence = text => '~'.repeat(Math.max(3, ...[...text.matchAll(/~+/g)].map(m => m[0].length + 1)));
const exitText = item => `${item.exitCode === null ? 'exit ?' : `exit ${item.exitCode}`}${item.status === 'completed' ? '' : ` (${item.status})`}`;

// 명령 문자열의 사용자 홈 경로는 `~`로 바꾼다. 리뷰 원문은 대조를 위해 바꾸지 않는다.
const redactor = homeDir => {
  const variants = homeDir ? [...new Set([homeDir, homeDir.replace(/\\/g, '/'), homeDir.replace(/\\/g, '\\\\')])].sort((a, b) => b.length - a.length) : [];
  return text => variants.reduce((value, variant) => value.split(variant).join('~'), text);
};

// wrapper 출력용 job 기록 요약. 전체 명령 표는 관리자 초안 4절에 있다.
export function jobLogSummary(jobLog, homeDir = null) {
  if (jobLog?.status !== 'captured') return { status: jobLog?.status ?? 'unavailable', reason: jobLog?.reason ?? null };
  const redact = redactor(homeDir);
  const failed = jobLog.commands.filter(item => item.status !== 'completed' || item.exitCode !== 0);
  return { status: 'captured', reason: null, commands: jobLog.commands.length,
    failedCommands: failed.slice(0, 20).map(item => ({ command: redact(item.command), status: item.status, exitCode: item.exitCode, truncated: item.truncated })),
    failedCommandCount: failed.length, unfinished: jobLog.unfinished.length, ambiguous: jobLog.ambiguous.length,
    completed: jobLogCompleted(jobLog), completion: { ...jobLog.completion } };
}

// unknown 사유 한 줄 표시. 발췌는 리뷰 원문의 일부다.
export const unknownReasonLine = reason => `${unknownReasonText[reason.kind] ?? reason.kind}${reason.excerpt ? `: ${code(clip(reason.excerpt, 200))}` : ''}${reason.checks ? `: ${reason.checks.map(code).join(', ')}` : ''}`;

function uncertainties({ result, jobLog, remoteChecks, interpretation }) {
  const items = [];
  // 원본·저장 결과·현재 재해석의 검사 실패를 모두 보여 준다. 같은 항목은 한 번만 쓴다.
  const failures = interpretation.failedChecks;
  const unknown = interpretation.effectiveFindings.unknown;
  if (unknown) items.push(`unknown ${unknown}건: 원문 일부가 자동 해석 문법 밖이거나, 원인 미상 검사 실패·사용량 한도·형식 이상 표현이 있습니다. 결함 없음이나 검사 성공을 뜻하지 않습니다.`);
  if (!interpretation.consistent) items.push(`리뷰 당시 저장된 해석(${parserLabel(interpretation.stored.parserVersion)})과 현재 parser v${interpretation.current.parserVersion} 재해석이 다릅니다. 어느 해석도 실행 증명이 아니며, 재해석 결과로 저장된 unknown·검사 기록을 대체하지 않았습니다.`);
  if (interpretation.recoveryReduced) items.push('복구 기록이 원본 ledger보다 지적·unknown을 줄였거나 원본의 검사 기록을 빼거나 바꿨습니다. 복구 결과로 원본 판정을 대체하지 않았습니다.');
  for (const item of failures) {
    items.push(item.cause
      ? `${code(item.name)} 실패의 환경 원인("${cell(item.cause.text)}")은 리뷰어의 주장이며 확인되지 않았습니다.`
      : `${code(item.name)} 실패는 원인이 밝혀지지 않아 코드 결함 가능성을 배제할 수 없습니다.`);
  }
  if (jobLog.status !== 'captured') items.push(`job 실행 기록 확인 불가: ${jobLog.reason}`);
  else {
    if (!jobLogCompleted(jobLog)) items.push('job 로그에 리뷰 완료 증거가 모두 있지 않아 기록 유실·잘림 또는 다른 job 로그일 가능성을 배제할 수 없습니다. 명령 기록이 없거나 적어도 미실행·정상 종료로 보지 않습니다.');
    if (jobLog.commands.some(item => item.truncated)) items.push('job 로그의 명령 문자열은 96자에서 잘립니다(`...`로 끝나는 항목). Windows에서는 셸 경로가 앞에 붙어 실제 명령이 잘려 5절 표에 "기록 없음"으로 보일 수 있으니 4절 전체 명령 표를 함께 확인하세요.');
    if (jobLog.unfinished.length) items.push(`완료 기록 없이 시작만 기록된 명령 ${jobLog.unfinished.length}건이 있습니다.`);
    const failed = jobLog.commands.filter(item => item.exitCode !== 0);
    if (failed.length) items.push(`job 기록에서 exit 0이 아닌 명령 ${failed.length}건이 있습니다. 실패한 테스트 파일·원인은 이 기록만으로 특정되지 않습니다.`);
    if (jobLog.ambiguous.length) items.push(`리뷰어 글 블록 시작 이후 명령 형식의 줄 ${jobLog.ambiguous.length}건은 실제 실행인지 리뷰어가 쓴 글인지 구분할 수 없어 실행 기록으로 세지 않았습니다.`);
  }
  const notPassed = remoteChecks.filter(item => item.state !== 'success');
  if (notPassed.length) items.push(`원격 필수 CI가 성공 상태가 아닙니다: ${notPassed.map(item => `${item.name}=${item.state}`).join(', ')}.`);
  items.push('native plugin은 명령별 검사 결과를 구조화해 제공하지 않으며, 리뷰 원문이 실행한 모든 명령을 나열한다는 보장이 없습니다.');
  items.push('로컬 ledger·job 로그는 같은 기기의 사용자·Agent가 바꿀 수 있는 미인증 자료입니다. 실제 실행과 독립성은 관리자가 확인합니다.');
  items.push('원격 CI 결과는 별도 환경의 검증이며 리뷰어 로컬 검사 실패를 통과로 바꾸는 근거가 아닙니다.');
  return items;
}

// 관리자 검토 초안. 게이트가 읽는 관리자 보고서 형식(제목·대상 SHA)을 따른다. 관리자 판단 절은 비워 둔다.
// GitHub 댓글 본문 상한(65,536자)보다 여유 있게 제한한다. 넘으면 명령 목록을 생략하고 원문은 유지한다(PR #37 리뷰 지적).
export const maxDraftChars = 60_000;
export function buildAttentionDraft(input, listLimit = maxListedCommands) {
  const { target, risk, implementedBy, result, blockers, ledger, jobLog, remoteChecks, homeDir = null } = input;
  const interpretation = input.interpretation ?? ledger.interpretation ?? interpretStoredResult(result, ledger.storedParserVersion ?? null);
  const key = draftKey({ target, ledgerHash: ledger.ledgerHash, result });
  const redact = redactor(homeDir);
  const f = result.findings;
  const current = interpretation.current;
  const original = interpretation.original;
  const effective = interpretation.effectiveFindings;
  const state = blockedState(blockers);
  const reasons = current.unknownReasons;
  const blocking = blockingLevels.reduce((sum, level) => sum + effective[level], 0);
  const findingsRow = (label, value) => `| ${label} | ${value.critical} | ${value.high} | ${value.medium} | ${value.low} | ${value.unknown} |`;
  const lines = [
    '# 독립 리뷰 보고서', '', `<!-- ${draftMarker} ${key} -->`, '',
    '> **관리자 검토 초안(자동 생성)**: Codex 독립 리뷰의 자동 게시가 차단되어 기존 완료 ledger와 job 기록으로 만든 자료입니다. 관리자가 원문과 기록을 확인하고 "8. 관리자 판단"을 직접 작성한 뒤 본인 계정으로 게시합니다. 이 초안은 관리자 확인·`/review-gate`·병합 승인이 아닙니다.',
    '', '## 검토 대상', '',
    `- 저장소: \`${target.repository}\``, `- PR: #${target.number}`,
    `- 구현자: ${implementedBy === 'claude' ? 'Claude Code' : implementedBy} (\`implemented-by: ${implementedBy}\`)`,
    '- 독립 리뷰어: Codex (native 플러그인)', `- 위험도: ${risk}`,
    `- Base SHA: \`${target.base}\``, `- Head SHA: \`${target.head}\``,
    `- Fingerprint: \`${target.fingerprint}\``, `- 정책 SHA: \`${target.policySha}\``,
    `- Codex job: \`${result.source.jobId}\` (thread \`${result.source.threadId}\`, turn \`${result.source.turnId}\`)`,
    `- 리뷰 시작·완료: ${result.source.startedAt} → ${result.source.completedAt}`,
    `- 리뷰 원문 SHA-256: \`${result.source.outputHash}\` (ledger 기록값과 재계산 일치)`,
    `- 로컬 ledger: \`${basename(ledger.path)}\` (SHA-256 \`${ledger.ledgerHash}\`, 상태 completed, 게시 요청 기록 없음${ledger.recovered ? `, 복구 기록(복구 시 ${parserLabel(ledger.storedParserVersion)})` : ''})`,
    '', '## 1. 자동 게시 차단 사유', '', `- 상태: \`${state}\``, '- 차단 항목:',
    ...blockers.map(item => `  - ${blockerText[item] ?? code(item)}`),
    '- wrapper는 fail-closed 정책에 따라 게시를 요청하지 않았습니다. 새 리뷰·자동 재시도·결과 수정·실패 기록 삭제를 하지 않았습니다.',
    '', '## 2. 코드 지적 (리뷰 원문 집계)', '',
    '| 해석 | Critical | High | Medium | Low | Unknown |', '|---|---|---|---|---|---|',
    ...(original ? [findingsRow(`원본 ledger 저장 결과 (결과 v${original.resultVersion}, ${parserLabel(original.parserVersion)})`, original.findings)] : []),
    findingsRow(`${ledger.recovered ? '복구 기록' : '리뷰 당시'} 저장 결과 (${parserLabel(interpretation.stored.parserVersion)})`, f),
    findingsRow(`현재 parser v${current.parserVersion} 재해석 (참고, 저장 결과를 바꾸지 않음)`, current.findings),
    findingsRow('판정에 쓰는 값 (각 항목의 최댓값)', effective), '',
    interpretation.consistent ? '- 저장 결과와 현재 parser 재해석(지적 집계·리뷰어 검사)이 같습니다.'
      : '- 저장 결과와 현재 parser 재해석이 다릅니다(`parser-mismatch`). 저장 결과를 유지하고 자동 게시하지 않습니다.',
    ...(interpretation.recoveryReduced ? ['- 복구 기록이 원본 ledger의 판정을 줄였습니다(`recovery-reduced`). 원본 판정을 유지하고 자동 게시하지 않습니다.'] : []),
    '- 판정·확인 문구에는 위 해석 중 각 항목의 최댓값을 씁니다.',
    blocking ? `- 차단 지적 ${blocking}건이 있습니다. 이 리뷰로 통과 확인을 만들 수 없으며 수정 후 새 HEAD를 다시 리뷰해야 합니다.`
      : '- critical/high/medium 지적은 없습니다. unknown은 결함 없음이나 검사 성공을 뜻하지 않습니다.',
  ];
  if (reasons.length) lines.push(`- unknown 사유(현재 parser v${current.parserVersion} 재해석 진단, 발췌는 리뷰 원문 일부):`, ...reasons.map(reason => `  - ${unknownReasonLine(reason)}`));
  if (interpretation.unexplainedStoredUnknown) {
    lines.push(`- 저장된 unknown ${f.unknown}건 중 ${interpretation.unexplainedStoredUnknown}건은 현재 parser로 사유를 재현할 수 없습니다. 리뷰 당시 판정이므로 유지하며 결함 없음·검사 통과로 보지 않습니다. 부록의 원문을 직접 확인하세요.`);
  }
  const checkTable = checks => ['| 검사 | 결과 | 개수 | 원인 주장 |', '|---|---|---|---|',
    ...checks.map(item => `| ${cellCode(item.name)} | ${checkStatus[item.status] ?? cell(item.status)} | ${item.count ?? '-'} | ${item.cause ? `${cell(item.cause.text)} (확인 안 됨)` : '-'} |`)];
  lines.push('', '## 3. 리뷰어가 원문에 보고한 로컬 검사 (주장, 실행 증명 아님)', '');
  if (result.reviewerChecks.length) lines.push(...checkTable(result.reviewerChecks));
  else lines.push('- 자동 해석된 검사 문장이 없습니다. 부록의 원문을 직접 확인하세요.');
  if (!same(result.reviewerChecks, current.reviewerChecks)) {
    lines.push('', `- 위 표는 리뷰 당시 저장된 기록입니다. 현재 parser v${current.parserVersion}로 다시 해석한 검사는 아래와 같으며 참고용입니다(저장 기록을 바꾸지 않음).`, '');
    if (current.reviewerChecks.length) lines.push(...checkTable(current.reviewerChecks));
    else lines.push('- 현재 parser로 해석된 검사 문장이 없습니다.');
  }
  if (original && !Array.isArray(original.reviewerChecks)) lines.push('', `- 원본 ledger 결과(v${original.resultVersion})에는 리뷰어 검사 기록이 없습니다.`);
  else if (original && !same(original.reviewerChecks, result.reviewerChecks)) {
    lines.push('', '- 원본 ledger에 저장된 검사 기록은 아래와 같으며 복구 기록과 다릅니다(원본 기록을 유지).', '');
    if (original.reviewerChecks.length) lines.push(...checkTable(original.reviewerChecks));
    else lines.push('- 원본 ledger에는 해석된 검사 문장이 없습니다.');
  }
  if (effective.unknown) lines.push('', '- 원문 일부가 자동 해석 문법 밖이므로 이 표에 없는 검사 주장이 원문에 있을 수 있습니다.');
  lines.push('', '## 4. 리뷰어 job 실행 기록 (plugin 로컬 로그)', '');
  if (jobLog.status === 'captured') {
    lines.push(`- 로그 사본 SHA-256: \`${jobLog.logSha256}\` (저장 ${jobLog.capturedAt})`,
      `- 리뷰 완료 증거: ${completionText(jobLog.completion)}`, '');
    if (jobLog.commands.length) {
      lines.push('| 시각 | 명령 | 결과 |', '|---|---|---|');
      for (const item of jobLog.commands.slice(0, listLimit)) lines.push(`| ${item.at} | ${cellCode(redact(item.command))} | ${exitText(item)} |`);
      if (jobLog.commands.length > listLimit) lines.push('', `- 완료 기록 명령 ${jobLog.commands.length - listLimit}건은 생략했습니다. 로그 사본에서 확인하세요.`);
    } else lines.push('- 완료 기록이 있는 명령이 없습니다.');
    for (const item of jobLog.unfinished.slice(0, listLimit)) lines.push(`- 완료 기록 없음: ${code(clip(redact(item)))}`);
    if (jobLog.unfinished.length > listLimit) lines.push(`- 완료 기록 없는 명령 ${jobLog.unfinished.length - listLimit}건은 생략했습니다.`);
    for (const item of jobLog.ambiguous.slice(0, listLimit)) lines.push(`- 확인 불가(리뷰어 글 블록 이후, 실행 기록으로 세지 않음): ${code(clip(redact(item)))}`);
    if (jobLog.ambiguous.length > listLimit) lines.push(`- 확인 불가 줄 ${jobLog.ambiguous.length - listLimit}건은 생략했습니다.`);
  } else lines.push(`- 확인 불가: ${jobLog.reason}`);
  lines.push('', '## 5. 표준 검사별 실행 기록 (미실행·확인 불가 포함)', '', '| 검사 | 명령 | job 실행 기록 |', '|---|---|---|');
  for (const [name, command] of standardChecks) {
    const runs = jobLog.status === 'captured' ? jobLog.commands.filter(item => classifyCheck(item.command) === name) : [];
    const unclear = jobLog.status === 'captured' ? jobLog.ambiguous.filter(item => classifyCheck(item) === name).length : 0;
    const recorded = jobLog.status !== 'captured' ? '확인 불가'
      : [runs.length ? `${runs.length}회: ${runs.map(exitText).join(', ')}` : unclear ? '' : '기록 없음',
        unclear ? `확인 불가 ${unclear}건(리뷰어 글 블록 이후)` : ''].filter(Boolean).join('; ');
    lines.push(`| ${name} | \`${command}\` | ${recorded} |`);
  }
  const reportedNotRun = result.reviewerChecks.filter(item => ['not-run', 'skipped'].includes(item.status));
  lines.push('', '- 명령 전체가 해당 검사의 직접 실행일 때만 셉니다. 잘린 명령·파이프·연결 명령·검색 명령은 세지 않으므로 4절 전체 명령 표를 함께 확인하세요.', '- "기록 없음"은 리뷰어가 실행하지 않았거나 직접 실행 기록을 확인할 수 없다는 뜻입니다. 통과로 보지 않습니다.');
  if (reportedNotRun.length) lines.push(`- 리뷰어가 원문에서 미실행·건너뜀으로 보고: ${reportedNotRun.map(item => `${code(item.name)}(${checkStatus[item.status]})`).join(', ')}`);
  lines.push('', '## 6. 원격 CI (GitHub API, 초안 생성 시점의 현재 HEAD)', '', '| 검사 | 상태 |', '|---|---|');
  for (const item of remoteChecks) lines.push(`| ${cell(item.name)} | ${cell(item.state)} |`);
  lines.push('', '## 7. 불확실성', '', ...uncertainties({ result, jobLog, remoteChecks, interpretation }).map(item => `- ${item}`));
  lines.push('', '## 8. 관리자 판단 (관리자 작성)', '',
    '> 아래 항목을 확인하고 판단을 작성하세요. 자동 생성 부분은 수정하지 않는 것을 권장합니다. marker·대상 SHA·원문이 없거나 바뀌면 `/review-gate` 준비 도구가 거부합니다.', '',
    blocking ? '- [ ] 차단 지적을 수정하고 새 HEAD를 다시 리뷰할 계획' : '- [ ] critical/high/medium 지적 0건과 리뷰 완료 기록을 인정하는가',
    '- [ ] unknown·리뷰어 로컬 검사 실패의 원인 판단: (작성)',
    '- [ ] 원격 CI·별도 검증을 보완 근거로 인정하는가: (작성)',
    '- [ ] 미실행 검사와 남은 위험의 후속 처리: (작성)',
    '- 판단 메모: (작성)',
    '', '## 부록. Codex 리뷰 원문', '', `원문 SHA-256: \`${result.source.outputHash}\``, '');
  const marker = fence(result.report);
  lines.push(`${marker}text`, result.report, marker, '');
  const body = lines.join('\n');
  if (body.length > maxDraftChars) {
    if (listLimit > 0) return buildAttentionDraft(input, 0);
    stop('review-attention-draft-too-large', '초안 크기 상한 초과');
  }
  return { key, body, sha256: sha256(body), state };
}

// 관리자가 실행할 다음 단계. Agent는 이 명령을 대신 실행하지 않는다.
export function adminNextSteps({ target, draftPath }) {
  const pr = `${target.number} --repo ${target.repository}`;
  return [
    `1. 초안을 열어 원문·기록을 확인하고 "8. 관리자 판단"을 작성합니다: ${draftPath}`,
    `2. 관리자가 직접 게시합니다: gh pr comment ${pr} --body-file "${draftPath}"`,
    `3. 게시한 댓글 URL로 확인 문구를 준비합니다: npm run review:attention -- ${target.repository} ${target.number} --confirm <댓글 URL>`,
    '4. 출력된 /review-gate 파일을 확인한 뒤 관리자가 직접 게시합니다. High는 /merge-approve도 관리자가 직접 작성합니다.',
  ];
}

// 관리자가 게시한 보고서 댓글이 이 초안에서 나왔고 현재 대상·결과와 맞는지 확인한 뒤 `/review-gate` 문구만 만든다.
export async function prepareAttentionConfirmation({ github, packet, state, ledger, commentRef }) {
  const { target } = packet;
  const { description } = state.evaluation;
  const prefix = `https://github.com/${target.repository}/pull/${target.number}#issuecomment-`;
  const raw = String(commentRef ?? '');
  const id = /^[1-9][0-9]*$/.test(raw) ? raw : raw.startsWith(prefix) && /^[1-9][0-9]*$/.test(raw.slice(prefix.length)) ? raw.slice(prefix.length) : null;
  if (!id) stop('review-attention-comment-invalid', '이 PR의 댓글 링크 또는 ID가 아님');
  const comment = state.comments.find(item => String(item.id) === id);
  if (!comment) stop('review-attention-comment-invalid', '댓글 없음');
  const { canConfirm } = permissionReader({ github, repo: state.repo });
  if (comment.user?.type !== 'User' || !await canConfirm(comment.user)) stop('review-attention-not-admin', '관리자가 직접 게시한 댓글이 아님');
  const body = normalizeNewlines(comment.body);
  const key = draftKey({ target, ledgerHash: ledger.ledgerHash, result: ledger.result });
  if (!isReportBody(body) || !body.includes(target.head) || !body.includes(target.base) || !body.includes(`<!-- ${draftMarker} ${key} -->`)
      || !body.includes(ledger.result.report)) stop('review-attention-comment-invalid', '초안 marker·대상 SHA·원문 불일치');
  if (localReportsForTarget(state.comments, target).length) stop('review-attention-bot-report', '같은 대상의 봇 보고서가 이미 있음');
  // 저장 결과와 현재 재해석 중 큰 지적 수를 쓴다. 해석이 같으면 저장 결과와 같다. 재해석으로 unknown·지적을 줄이지 않는다.
  const findings = (ledger.interpretation ?? interpretStoredResult(ledger.result, ledger.storedParserVersion ?? null)).effectiveFindings;
  if (state.evaluation.blocked || blockingLevels.some(level => findings[level] !== 0)) stop('review-attention-blocking-findings', '미해결 차단 지적');
  if (ledger.result.reviewer !== description.reviewer) stop('review-attention-gate-mismatch', 'reviewer 불일치');
  try { await verifyEvidenceCi({ github, repo: state.repo, pr: state.current, config: state.config, checkRuns: state.checkRuns }); } catch { stop('review-attention-ci', '필수 CI 미통과·출처 불명확'); }
  const evidenceHash = reportHash(body);
  const confirmation = { fingerprint: target.fingerprint, decision: 'pass', reviewer: description.reviewer, reviewComplete: true,
    evidence: `${prefix}${id}`, evidenceHash, findings };
  // 기존 게이트 판정 함수로 같은 형식이 통과 조건을 만족하는지 미리 확인한다. 실제 판정은 관리자 게시 후 게이트가 한다.
  if (decide(description, confirmation, { body, hash: evidenceHash }).state !== 'success') stop('review-attention-gate-mismatch', '게이트 형식 불일치');
  // 게이트는 가장 최근 관리자 `/review-gate`만 확인으로 읽는다. 게이트가 실제로 고른 댓글과 같을 때만 완료로 안내한다.
  // 과거에 같은 내용이 있었어도 더 최근 확인이 덮었으면 다시 게시가 필요하다.
  const effectiveId = state.evaluation.evidence?.record?.confirmation?.id ?? null;
  const effective = effectiveId === null ? null : state.comments.find(item => item.id === effectiveId);
  const existingConfirmationId = effective && same(parseConfirmation(effective.body), confirmation) ? effective.id : null;
  return { state: existingConfirmationId ? 'already-confirmed' : 'awaiting-admin-post', target, commentId: comment.id, commentUrl: confirmation.evidence,
    evidenceHash, confirmation, existingConfirmationId, text: `/review-gate\n\`\`\`json\n${JSON.stringify(confirmation, null, 2)}\n\`\`\``,
    unknown: findings.unknown, published: false, approved: false };
}

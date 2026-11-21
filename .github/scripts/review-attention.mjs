import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { canonical, same, validatePluginResult, localPublicationBlockers, reviewerCheckFailures, localReportsForTarget, verifyEvidenceCi } from './review-evidence-source.mjs';
import { decide, isReportBody, normalizeNewlines, parseConfirmation, reportHash, sha256 } from './review-gate-core.mjs';
import { permissionReader } from './review-gate.mjs';

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

// wrapper가 쓰는 ledger(복구 v3가 있으면 그 파일)를 읽기 전용으로 검증한다.
// 현재 PR 대상(base/head/fingerprint/정책)과 다르거나 게시 요청 기록이 있으면 자료를 만들지 않는다.
export function readAttentionLedger({ paths, target, implementedBy, files, ignoreLock = false }) {
  if (!ignoreLock && files.exists(paths.lock)) stop('review-attention-busy', '리뷰 wrapper 실행 중 lock 존재');
  const recovered = files.exists(paths.recovered);
  if (!recovered && files.exists(paths.legacyRecovered)) stop('review-recovery-manual', 'v2 복구 기록은 사람이 확인');
  const path = recovered ? paths.recovered : paths.original;
  if (!files.exists(path)) stop('review-attention-no-ledger', '완료 ledger 없음');
  const text = files.read(path);
  let ledger;
  try { ledger = JSON.parse(text); } catch { stop('review-attention-ledger-invalid', 'ledger 형식 오류'); }
  if (ledger?.state !== 'completed' || !same(ledger.target, target)) stop('review-attention-ledger-invalid', '완료 상태가 아니거나 현재 PR 대상과 다름');
  if (recovered && (!files.exists(paths.original) || ledger.recovery?.originalLedgerHash !== sha256(files.read(paths.original)))) {
    stop('review-attention-ledger-invalid', '복구 기록과 원본 ledger 연결 불일치');
  }
  if (ledger.publicationRequested || ledger.publication) stop('review-attention-publication-requested', '이미 게시 요청한 결과');
  let result;
  try { result = validatePluginResult(ledger.result, target, implementedBy); } catch { stop('review-attention-ledger-invalid', '완료 결과 형식 오류'); }
  const blockers = localPublicationBlockers(result);
  if (!blockers.length) stop('review-attention-not-blocked', '자동 게시 대상 결과');
  return { path, ledgerHash: sha256(text), session: ledger.session, result, blockers, recovered };
}

// plugin job 로그(Codex 명령 실행 기록). codex-companion 1.0.6은 이벤트 줄을 빈 줄 없이 쓰고,
// 리뷰어가 쓴 글(Assistant message·Review output·Reasoning summary·Final output 등)은 빈 줄 + 제목 줄로 시작하는 블록으로 쓴다.
// 블록 본문은 끝 표시가 없어 그 뒤 줄이 실제 이벤트인지 리뷰어 글인지 구분할 수 없다.
// 그래서 첫 블록(첫 빈 줄) 이후의 명령 형식 줄은 실행 기록으로 세지 않고 확인 불가(ambiguous)로만 센다.
const timestamp = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z`;
const completedLine = new RegExp(`^\\[(${timestamp})\\] Command ([A-Za-z]+): (.+) \\(exit (-?\\d+|\\?)\\)$`);
const startedLine = new RegExp(`^\\[(${timestamp})\\] Running command: (.+)$`);
const blockTitleLine = new RegExp(`^\\[${timestamp}\\] (?:Final output|Assistant message|Review output|Reasoning summary|Subagent .+ (?:message|reasoning summary))$`);

export function parseJobCommands(log) {
  const commands = []; const unfinished = []; const ambiguous = [];
  let trusted = true;
  for (const line of normalizeNewlines(log).split('\n')) {
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
  return { commands, unfinished, ambiguous };
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
  return { status: 'captured', logSha256: snapshot.logSha256, capturedAt: snapshot.capturedAt, ...parseJobCommands(snapshot.log) };
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
  return { status: 'captured', logSha256: snapshot.logSha256, capturedAt: snapshot.capturedAt, ...parseJobCommands(log) };
}

// 초안 marker. 같은 대상·ledger·원문·job에서 만든 초안만 `/review-gate` 준비에 쓴다.
export const draftKey = ({ target, ledgerHash, result }) => sha256(canonical({ v: 1, target, ledgerHash, outputHash: result.source.outputHash, jobId: result.source.jobId }));

const standardChecks = [
  ['Lint', 'npm run lint', /\bnpm(?:\.cmd)? run lint(?![\w:-])|\beslint\b/],
  ['Type Check', 'npm run typecheck', /\bnpm(?:\.cmd)? run typecheck(?![\w:-])|\btsc\b/],
  ['단위 테스트', 'npm run test', /\bnpm(?:\.cmd)? (?:run )?test(?![\w:-])|\bvitest\b/],
  ['Build', 'npm run build', /\bnpm(?:\.cmd)? run build(?![\w:-])|\bvite build\b/],
  ['E2E', 'npm run test:e2e', /\bnpm(?:\.cmd)? run test:e2e(?![\w:-])|\bplaywright test\b/],
  ['리뷰 게이트 테스트', 'npm run test:gate', /\bnpm(?:\.cmd)? run test:gate(?![\w:-])|\bnode --test\b/],
  ['전체 검증', 'npm run verify', /\bnpm(?:\.cmd)? run verify(?![\w:-])/],
];
const checkStatus = { passed: '통과', failed: '실패', 'not-run': '미실행', skipped: '건너뜀' };
const blockerText = {
  findings: '`findings`: 코드 지적(critical/high/medium) 또는 판단 불가(unknown)가 0건이 아님',
  'reviewer-check-failed': '`reviewer-check-failed`: 리뷰어가 원문에서 로컬 검사 실패를 보고함',
};

const cell = text => String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const code = text => {
  const value = String(text);
  const ticks = '`'.repeat(Math.max(0, ...[...value.matchAll(/`+/g)].map(m => m[0].length)) + 1);
  return ticks.length > 1 ? `${ticks} ${value} ${ticks}` : `\`${value}\``;
};
const fence = text => '~'.repeat(Math.max(3, ...[...text.matchAll(/~+/g)].map(m => m[0].length + 1)));
const exitText = item => `${item.exitCode === null ? 'exit ?' : `exit ${item.exitCode}`}${item.status === 'completed' ? '' : ` (${item.status})`}`;

// 명령 문자열의 사용자 홈 경로는 `~`로 바꾼다. 리뷰 원문은 대조를 위해 바꾸지 않는다.
const redactor = homeDir => {
  const variants = homeDir ? [...new Set([homeDir, homeDir.replace(/\\/g, '/'), homeDir.replace(/\\/g, '\\\\')])].sort((a, b) => b.length - a.length) : [];
  return text => variants.reduce((value, variant) => value.split(variant).join('~'), text);
};

function uncertainties({ result, jobLog, remoteChecks }) {
  const items = [];
  const failures = reviewerCheckFailures(result);
  if (result.findings.unknown) items.push(`unknown ${result.findings.unknown}건: 원문 일부가 자동 해석 문법 밖이거나, 원인 미상 검사 실패·사용량 한도·형식 이상 표현이 있습니다. 결함 없음이나 검사 성공을 뜻하지 않습니다.`);
  for (const item of failures) {
    items.push(item.cause
      ? `${code(item.name)} 실패의 환경 원인("${cell(item.cause.text)}")은 리뷰어의 주장이며 확인되지 않았습니다.`
      : `${code(item.name)} 실패는 원인이 밝혀지지 않아 코드 결함 가능성을 배제할 수 없습니다.`);
  }
  if (jobLog.status !== 'captured') items.push(`job 실행 기록 확인 불가: ${jobLog.reason}`);
  else {
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
export function buildAttentionDraft({ target, risk, implementedBy, result, blockers, ledger, jobLog, remoteChecks, homeDir = null }) {
  const key = draftKey({ target, ledgerHash: ledger.ledgerHash, result });
  const redact = redactor(homeDir);
  const f = result.findings;
  const state = blockers.includes('findings') ? 'review-needs-attention' : 'review-checks-need-attention';
  const blocking = blockingLevels.reduce((sum, level) => sum + f[level], 0);
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
    `- 로컬 ledger: \`${basename(ledger.path)}\` (SHA-256 \`${ledger.ledgerHash}\`, 상태 completed, 게시 요청 기록 없음${ledger.recovered ? ', parser v3 복구 기록' : ''})`,
    '', '## 1. 자동 게시 차단 사유', '', `- 상태: \`${state}\``, '- 차단 항목:',
    ...blockers.map(item => `  - ${blockerText[item] ?? code(item)}`),
    '- wrapper는 fail-closed 정책에 따라 게시를 요청하지 않았습니다. 새 리뷰·자동 재시도·결과 수정·실패 기록 삭제를 하지 않았습니다.',
    '', '## 2. 코드 지적 (리뷰 원문 집계)', '',
    '| Critical | High | Medium | Low | Unknown |', '|---|---|---|---|---|', `| ${f.critical} | ${f.high} | ${f.medium} | ${f.low} | ${f.unknown} |`, '',
    blocking ? `- 차단 지적 ${blocking}건이 있습니다. 이 리뷰로 통과 확인을 만들 수 없으며 수정 후 새 HEAD를 다시 리뷰해야 합니다.`
      : '- critical/high/medium 지적은 없습니다. unknown은 결함 없음이나 검사 성공을 뜻하지 않습니다.',
    '', '## 3. 리뷰어가 원문에 보고한 로컬 검사 (주장, 실행 증명 아님)', '',
  ];
  if (result.reviewerChecks.length) {
    lines.push('| 검사 | 결과 | 개수 | 원인 주장 |', '|---|---|---|---|');
    for (const item of result.reviewerChecks) lines.push(`| ${code(item.name)} | ${checkStatus[item.status] ?? cell(item.status)} | ${item.count ?? '-'} | ${item.cause ? `${cell(item.cause.text)} (확인 안 됨)` : '-'} |`);
  } else lines.push('- 자동 해석된 검사 문장이 없습니다. 부록의 원문을 직접 확인하세요.');
  if (f.unknown) lines.push('', '- 원문 일부가 자동 해석 문법 밖이므로 이 표에 없는 검사 주장이 원문에 있을 수 있습니다.');
  lines.push('', '## 4. 리뷰어 job 실행 기록 (plugin 로컬 로그)', '');
  if (jobLog.status === 'captured') {
    lines.push(`- 로그 사본 SHA-256: \`${jobLog.logSha256}\` (저장 ${jobLog.capturedAt})`, '');
    if (jobLog.commands.length) {
      lines.push('| 시각 | 명령 | 결과 |', '|---|---|---|');
      for (const item of jobLog.commands.slice(0, maxListedCommands)) lines.push(`| ${item.at} | ${code(redact(item.command))} | ${exitText(item)} |`);
      if (jobLog.commands.length > maxListedCommands) lines.push('', `- 명령 ${jobLog.commands.length - maxListedCommands}건은 생략했습니다. 로그 사본에서 확인하세요.`);
    } else lines.push('- 완료 기록이 있는 명령이 없습니다.');
    for (const item of jobLog.unfinished) lines.push(`- 완료 기록 없음: ${code(redact(item))}`);
    for (const item of jobLog.ambiguous) lines.push(`- 확인 불가(리뷰어 글 블록 이후, 실행 기록으로 세지 않음): ${code(redact(item))}`);
  } else lines.push(`- 확인 불가: ${jobLog.reason}`);
  lines.push('', '## 5. 표준 검사별 실행 기록 (미실행·확인 불가 포함)', '', '| 검사 | 명령 | job 실행 기록 |', '|---|---|---|');
  for (const [name, command, pattern] of standardChecks) {
    const runs = jobLog.status === 'captured' ? jobLog.commands.filter(item => pattern.test(item.command)) : [];
    const unclear = jobLog.status === 'captured' ? jobLog.ambiguous.filter(item => pattern.test(item)).length : 0;
    const recorded = jobLog.status !== 'captured' ? '확인 불가'
      : [runs.length ? `${runs.length}회: ${runs.map(exitText).join(', ')}` : unclear ? '' : '기록 없음',
        unclear ? `확인 불가 ${unclear}건(리뷰어 글 블록 이후)` : ''].filter(Boolean).join('; ');
    lines.push(`| ${name} | \`${command}\` | ${recorded} |`);
  }
  const reportedNotRun = result.reviewerChecks.filter(item => ['not-run', 'skipped'].includes(item.status));
  lines.push('', '- "기록 없음"은 리뷰어가 실행하지 않았거나 기록이 남지 않아 확인할 수 없다는 뜻입니다. 통과로 보지 않습니다.');
  if (reportedNotRun.length) lines.push(`- 리뷰어가 원문에서 미실행·건너뜀으로 보고: ${reportedNotRun.map(item => `${code(item.name)}(${checkStatus[item.status]})`).join(', ')}`);
  lines.push('', '## 6. 원격 CI (GitHub API, 초안 생성 시점의 현재 HEAD)', '', '| 검사 | 상태 |', '|---|---|');
  for (const item of remoteChecks) lines.push(`| ${cell(item.name)} | ${cell(item.state)} |`);
  lines.push('', '## 7. 불확실성', '', ...uncertainties({ result, jobLog, remoteChecks }).map(item => `- ${item}`));
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
  if (state.evaluation.blocked || blockingLevels.some(level => ledger.result.findings[level] !== 0)) stop('review-attention-blocking-findings', '미해결 차단 지적');
  if (ledger.result.reviewer !== description.reviewer) stop('review-attention-gate-mismatch', 'reviewer 불일치');
  try { await verifyEvidenceCi({ github, repo: state.repo, pr: state.current, config: state.config, checkRuns: state.checkRuns }); } catch { stop('review-attention-ci', '필수 CI 미통과·출처 불명확'); }
  const evidenceHash = reportHash(body);
  const confirmation = { fingerprint: target.fingerprint, decision: 'pass', reviewer: description.reviewer, reviewComplete: true,
    evidence: `${prefix}${id}`, evidenceHash, findings: ledger.result.findings };
  // 기존 게이트 판정 함수로 같은 형식이 통과 조건을 만족하는지 미리 확인한다. 실제 판정은 관리자 게시 후 게이트가 한다.
  if (decide(description, confirmation, { body, hash: evidenceHash }).state !== 'success') stop('review-attention-gate-mismatch', '게이트 형식 불일치');
  // 게이트는 가장 최근 관리자 `/review-gate`만 확인으로 읽는다. 게이트가 실제로 고른 댓글과 같을 때만 완료로 안내한다.
  // 과거에 같은 내용이 있었어도 더 최근 확인이 덮었으면 다시 게시가 필요하다.
  const effectiveId = state.evaluation.evidence?.record?.confirmation?.id ?? null;
  const effective = effectiveId === null ? null : state.comments.find(item => item.id === effectiveId);
  const existingConfirmationId = effective && same(parseConfirmation(effective.body), confirmation) ? effective.id : null;
  return { state: existingConfirmationId ? 'already-confirmed' : 'awaiting-admin-post', target, commentId: comment.id, commentUrl: confirmation.evidence,
    evidenceHash, confirmation, existingConfirmationId, text: `/review-gate\n\`\`\`json\n${JSON.stringify(confirmation, null, 2)}\n\`\`\``,
    unknown: ledger.result.findings.unknown, published: false, approved: false };
}

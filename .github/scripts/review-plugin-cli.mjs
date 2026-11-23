import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectReviewPacket, prepareLocalConfirmation } from './review-evidence.mjs';
import { createEvidenceGitHub, runEvidenceCli } from './review-evidence-cli.mjs';
import { same, validatePluginResult, localReportsForTarget, parseLocalReport, verifyEvidenceCi, pluginResultVersion,
  publicationModules, localPublicationBlockers, reviewerCheckFailures } from './review-evidence-source.mjs';
import { analyzeReviewText, explainReviewText, parserVersion } from './review-result-parser.mjs';
export { findingsFromText, analyzeReviewText } from './review-result-parser.mjs';
import { reportHash, sha256 } from './review-gate-core.mjs';
import { gitBlobSha } from './merge-pr-core.mjs';
import { homedir } from 'node:os';
import { ledgerKey, attentionPaths, readAttentionLedger, captureJobLog, buildAttentionDraft, writeNewOrSame, adminNextSteps, nodeFiles,
  jobLogBlockers, requireBlocked, blockedState, jobLogSummary } from './review-attention.mjs';

// CLI에는 원시 오류/API 응답 대신 이 고정 안내만 출력한다.
export function pluginPublicationFailureMessage(error) {
  const messages = {
    'review-publication-preflight': '게시 요청 전 중단했습니다. 필수 CI의 완료·성공과 workflow 출처 및 요청 준비 상태를 확인하세요. 동일한 검토 대상에서 문제가 해소되면 같은 명령을 직접 재실행할 수 있으며 완료 결과를 재사용하고 모델을 다시 호출하지 않습니다. 대상이 바뀌면 기존 결과를 재사용하지 않습니다.',
    'review-publication-uncertain': '게시 요청의 성공 여부가 불명확합니다. 자동 재요청하지 않습니다. 기존 ledger를 보존하고 Actions 실행·실제 댓글·영수증을 확인하세요.',
    'review-publication-conflict': '게시 결과 충돌: 같은 대상에 다른 job/결과 또는 중복 보고서가 이미 게시됐습니다. 기존 ledger·댓글·영수증을 보존하고 확인하세요.',
    'review-publication-code-mismatch': '로컬 게시·판정 코드가 기본 브랜치와 달라 게시 요청하지 않았습니다. 서버는 기본 브랜치 코드로 원문을 다시 해석하므로 같은 결과를 보장할 수 없습니다. 완료 결과와 원문은 .git의 ledger에 보존했습니다. 이 대상은 수동 리뷰 보고 절차로 진행하고 모델 재호출·게시 재시도를 하지 않습니다.',
    'review-recovery-manual': '이전 형식(v2) 복구 기록의 게시 요청 여부가 불명확하거나 이미 요청됐거나 원본과의 연결을 검증할 수 없어 중단했습니다. 기존 ledger·복구 파일을 수정하지 않았으며 자동 재해석·재요청·모델 호출을 하지 않습니다. 실제 댓글·Actions·영수증을 사람이 확인하세요. 게시 요청 전 기록이면 --recover로 v3 재해석을 시도할 수 있습니다.',
    'review-report-too-large': '리뷰 원문이 16000바이트를 초과했습니다. .git의 captured ledger에 원문·job을 보존했으며 자동 게시하지 않습니다.',
  };
  return Object.hasOwn(messages, error?.code) ? messages[error.code] : '리뷰 수집/게시 중단. 완료·대상·형식·기존 ledger와 Actions를 확인하세요. 자동 재시도·추가 AI 호출·관리자 확인·승인은 하지 않습니다. 원시 오류는 출력하지 않습니다.';
}

export function parsePluginArgs(argv, env = process.env) {
  const [repository, rawNumber, ...rest] = argv;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') || !/^[1-9][0-9]*$/.test(rawNumber ?? '') || !Number.isSafeInteger(Number(rawNumber))) return null;
  const options = { repository, number: Number(rawNumber), pluginRoot: null, recover: false, session: env.CODEX_COMPANION_SESSION_ID ?? env.CLAUDE_SESSION_ID ?? null };
  const seen = new Set();
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i] === '--recover' && !options.recover) { options.recover = true; i -= 1; continue; }
    const key = { '--plugin-root': 'pluginRoot', '--session': 'session' }[rest[i]];
    if (!key || seen.has(key) || !rest[i + 1] || rest[i + 1].startsWith('--')) return null;
    options[key] = rest[i + 1]; seen.add(key);
  }
  return options.pluginRoot && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.session ?? '') ? options : null;
}

export function collectPluginResult({ output, stored, target, session, startedAt, checks }) {
  const job = stored?.storedJob;
  if (!job || job.kind !== 'review' || job.status !== 'completed' || stored.job?.status !== 'completed'
      || job.sessionId !== session || !same(job.result, output) || output.review !== 'Review' || job.threadId !== output.threadId
      || output.codex?.status !== 0 || output.target?.mode !== 'branch' || output.target.baseRef !== target.base
      || typeof output.codex.stdout !== 'string' || !output.codex.stdout.trim()
      || !Number.isFinite(Date.parse(job.createdAt)) || Date.parse(job.createdAt) < Date.parse(startedAt)
      || !Number.isFinite(Date.parse(job.completedAt)) || Date.parse(job.completedAt) < Date.parse(job.createdAt)) throw new Error('플러그인 완료·대상·세션 기록 불일치');
  const report = output.codex.stdout.replace(/\r\n?/g, '\n');
  const analysis = analyzeReviewText(report);
  return {
    v: pluginResultVersion, target, role: 'independent', reviewer: 'codex', status: 'completed', reviewComplete: true,
    findings: analysis.findings, report, reviewerChecks: analysis.reviewerChecks,
    source: { kind: 'codex-plugin', sessionId: session, jobId: job.id, threadId: job.threadId, turnId: job.turnId,
      startedAt: job.createdAt, completedAt: job.completedAt, outputHash: reportHash(report) },
    checks: checks.map(c => ({ name: `GitHub check: ${c.name}`, status: c.state === 'success' ? 'passed' : 'unknown', evidence: 'API가 반환한 현재 HEAD의 check 상태. workflow 출처 검증과 리뷰어의 로컬 검사 실행 증명은 별도이다.' })),
    notRun: ['플러그인은 명령별 검사 결과·미실행 항목을 구조화해 제공하지 않는다. reviewerChecks는 리뷰 원문 문장을 해석한 리뷰어의 주장이며 실행 증명이 아니고, 원문이 실행한 모든 명령을 나열한다는 보장도 없다. 관리자는 원문과 plugin job 기록을 직접 확인해야 하며, 이 수집기는 검사를 추가 실행하지 않았다.'],
  };
}

// 원래 ledger는 이전 parser·결과 형식(v2)일 수 있다. 재해석에 쓰는 대상·출처·원문만 확인하고 원본은 바꾸지 않는다.
function assertRecoverableOriginal(result, target) {
  if (![2, pluginResultVersion].includes(result?.v) || !same(result.target, target) || result.status !== 'completed' || result.reviewComplete !== true
      || typeof result.report !== 'string' || !result.report.trim() || result.source?.kind !== 'codex-plugin'
      || result.source.outputHash !== reportHash(result.report)) throw new Error('Recovery original result invalid');
}

// parser v2 복구 기록은 게시 요청 전이고 같은 원본·세션·대상·원문에서 파생됐음을 확인할 수 있을 때만 건너뛴다.
// 알 수 없는 필드·게시 요청 기록·부분 기록은 요청 여부가 불명확하므로 자동 재해석하지 않는다.
function assertUnrequestedLegacyRecovery(text, { original, originalText, target, session }) {
  const manual = () => { throw Object.assign(new Error('v2 recovery ledger requires manual check'), { code: 'review-recovery-manual' }); };
  let legacy;
  try { legacy = JSON.parse(text); } catch { manual(); }
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)
      || !same(Object.keys(legacy).sort(), ['recovery', 'result', 'session', 'state', 'target'])
      || legacy.state !== 'completed' || legacy.session !== session || !same(legacy.target, target)
      || !same(Object.keys(legacy.recovery ?? {}).sort(), ['originalLedgerHash', 'parserVersion']) || legacy.recovery.parserVersion !== 2
      || legacy.recovery.originalLedgerHash !== sha256(originalText) || legacy.result?.v !== 2
      || legacy.result.report !== original.result.report || !same(legacy.result.source, original.result.source)) manual();
  assertRecoverableOriginal(legacy.result, target);
  return sha256(text);
}

// 서버는 기본 브랜치의 게시·판정 코드로 원문을 다시 해석한다. 로컬 코드가 다르면 같은 결과를 보장할 수 없어 요청하지 않는다.
async function changedPublicationModules(github, defaultBranch) {
  const changed = [];
  for (const name of publicationModules) {
    const local = gitBlobSha(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'));
    const approved = (await github.rest.repos.getContent({ path: `.github/scripts/${name}`, ref: defaultBranch })).data?.sha;
    if (local !== approved) changed.push(name);
  }
  return changed;
}

// 게시하지 않는 이유를 코드 지적(unknown 사유 포함)·리뷰어 로컬 검사·job 실행 기록·원격 CI로 나눠 원문과 함께 보여준다.
export function attentionOutput(result, blockers, jobLog = null, homeDir = null) {
  return {
    state: blockedState(blockers), published: false, blockers,
    codeFindings: result.findings, unknownReasons: explainReviewText(result.report),
    reviewerCheckFailures: reviewerCheckFailures(result), reviewerChecks: result.reviewerChecks,
    jobLog: jobLogSummary(jobLog, homeDir), remoteChecks: result.checks,
    note: '코드 지적 집계와 리뷰어 로컬 검사는 별개입니다. 실패를 통과로 바꾸지 않았고 환경 원인은 리뷰어 주장일 뿐 확인되지 않았습니다. 원문이 실행한 모든 명령을 나열한다는 보장이 없어 plugin job 기록도 대조했습니다. job 기록의 exit 0이 아닌 명령·미완료·확인 불가 기록은 원인을 알 수 없어 차단합니다. 자동 게시하지 않았습니다. adminDraft의 관리자 검토 초안을 확인해 관리자가 직접 판단·게시하세요.',
    result,
  };
}

// 같은 job의 저장 기록만 조회해 로그 사본을 남긴다(리뷰 실행 아님). 저장·조회 실패는 확인 불가로 둔다.
function readJobLog({ plugin, result, paths, files, now }) {
  try { return captureJobLog({ plugin, result, paths, files, now }); } catch { return { status: 'unavailable', reason: 'plugin job 로그 사본을 저장·확인하지 못했습니다.' }; }
}

// 차단된 결과의 관리자 검토 초안. 완료 ledger는 읽기만 하고 job 로그 사본·초안은 별도 파일에 쓴다.
// 초안을 만들지 못해도 차단 상태(종료 코드 2)는 그대로이며 실패를 숨기지 않는다.
function prepareAdminDraft({ paths, target, description, checks, jobLog, files, homeDir }) {
  try {
    const ledger = readAttentionLedger({ paths, target, implementedBy: description.meta['implemented-by'], files, ignoreLock: true });
    const blockers = requireBlocked(ledger.result, jobLog);
    const draft = buildAttentionDraft({ target, risk: description.risk, implementedBy: description.meta['implemented-by'], result: ledger.result,
      blockers, ledger, jobLog, remoteChecks: checks, homeDir });
    const draftPath = paths.draft(draft.sha256);
    writeNewOrSame(files, draftPath, draft.body);
    return { state: 'ready', draftPath, draftSha256: draft.sha256, draftKey: draft.key, jobLog: { status: jobLog.status, reason: jobLog.reason ?? null },
      nextSteps: adminNextSteps({ target, draftPath }), published: false, approved: false };
  } catch {
    return { state: 'failed', reason: '관리자 검토 초안을 만들지 못했습니다. 원본 ledger는 그대로이며 npm run review:attention으로 다시 시도하거나 수동 리뷰 보고 절차를 사용하세요.', published: false, approved: false };
  }
}

// 기존 native reviewer 1회를 감싼다. 같은 대상의 ledger가 있으면 리뷰를 다시 호출하지 않는다.
// 로컬 ledger·플러그인 파일은 위조 가능하다. workflow에서는 항상 미인증 자료로만 취급한다.
export async function runPluginPublication({ options, gh, git, plugin, out = console.log,
  sleep = ms => new Promise(r => setTimeout(r, ms)), maxPolls = 12, now = () => new Date().toISOString(), files = nodeFiles, homeDir = homedir() }) {
  const github = createEvidenceGitHub(gh, options.repository);
  const collect = () => collectReviewPacket({ github, repository: options.repository, number: options.number });
  const initial = await collect();
  const target = initial.packet.target;
  if (initial.state.evaluation.description.meta['implemented-by'] !== 'claude') throw new Error('Claude 구현 PR의 Codex 독립 리뷰에만 사용');
  const checkLocal = () => {
    if (git(['rev-parse', 'HEAD']).trim() !== target.head || git(['rev-parse', target.base]).trim() !== target.base) throw new Error('로컬 검토 대상 SHA 불일치');
    // 보존용 로컬 설정은 읽기만 한다. 브랜치 diff 리뷰에는 미커밋 변경이 포함되지 않는다.
  };
  checkLocal();
  // 설명·정책만 바뀌어도 같은 base/head 리뷰를 다시 호출하지 않고 대상 불일치로 중단한다.
  const key = ledgerKey(target);
  const originalPath = git(['rev-parse', '--git-path', `photo-selector-review-${key}.json`]).trim();
  // parser v2 복구 결과(.recovered.json)는 읽기만 하고 수정·삭제하지 않는다. v3 결과는 별도 파일에 둔다.
  const legacyRecoveredPath = `${originalPath}.recovered.json`;
  const recoveredPath = `${originalPath}.recovered.v3.json`;
  const path = options.recover || existsSync(recoveredPath) ? recoveredPath : originalPath;
  // Normal execution and recovery share one lock and publication state.
  const lockPath = `${originalPath}.lock`;
  const lock = openSync(lockPath, 'wx', 0o600); closeSync(lock);
  try {
    let result; let captured; let latestChecks = initial.packet.checks;
    if (options.recover && !existsSync(path)) {
      if (!existsSync(originalPath)) throw new Error('No completed ledger to recover');
      const originalText = readFileSync(originalPath, 'utf8');
      const original = JSON.parse(originalText);
      if (original.state !== 'completed' || original.session !== options.session || !same(original.target, target)
          || original.publicationRequested || original.publication) throw new Error('Recovery requires an unpublished completed target');
      assertRecoverableOriginal(original.result, target);
      const legacyRecoveredHash = existsSync(legacyRecoveredPath)
        ? assertUnrequestedLegacyRecovery(readFileSync(legacyRecoveredPath, 'utf8'), { original, originalText, target, session: options.session }) : null;
      const stored = plugin(['result', '--json']); // Read the existing native job, never invoke review.
      const job = stored.storedJob;
      if (job?.id !== original.result.source.jobId || job?.threadId !== original.result.source.threadId
          || job?.turnId !== original.result.source.turnId || job?.completedAt !== original.result.source.completedAt
          || job?.result?.codex?.stdout?.replace(/\r\n?/g, '\n') !== original.result.report) throw new Error('Recovery job/source mismatch');
      const recovered = collectPluginResult({ output: job.result, stored, target, session: options.session,
        startedAt: original.result.source.startedAt, checks: initial.packet.checks });
      validatePluginResult(recovered, target, 'claude');
      writeFileSync(path, JSON.stringify({ state: 'completed', target, session: options.session, result: recovered,
        recovery: { originalLedgerHash: sha256(originalText), legacyRecoveredHash, parserVersion } }), { flag: 'wx', mode: 0o600 });
    } else if (path === originalPath && existsSync(legacyRecoveredPath)) {
      // v2 복구 기록이 있는 대상은 원래 ledger로 되돌아가 새 리뷰·게시를 시도하지 않는다.
      throw Object.assign(new Error('v2 recovery ledger requires --recover or manual check'), { code: 'review-recovery-manual' });
    }
    if (existsSync(path)) {
      const ledger = JSON.parse(readFileSync(path, 'utf8'));
      if (!['completed', 'captured'].includes(ledger.state) || ledger.session !== options.session || !same(ledger.target, target)) throw new Error('이전 실행 미완료·실패·다른 세션. 리뷰를 자동 재실행하지 않음');
      result = ledger.result;
      if (ledger.state === 'captured') captured = ledger;
    } else {
      if (options.recover) throw new Error('Recovery cannot start a model review');
      const existing = localReportsForTarget(initial.state.comments, target).length > 0;
      if (existing) {
        // 다른 checkout/세션에서 이미 게시한 결과도 원격 영수증으로 확인한다. 로컬 ledger가 없다고 새 리뷰하지 않는다.
        out(JSON.stringify({ state: 'published-awaiting-human', ...await prepareLocalConfirmation({ github, repository: options.repository, number: options.number }) }, null, 2));
        return 0;
      }
      const startedAt = now();
      writeFileSync(path, JSON.stringify({ state: 'running', target, session: options.session, startedAt }), { flag: 'wx', mode: 0o600 });
      const raw = plugin(['review', '--wait', '--base', target.base, '--scope', 'branch', '--json']);
      const output = { review: raw.review, threadId: raw.threadId, target: raw.target, codex: { status: raw.codex?.status, stdout: raw.codex?.stdout } };
      // 플러그인 호출 직후 원문을 먼저 저장한다. 이후 job 조회·대상·크기 검증 실패가 구독 결과를 잃게 하지 않는다.
      captured = { state: 'captured', target, session: options.session, startedAt, output };
      writeFileSync(path, JSON.stringify(captured), { mode: 0o600 });
    }
    if (captured) {
      const { output, startedAt } = captured;
      if (!captured.stored) {
        const raw = plugin(['result', '--json']);
        const job = raw.storedJob;
        const storedOutput = job?.result;
        captured.stored = { job: { status: raw.job?.status }, storedJob: { id: job?.id, kind: job?.kind, status: job?.status, sessionId: job?.sessionId,
          threadId: job?.threadId, turnId: job?.turnId, createdAt: job?.createdAt, completedAt: job?.completedAt,
          result: { review: storedOutput?.review, threadId: storedOutput?.threadId, target: storedOutput?.target, codex: { status: storedOutput?.codex?.status, stdout: storedOutput?.codex?.stdout } } } };
        writeFileSync(path, JSON.stringify(captured), { mode: 0o600 });
      }
      checkLocal();
      const current = await collect();
      if (!same(current.packet.target, target)) throw new Error('리뷰 실행 중 원격 대상 변경');
      latestChecks = current.packet.checks;
      result = collectPluginResult({ output, stored: captured.stored, target, session: options.session, startedAt, checks: current.packet.checks });
      validatePluginResult(result, target, 'claude');
      writeFileSync(path, JSON.stringify({ state: 'completed', target, session: options.session, result }), { mode: 0o600 });
    }
    validatePluginResult(result, target, 'claude');
    const paths = attentionPaths(resolve(originalPath));
    const blocked = (blockers, jobLog) => {
      const adminDraft = prepareAdminDraft({ paths, target, description: initial.state.evaluation.description, checks: latestChecks, jobLog, files, homeDir });
      out(JSON.stringify({ ...attentionOutput(result, blockers, jobLog, homeDir), adminDraft }, null, 2));
      return 2;
    };
    const reportBlockers = localPublicationBlockers(result);
    if (reportBlockers.length) {
      const jobLog = readJobLog({ plugin, result, paths, files, now });
      return blocked([...reportBlockers, ...jobLogBlockers(jobLog)], jobLog);
    }
    const existingPublication = state => {
      const matches = localReportsForTarget(state.comments, target);
      if (matches.length > 1 || matches.some(c => !same(parseLocalReport(c.body).result, result))) {
        throw Object.assign(new Error('게시 결과 충돌: 같은 대상에 다른 job/결과 또는 중복 보고서가 이미 게시됨'), { code: 'review-publication-conflict' });
      }
      return matches.length > 0;
    };
    // 이미 등록됐으면 성공 영수증을 확인해 재사용한다. 충돌·손상은 대기 실패로 숨기지 않는다.
    const latest = await collect();
    if (!same(latest.packet.target, target)) throw new Error('게시 직전 대상 변경');
    const already = existingPublication(latest.state);
    if (!already && !JSON.parse(readFileSync(path, 'utf8')).publicationRequested) {
      // 새 게시 요청 전에만 job 실행 기록을 대조한다. 이미 게시·요청된 결과는 영수증 확인 경로를 그대로 쓴다.
      const jobLog = readJobLog({ plugin, result, paths, files, now });
      const jobBlockers = jobLogBlockers(jobLog);
      if (jobBlockers.length) return blocked(jobBlockers, jobLog);
      let preflightError;
      const status = await runEvidenceCli({ argv: [options.repository, String(options.number), '--result', 'plugin-result.json', '--dispatch'], gh,
        readFile: () => JSON.stringify(result), out: () => {}, err: () => {},
        beforeDispatch: async ({ packet, state }) => {
          try {
            checkLocal();
            if (!same(packet.target, target)) throw new Error('게시 요청 전 대상 변경');
            if (existingPublication(state)) throw new Error('게시 요청 전 보고서 도착. 재실행하여 영수증 확인 필요');
            const changed = await changedPublicationModules(github, state.defaultBranch);
            if (changed.length) throw Object.assign(new Error(`게시·판정 코드가 기본 브랜치와 다름: ${changed.join(', ')}`), { code: 'review-publication-code-mismatch' });
            await verifyEvidenceCi({ github, repo: state.repo, pr: state.current, config: state.config, checkRuns: state.checkRuns });
            // 서버도 CI·대상을 다시 검사한다. 이 확인과 원격 요청은 원자적이지 않다.
            // 요청 응답을 잃어도 재요청하지 않도록 실제 dispatch 직전에만 기록한다.
            const ledger = JSON.parse(readFileSync(path, 'utf8'));
            writeFileSync(path, JSON.stringify({ ...ledger, publicationRequested: true }), { mode: 0o600 });
          } catch (error) { preflightError = error; throw error; }
        } });
      if (status !== 0) {
        if (preflightError) {
          if (!['review-publication-conflict', 'review-publication-code-mismatch'].includes(preflightError.code)) preflightError.code = 'review-publication-preflight';
          throw preflightError;
        }
        if (!JSON.parse(readFileSync(path, 'utf8')).publicationRequested) throw Object.assign(new Error('게시 요청 전 준비 실패. 완료 결과를 보존했으며 모델 재호출 없이 재실행 가능'), { code: 'review-publication-preflight' });
        throw Object.assign(new Error('게시 요청 실패·결과 불명확. 자동 재시도하지 않음'), { code: 'review-publication-uncertain' });
      }
    }
    for (let i = 0; i < maxPolls; i++) {
      const current = await collect();
      if (!same(current.packet.target, target)) throw new Error('게시 대기 중 대상 변경');
      existingPublication(current.state);
      let confirmed;
      try {
        confirmed = await prepareLocalConfirmation({ github, repository: options.repository, number: options.number });
      } catch {
        if (i + 1 < maxPolls) await sleep(5000);
        continue;
      }
      if (!same(confirmed.publisher.result, result)) {
        throw Object.assign(new Error('게시 결과 충돌: 같은 대상에 다른 job/결과가 이미 게시됨'), { code: 'review-publication-conflict' });
      }
      writeFileSync(path, JSON.stringify({ state: 'completed', target, session: options.session, result, recovery: JSON.parse(readFileSync(path, 'utf8')).recovery, publicationRequested: true,
        publication: { commentUrl: confirmed.commentUrl, evidenceHash: confirmed.evidenceHash } }), { mode: 0o600 });
      out(JSON.stringify({ state: 'published-awaiting-human', ...confirmed }, null, 2));
      return 0;
    }
    throw new Error('게시·영수증 완료를 확인하지 못함. 요청을 반복하지 말고 Actions와 실제 댓글 확인 필요');
  } finally { unlinkSync(lockPath); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const options = parsePluginArgs(process.argv.slice(2));
  if (!options) {
    console.error('사용법: npm run review:publish -- owner/repo PR번호 --plugin-root <설치된 Codex 플러그인 경로> --session <현재 Claude 세션 ID>');
    process.exitCode = 1;
  } else {
    const command = name => args => execFileSync(name, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 5 * 1024 * 1024 });
    try {
      const plugin = args => JSON.parse(execFileSync(process.execPath, [join(resolve(options.pluginRoot), 'scripts/codex-companion.mjs'), ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 15 * 60 * 1000, maxBuffer: 5 * 1024 * 1024,
        env: { ...process.env, CODEX_COMPANION_SESSION_ID: options.session },
      }));
      process.exitCode = await runPluginPublication({ options, gh: command('gh'), git: command('git'), plugin });
    } catch (error) {
      console.error(pluginPublicationFailureMessage(error));
      process.exitCode = 1;
    }
  }
}

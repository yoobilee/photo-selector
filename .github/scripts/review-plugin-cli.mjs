import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectReviewPacket, prepareLocalConfirmation } from './review-evidence.mjs';
import { createEvidenceGitHub, runEvidenceCli } from './review-evidence-cli.mjs';
import { canonical, same, validatePluginResult, parseLocalReport, isEvidencePublisher } from './review-evidence-source.mjs';
import { reportHash, sha256 } from './review-gate-core.mjs';

export function parsePluginArgs(argv, env = process.env) {
  const [repository, rawNumber, ...rest] = argv;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') || !/^[1-9][0-9]*$/.test(rawNumber ?? '') || !Number.isSafeInteger(Number(rawNumber))) return null;
  const options = { repository, number: Number(rawNumber), pluginRoot: null, session: env.CODEX_COMPANION_SESSION_ID ?? env.CLAUDE_SESSION_ID ?? null };
  const seen = new Set();
  for (let i = 0; i < rest.length; i += 2) {
    const key = { '--plugin-root': 'pluginRoot', '--session': 'session' }[rest[i]];
    if (!key || seen.has(key) || !rest[i + 1] || rest[i + 1].startsWith('--')) return null;
    options[key] = rest[i + 1]; seen.add(key);
  }
  return options.pluginRoot && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.session ?? '') ? options : null;
}

export function findingsFromText(text) {
  const findings = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  const levels = ['critical', 'high', 'medium', 'low'];
  const badges = [...text.matchAll(/\[P([0-3])\]/g)];
  for (const badge of badges) findings[levels[Number(badge[1])]] += 1;
  // 관찰한 완료·검사 문장의 전체 문법만 허용한다. 앞부분의 지적 없음 선언만으로 뒤의 산문을 지우지 않는다.
  const clean = /^(?:No actionable defects were found\.|No findings\.|No issues found\.)(?:\s+(?:Lint passed\.|Lint and all \d+ focused tests passed\.|Build and E2E were not run\.|The full unit run encountered a sandbox EPERM in privacyGuard; build and E2E checks were not run\.))*$/i;
  if (!clean.test(text.trim())) findings.unknown = 1;
  if (/rate limit|usage limit|quota exceeded|review (?:was )?(?:skipped|not run)|unable to (?:complete|perform) (?:the )?review/i.test(text)) findings.unknown += 1;
  if (/\[P[^\]]*\]/.test(text.replace(/\[P[0-3]\]/g, ''))) findings.unknown += 1;
  return findings;
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
  return {
    v: 2, target, role: 'independent', reviewer: 'codex', status: 'completed', reviewComplete: true,
    findings: findingsFromText(report), report,
    source: { kind: 'codex-plugin', sessionId: session, jobId: job.id, threadId: job.threadId, turnId: job.turnId,
      startedAt: job.createdAt, completedAt: job.completedAt, outputHash: reportHash(report) },
    checks: checks.map(c => ({ name: `GitHub check: ${c.name}`, status: c.state === 'success' ? 'passed' : 'unknown', evidence: 'API가 반환한 현재 HEAD의 check 상태. workflow 출처 검증과 리뷰어의 로컬 검사 실행 증명은 별도이다.' })),
    notRun: ['플러그인은 명령별 검사 결과·미실행 항목을 구조화해 제공하지 않는다. 리뷰 원문에 기록된 검사와 한계를 관리자가 직접 확인해야 하며, 이 수집기는 검사를 추가 실행하지 않았다.'],
  };
}

// 기존 native reviewer 1회를 감싼다. 같은 대상의 ledger가 있으면 리뷰를 다시 호출하지 않는다.
// 로컬 ledger·플러그인 파일은 위조 가능하다. workflow에서는 항상 미인증 자료로만 취급한다.
export async function runPluginPublication({ options, gh, git, plugin, out = console.log,
  sleep = ms => new Promise(r => setTimeout(r, ms)), maxPolls = 12, now = () => new Date().toISOString() }) {
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
  const key = sha256(canonical({ repository: target.repository, number: target.number, head: target.head, base: target.base }));
  const path = git(['rev-parse', '--git-path', `photo-selector-review-${key}.json`]).trim();
  const lockPath = `${path}.lock`;
  const lock = openSync(lockPath, 'wx', 0o600); closeSync(lock);
  try {
    let result; let captured;
    if (existsSync(path)) {
      const ledger = JSON.parse(readFileSync(path, 'utf8'));
      if (!['completed', 'captured'].includes(ledger.state) || ledger.session !== options.session || !same(ledger.target, target)) throw new Error('이전 실행 미완료·실패·다른 세션. 리뷰를 자동 재실행하지 않음');
      result = ledger.result;
      if (ledger.state === 'captured') captured = ledger;
    } else {
      const existing = initial.state.comments.filter(isEvidencePublisher).some(c => {
        try { return same(parseLocalReport(c.body).result.target, target); } catch { return false; }
      });
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
      result = collectPluginResult({ output, stored: captured.stored, target, session: options.session, startedAt, checks: current.packet.checks });
      validatePluginResult(result, target, 'claude');
      writeFileSync(path, JSON.stringify({ state: 'completed', target, session: options.session, result }), { mode: 0o600 });
    }
    validatePluginResult(result, target, 'claude');
    if (['critical', 'high', 'medium', 'unknown'].some(k => result.findings[k])) {
      out(JSON.stringify({ state: 'review-needs-attention', result, published: false }));
      return 2;
    }
    // 이미 등록됐으면 성공 영수증을 확인해 재사용한다. 다른 실패는 게시기가 전체 조회 후 fail-closed로 판단한다.
    const latest = await collect();
    if (!same(latest.packet.target, target)) throw new Error('게시 직전 대상 변경');
    const already = latest.state.comments.some(c => isEvidencePublisher(c) && c.body.includes(`photo-selector-review-evidence:v2 ${sha256(canonical(result))}`));
    if (!already && !JSON.parse(readFileSync(path, 'utf8')).publicationRequested) {
      // 응답을 잃어도 같은 대상의 dispatch를 자동 재요청하지 않도록 먼저 기록한다.
      writeFileSync(path, JSON.stringify({ state: 'completed', target, session: options.session, result, publicationRequested: true }), { mode: 0o600 });
      const status = await runEvidenceCli({ argv: [options.repository, String(options.number), '--result', 'plugin-result.json', '--dispatch'], gh,
        readFile: () => JSON.stringify(result), out: () => {}, err: () => {} });
      if (status !== 0) throw new Error('게시 요청 실패. 자동 재시도하지 않음');
    }
    for (let i = 0; i < maxPolls; i++) {
      const current = await collect();
      if (!same(current.packet.target, target)) throw new Error('게시 대기 중 대상 변경');
      try {
        const confirmed = await prepareLocalConfirmation({ github, repository: options.repository, number: options.number });
        writeFileSync(path, JSON.stringify({ state: 'completed', target, session: options.session, result, publicationRequested: true,
          publication: { commentUrl: confirmed.commentUrl, evidenceHash: confirmed.evidenceHash } }), { mode: 0o600 });
        out(JSON.stringify({ state: 'published-awaiting-human', ...confirmed }, null, 2));
        return 0;
      } catch {
        if (i + 1 < maxPolls) await sleep(5000);
      }
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
      if (error.code === 'review-report-too-large') console.error('리뷰 원문이 16000바이트를 초과했습니다. .git의 captured ledger에 원문·job을 보존했으며 자동 게시하지 않습니다.');
      console.error('리뷰 수집/게시 중단. 완료·대상·형식·기존 ledger와 Actions를 확인하세요. 자동 재시도·추가 AI 호출·관리자 확인·승인은 하지 않습니다. 원시 오류는 출력하지 않습니다.');
      process.exitCode = 1;
    }
  }
}

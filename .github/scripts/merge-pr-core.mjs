import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPullRequestUnchanged, pullRequestSnapshot, validTitle } from './review-gate-core.mjs';
import { evaluatePR } from './review-gate.mjs';
import { verifyGateSource } from './review-gate-source.mjs';
import { approvalText, evaluateCodexReview, latestCheckRun, planReviewRequest } from './review-shadow-core.mjs';
import { evaluateApproval, evaluateShadow } from './review-shadow.mjs';

// 사용자가 명시적으로 실행하는 병합 도구의 판정과 실행. workflow에서는 호출하지 않는다.
// gh·git 실행 함수를 주입받으므로 실제 CLI 없이 같은 흐름을 테스트할 수 있다.
const shaPattern = /^[a-f0-9]{40}$/;
const gateCheckName = 'independent-review';
const reviewRequestBody = '@codex review';
// GitHub 자동 브랜치 삭제는 병합 직후 비동기로 일어난다. 짧게 몇 번만 확인하고 무한 대기하지 않는다.
const remoteDeleteChecks = 3;
const remoteDeleteWaitMs = 2000;

export const usage = '사용법: node .github/scripts/merge-pr.mjs owner/repo PR번호 [squash] [--dry-run] [--auto | --request-review] [--head <40자리 SHA>]';

export function parseArgs(argv) {
  const [repo, number, ...rest] = argv;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '') || !/^[1-9][0-9]*$/.test(number ?? '')) return null;
  const options = { repo, number: Number(number), dryRun: false, auto: false, requestReview: false, head: null };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    // 기존 사용법의 `squash` 인수는 그대로 받는다. 다른 병합 방식은 지원하지 않는다.
    if (arg === 'squash') continue;
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--auto') options.auto = true;
    else if (arg === '--request-review') options.requestReview = true;
    else if (arg === '--head' && shaPattern.test(rest[index + 1] ?? '')) { options.head = rest[index + 1]; index += 1; }
    else return null;
  }
  return options.auto && options.requestReview ? null : options;
}

const segments = path => path.split('/').map(encodeURIComponent).join('/');
const isDefaultName = (branch, defaultBranch) => branch === defaultBranch || branch === 'main';

// gh CLI를 Octokit 형태로 감싸 기존 게이트·Shadow 판정 코드를 그대로 재사용한다.
export function createGitHub({ gh, repo }) {
  const json = args => JSON.parse(gh(args));
  const api = path => {
    try { return json(['api', path]); } catch (error) {
      // 외부 리뷰어의 명시적인 404와 통신·인증 실패를 구분한다.
      if (/\(HTTP 404\)/.test(String(error?.stderr ?? ''))) error.status = 404;
      throw error;
    }
  };
  // 목록 응답이 객체로 감싸진 API(check run 등)는 key로 꺼낸다. 형식이 다르면 일부만 조회한 것으로 보지 않고 실패시킨다.
  const list = (path, key) => {
    const pages = json(['api', `${path}${path.includes('?') ? '&' : '?'}per_page=100`, '--paginate', '--slurp']);
    if (!key) return pages.flat();
    if (pages.some(page => !Array.isArray(page?.[key]))) throw new Error('목록 응답 형식 오류');
    return pages.flatMap(page => page[key]);
  };
  const fill = (pattern, args) => pattern.replace(/:([a-z_]+)/g, (_, key) => encodeURIComponent(args[key]));
  const one = pattern => async args => ({ data: api(fill(pattern, args)) });
  const many = (pattern, key) => async args => ({ data: list(fill(pattern, args), key) });
  return {
    api, list,
    rest: {
      pulls: {
        list: many(`repos/${repo}/pulls?state=open`), get: one(`repos/${repo}/pulls/:pull_number`),
        listFiles: many(`repos/${repo}/pulls/:pull_number/files`), listReviews: many(`repos/${repo}/pulls/:pull_number/reviews`),
        listReviewComments: many(`repos/${repo}/pulls/:pull_number/comments`),
      },
      issues: { listComments: many(`repos/${repo}/issues/:issue_number/comments`) },
      repos: {
        getCollaboratorPermissionLevel: one(`repos/${repo}/collaborators/:username/permission`),
        compareCommitsWithBasehead: one(`repos/${repo}/compare/:basehead?per_page=1`),
      },
      checks: {
        listForRef: many(`repos/${repo}/commits/:ref/check-runs?filter=all`, 'check_runs'),
        listSuitesForRef: many(`repos/${repo}/commits/:ref/check-suites`, 'check_suites'),
      },
    },
    graphql: async (query, variables) => {
      const args = ['api', 'graphql', '-f', `query=${query}`];
      for (const [key, value] of Object.entries(variables)) args.push(Number.isInteger(value) ? '-F' : '-f', `${key}=${value}`);
      const result = json(args);
      if (result.errors?.length || !result.data) throw new Error('GraphQL 조회 실패');
      return result.data;
    },
    paginate: async (fn, args) => (await fn(args)).data,
  };
}

// 필수 CI가 기본 브랜치에 승인된 workflow 파일의 pull_request 실행에서 나왔는지 확인한다.
// 같은 GitHub Actions 앱을 쓰는 다른 workflow가 같은 이름의 check를 게시하는 경우를 구별한다.
function requiredCheckSource({ github, repo, head, defaultBranch, check, workflow }) {
  if (!workflow) return 'unconfigured';
  if (!check || check.status !== 'completed' || check.conclusion !== 'success' || !Number.isSafeInteger(check.check_suite?.id)) return 'untrusted';
  const run = github.list(`repos/${repo}/actions/runs?head_sha=${head}`, 'workflow_runs').find(item => item.check_suite_id === check.check_suite.id);
  if (!run || run.path !== workflow || run.event !== 'pull_request' || run.head_sha !== head || run.status !== 'completed'
      || run.conclusion !== 'success' || run.repository?.full_name !== repo || run.head_repository?.full_name !== repo) return 'untrusted';
  const approved = github.api(`repos/${repo}/contents/${segments(workflow)}?ref=${encodeURIComponent(defaultBranch)}`).sha;
  const executed = github.api(`repos/${repo}/contents/${segments(workflow)}?ref=${head}`).sha;
  if (!approved) return 'untrusted';
  return executed === approved ? 'verified' : 'changed';
}
const sourceLabels = { verified: '승인된 workflow 확인', changed: 'PR에서 workflow 변경됨', untrusted: '승인된 workflow 실행이 아님', unconfigured: '출처 workflow 설정 없음', error: '조회 실패' };

function protectionProblems({ protection, gateAppId, requiredChecks }) {
  const status = protection?.required_status_checks;
  const pinned = (name, appId) => Number.isSafeInteger(appId) && status?.checks?.some(item => item.context === name && item.app_id === appId);
  const problems = [];
  if (status?.strict !== true) problems.push('브랜치 보호: 최신 base 요구(strict) 꺼짐');
  if (!pinned(gateCheckName, gateAppId)) problems.push(`브랜치 보호: ${gateCheckName} 필수 검사·게시 앱 고정 없음`);
  for (const { name, appId } of requiredChecks) if (!pinned(name, appId)) problems.push(`브랜치 보호: ${name} 필수 검사·게시 앱 고정 없음`);
  // 관리자에게 보호 규칙이 적용되지 않으면 같은 인증의 병합이 필수 검사를 우회할 수 있다.
  if (protection?.enforce_admins?.enabled !== true) problems.push('브랜치 보호: 관리자 포함 적용(enforce_admins) 꺼짐');
  return problems;
}

const tryGit = (git, args) => { try { return git(args); } catch { return null; } };

// 로컬 저장소가 대상 GitHub 저장소를 가리키는 원격 이름. 없으면 로컬 작업을 하지 않는다.
// push는 원격의 모든 push URL로 전달되므로, push URL이 하나라도 다른 저장소면 그 원격은 쓰지 않는다.
export function findRemote(git, repo) {
  const output = tryGit(git, ['remote', '-v']);
  if (output === null) return null;
  const urls = ['https://github.com/', 'git@github.com:', 'ssh://git@github.com/'].flatMap(prefix => [`${prefix}${repo}`, `${prefix}${repo}.git`].map(url => url.toLowerCase()));
  const pushUrls = new Map();
  for (const [name, url, kind] of output.split('\n').map(line => line.trim().split(/\s+/))) {
    if (name && kind === '(push)') pushUrls.set(name, [...(pushUrls.get(name) ?? []), String(url).toLowerCase()]);
  }
  const names = [...pushUrls].filter(([, list]) => list.every(url => urls.includes(url))).map(([name]) => name);
  return names.includes('origin') ? 'origin' : names[0] ?? null;
}

// 로컬 브랜치는 모든 조건이 확인될 때만 삭제한다. 하나라도 불확실하면 건너뛰고 이유를 보고한다.
export function planLocalCleanup({ git, repo, branch, head, defaultBranch }) {
  const skip = reason => ({ action: 'skip', reason });
  if (!branch || isDefaultName(branch, defaultBranch)) return skip('기본 브랜치는 삭제하지 않음');
  if (!findRemote(git, repo)) return skip('현재 위치가 대상 저장소의 로컬 Git 저장소가 아님');
  const ref = `refs/heads/${branch}`;
  const local = tryGit(git, ['rev-parse', '--verify', '--quiet', ref])?.trim();
  if (!local) return skip('로컬 브랜치 없음');
  if (local !== head) return skip('로컬 브랜치가 검증된 PR head와 다름(추가 커밋 등)');
  if (tryGit(git, ['symbolic-ref', '--quiet', '--short', 'HEAD'])?.trim() === branch) return skip('현재 체크아웃 중인 브랜치');
  const worktrees = tryGit(git, ['worktree', 'list', '--porcelain']);
  if (worktrees === null) return skip('worktree 조회 실패');
  if (worktrees.split('\n').some(line => line.trim() === `branch ${ref}`)) return skip('다른 worktree에서 사용 중');
  const status = tryGit(git, ['status', '--porcelain']);
  if (status === null) return skip('작업 트리 상태 조회 실패');
  if (status.trim()) return skip('로컬 작업 트리에 커밋하지 않은 변경 있음');
  return { action: 'delete', ref };
}

export function planCleanup({ git, repo, pr, defaultBranch, deleteBranchOnMerge }) {
  const branch = pr.head?.ref;
  let remote;
  if (pr.head?.repo?.full_name !== repo) remote = '건너뜀 — 다른 저장소(fork) 브랜치';
  else if (isDefaultName(branch, defaultBranch)) remote = '건너뜀 — 기본 브랜치';
  else remote = `${deleteBranchOnMerge ? 'GitHub 자동 삭제(설정 켜짐) 확인' : 'GitHub 자동 삭제 설정 꺼짐'}. 남아 있으면 보호 여부·다른 열린 PR·SHA를 확인한 뒤 SHA 조건부 삭제`;
  const local = planLocalCleanup({ git, repo, branch, head: pr.head?.sha, defaultBranch });
  return { branch, remote, local: local.action === 'delete' ? '삭제 예정(SHA 조건부)' : `건너뜀 — ${local.reason}` };
}

export async function assessMerge({ gh, git, repo, number, mode, expectedHead = null }) {
  const github = createGitHub({ gh, repo });
  const [owner, name] = repo.split('/');
  const repoRef = { owner, repo: name };
  // 같은 사유가 여러 조건에서 나와도 한 번만 보고한다.
  const blockers = new Set();
  const assessment = { repo, number, mode };
  const finish = () => ({ ...assessment, blockers: [...blockers], ok: blockers.size === 0 });

  let repository; let pr; let config;
  try {
    repository = github.api(`repos/${repo}`);
    pr = github.api(`repos/${repo}/pulls/${number}`);
    // PR이 자기 정책을 바꿔 통과하지 못하도록 기본 브랜치의 승인된 설정만 사용한다.
    const file = github.api(`repos/${repo}/contents/.ai/review-config.json?ref=${encodeURIComponent(repository.default_branch)}`);
    if (file.encoding !== 'base64') throw new Error('정책 형식 오류');
    config = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  } catch {
    blockers.add('조회 실패: 저장소·PR·기본 브랜치의 승인된 정책');
    return finish();
  }
  const defaultBranch = repository.default_branch;
  Object.assign(assessment, {
    defaultBranch, autoMerge: config.autoMerge?.enabled === true ? '활성' : '비활성',
    pr: { title: pr.title, body: pr.body ?? '', head: pr.head?.sha, headRef: pr.head?.ref },
    // 병합 직전 변경 감지의 기준이 되는 원본 PR 응답.
    source: pr,
  });
  try { pullRequestSnapshot(pr); } catch { blockers.add('PR 상태 값 누락 또는 형식 오류'); return finish(); }
  if (pr.state !== 'open') { blockers.add(`PR 상태: ${pr.merged ? '이미 병합됨' : pr.state}`); return finish(); }
  if (pr.draft) blockers.add('PR 상태: draft');
  if (!validTitle(pr.title)) blockers.add('PR 제목 규칙 오류');
  if (pr.base?.ref !== defaultBranch || pr.base?.repo?.full_name !== repo) blockers.add('기본 브랜치 대상 PR이 아님');
  // fork PR은 리뷰 요청(구독 사용량)과 이 도구의 병합 대상에서 제외한다.
  if (pr.head?.repo?.full_name !== repo) blockers.add('다른 저장소(fork)의 PR');
  if (expectedHead && pr.head?.sha !== expectedHead) blockers.add('지정한 --head와 현재 PR head 불일치');

  let evaluation;
  try { evaluation = await evaluatePR({ github, repo: repoRef, pr, config }); } catch {
    blockers.add('기존 게이트 평가 실패: 조회·형식·최신성 오류');
    return finish();
  }
  const { description, decision } = evaluation;
  const head = description.head;
  Object.assign(assessment, { head, fingerprint: description.fingerprint, gate: { state: decision.state, reason: decision.reason, source: '확인 안 함' } });

  let shadow = null;
  try { shadow = await evaluateShadow({ github, repo: repoRef, pr, config, evaluation, canConfirm: evaluation.canConfirm }); } catch { shadow = null; }
  if (!shadow) {
    blockers.add('위험도 판정 불가: 설정 비활성 또는 조회·형식 오류');
    return finish();
  }
  assessment.shadow = shadow;
  // 실행 직전 재확인에 쓰는 근거: 승인에 사용한 댓글 원본, 같은 권한 확인 함수, 기본 브랜치 정책.
  Object.assign(assessment, {
    config, canConfirm: evaluation.canConfirm,
    approvalComment: evaluation.comments.find(comment => shadow.approval.state === 'approved' && comment.id === shadow.approval.commentId) ?? null,
  });
  const risk = shadow.risk.risk;

  if (mode === 'request-review') {
    if (risk === 'low') blockers.add('Low는 Codex 리뷰 요청 대상 아님');
    if (shadow.meta['implemented-by'] === 'codex') blockers.add('Codex 구현 PR은 Codex 리뷰로 독립 검증 불가');
    if (!shadow.request.allowed) blockers.add(`리뷰 요청 불가: ${shadow.request.reason}`);
    return finish();
  }

  // 현재 필수 검사인 기존 게이트는 모든 병합 방식에서 통과해야 한다.
  if (decision.state !== 'success') blockers.add(`기존 게이트(${gateCheckName}): ${decision.reason}`);
  let checkRuns = [];
  try { checkRuns = github.list(`repos/${repo}/commits/${head}/check-runs?filter=all`, 'check_runs'); } catch { blockers.add('조회 실패: head의 check run'); }
  const gateCheck = checkRuns.filter(run => run.name === gateCheckName).sort((a, b) => b.id - a.id)[0];
  if (decision.state === 'success') {
    try {
      await verifyGateSource({ check: gateCheck, pr, fingerprint: description.fingerprint, repository: repo, defaultBranch, api: github.api });
      assessment.gate.source = '확인됨';
    } catch {
      assessment.gate.source = '확인 실패';
      blockers.add(`기존 게이트 검사의 출처·최신성 확인 실패`);
    }
  }

  assessment.checkSources = [];
  for (const required of config.shadow.requiredChecks) {
    const state = shadow.checks.find(check => check.name === required.name)?.state ?? 'missing';
    if (state !== 'success') { blockers.add(`필수 CI ${required.name}: ${state}`); continue; }
    let source;
    try {
      source = requiredCheckSource({ github, repo, head, defaultBranch, workflow: required.workflow,
        check: latestCheckRun({ head, checkRuns, name: required.name, appId: required.appId }) });
    } catch { source = 'error'; }
    assessment.checkSources.push({ name: required.name, source });
    // CI workflow 변경은 고위험 경로라 High 승인 대상이다. 그 밖의 위험도에서 보이면 분류 오류로 보고 멈춘다.
    if (source === 'changed' ? risk !== 'high' : source !== 'verified') blockers.add(`필수 CI ${required.name} 출처: ${sourceLabels[source]}`);
  }
  if (shadow.baseSync !== 'current') blockers.add(`최신 base 반영: ${shadow.baseSync}`);
  if (evaluation.blocked) blockers.add('해제되지 않은 변경 요청 리뷰');
  // High 병합은 `/review-gate` 리뷰 확인과 별개로 head·fingerprint를 고정한 사용자 승인이 필요하다.
  if (risk === 'high' && shadow.approval.state !== 'approved') blockers.add(`사용자 승인: ${shadow.approval.reason ?? '없음'}`);

  try {
    const protection = github.api(`repos/${repo}/branches/${encodeURIComponent(defaultBranch)}/protection`);
    for (const problem of protectionProblems({ protection, gateAppId: gateCheck?.app?.id, requiredChecks: config.shadow.requiredChecks })) blockers.add(problem);
  } catch {
    // 권한 부족으로 조회하지 못해도 권한을 높이거나 보호 확인을 생략하지 않는다.
    blockers.add('조회 실패: 기본 브랜치 보호 설정');
  }
  try { gh(['pr', 'checks', String(number), '--repo', repo, '--required']); } catch { blockers.add('필수 검사(gh pr checks --required) 미통과·진행 중·조회 실패'); }

  if (mode === 'auto') {
    if (config.autoMerge?.enabled !== true) blockers.add('자동 병합 비활성(기본 브랜치 .ai/review-config.json의 autoMerge.enabled)');
    for (const blocker of shadow.decision.blockers) blockers.add(blocker);
  }
  assessment.cleanup = planCleanup({ git, repo, pr, defaultBranch, deleteBranchOnMerge: repository.delete_branch_on_merge === true });
  return finish();
}

const modeLabels = {
  manual: '수동 병합(사용자 지시로 실행, 기존 게이트 + 공통 안전 조건)',
  auto: '자동 병합(위험도 기준)',
  'request-review': 'Codex GitHub 리뷰 요청',
};

export function formatAssessment(assessment, { dryRun }) {
  const { shadow, gate, pr } = assessment;
  const lines = [`PR #${assessment.number} 점검 — ${modeLabels[assessment.mode]}${dryRun ? ' [dry-run: 병합·댓글·브랜치 삭제 없음]' : ''}`];
  if (pr) lines.push(`- 대상: ${pr.title} (head ${pr.head ?? '알 수 없음'} → ${assessment.defaultBranch})`);
  if (shadow) {
    const { risk, codex, request, approval, decision } = shadow;
    const sources = new Map((assessment.checkSources ?? []).map(item => [item.name, sourceLabels[item.source]]));
    const findings = codex.findings ? ` (critical ${codex.findings.critical}·high ${codex.findings.high}·medium ${codex.findings.medium}·low ${codex.findings.low}·unknown ${codex.findings.unknown})` : '';
    lines.push(
      `- 위험도: ${risk.risk} — ${risk.reasons.join('; ')}`,
      `- 필수 CI: ${shadow.checks.map(check => `${check.name} ${check.state}${sources.has(check.name) ? `(${sources.get(check.name)})` : ''}`).join(', ')}`,
      `- 최신 base 반영: ${shadow.baseSync}`,
      `- 독립 리뷰(Codex GitHub): ${codex.status} — ${codex.reason}${findings}`,
      `- 리뷰 요청: PR ${request.requestCount}회(최신 head ${request.headRequestCount ?? '알 수 없음'}회), 새 요청 ${request.allowed ? '가능' : `불가(${request.reason})`}`,
      `- 사용자 승인: ${risk.risk === 'high' ? `필요 — ${approval.state}${approval.reason ? ` (${approval.reason})` : ''}` : '불필요'}`,
    );
    if (risk.risk === 'high' && approval.state !== 'approved' && assessment.head) {
      lines.push(`  승인 명령(변경을 확인한 관리자가 직접 PR 댓글로 작성): ${approvalText(assessment.head, assessment.fingerprint)}`);
    }
    lines.push(`- 자동 병합 판정(위험도 기준): ${decision.candidate ? '후보' : `후보 아님 — ${decision.blockers.join('; ')}`} / 자동 병합 설정: ${assessment.autoMerge}`);
  }
  if (gate) lines.push(`- 기존 게이트(${gateCheckName}, 현재 필수): ${gate.state} — ${gate.reason} / 검사 출처: ${gate.source}`);
  if (assessment.fingerprint) lines.push(`- 기준 fingerprint: ${assessment.fingerprint}`);
  const action = assessment.mode === 'request-review' ? '리뷰 요청' : '병합';
  lines.push(`- 현재 ${action} 가능: ${assessment.ok ? '예' : '아니오'}`);
  if (!assessment.ok) lines.push(`- ${action}을 막는 이유:`, ...assessment.blockers.map(blocker => `  - ${blocker}`));
  if (assessment.cleanup) {
    lines.push('- 병합 후 브랜치 정리 예정:', `  - 원격 ${assessment.cleanup.branch}: ${assessment.cleanup.remote}`, `  - 로컬 ${assessment.cleanup.branch}: ${assessment.cleanup.local}`);
  }
  return lines.join('\n');
}

// 같은 PR에 대한 동시 실행을 막는다. 비정상 종료로 남은 잠금은 사람이 확인한 뒤 지운다.
export function fileLock(key) {
  const path = join(tmpdir(), `merge-pr-${key.replace(/[^A-Za-z0-9_.-]/g, '-')}.lock`);
  try { writeFileSync(path, `${process.pid}\n`, { flag: 'wx', mode: 0o600 }); } catch { return { ok: false, path }; }
  return { ok: true, path, release: () => rmSync(path, { force: true }) };
}

async function cleanupRemote({ github, git, repo, pr, head, defaultBranch, sleep }) {
  const branch = pr.head?.ref;
  const label = `원격 ${branch}`;
  if (pr.head?.repo?.full_name !== repo) return `${label}: 건너뜀 — 다른 저장소(fork) 브랜치`;
  if (isDefaultName(branch, defaultBranch)) return `${label}: 건너뜀 — 기본 브랜치`;
  let ref;
  for (let check = 1; check <= remoteDeleteChecks; check += 1) {
    try { ref = github.api(`repos/${repo}/git/ref/heads/${segments(branch)}`); } catch (error) {
      return error.status === 404 ? `${label}: GitHub 자동 삭제 확인` : `${label}: 조회 실패 — 삭제하지 않음`;
    }
    if (check < remoteDeleteChecks) await sleep(remoteDeleteWaitMs);
  }
  // 자동 삭제가 동작하지 않았을 때만 모든 조건을 확인하고, 원격 SHA가 그대로일 때만 지워지도록 lease를 건다.
  try {
    if (ref?.object?.sha !== head) return `${label}: 삭제하지 않음 — 원격 브랜치 SHA가 검증된 head와 다름`;
    if (github.api(`repos/${repo}/branches/${segments(branch)}`).protected !== false) return `${label}: 삭제하지 않음 — 보호 브랜치이거나 보호 여부 불명`;
    const owner = repo.split('/')[0];
    const users = [
      ...github.list(`repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`),
      ...github.list(`repos/${repo}/pulls?state=open&base=${encodeURIComponent(branch)}`),
    ];
    if (users.length) return `${label}: 삭제하지 않음 — 다른 열린 PR에서 사용 중`;
  } catch { return `${label}: 조회 실패 — 삭제하지 않음`; }
  const remote = findRemote(git, repo);
  if (!remote) return `${label}: 삭제하지 않음 — 대상 저장소를 가리키는 로컬 원격 없음`;
  try { git(['push', `--force-with-lease=refs/heads/${branch}:${head}`, remote, `:refs/heads/${branch}`]); } catch {
    return `${label}: 삭제 실패 — SHA 변경 또는 권한 오류일 수 있음. 직접 확인 필요`;
  }
  return `${label}: GitHub 자동 삭제가 동작하지 않아 SHA 조건부로 삭제함`;
}

function cleanupLocal({ git, repo, branch, head, defaultBranch }) {
  const plan = planLocalCleanup({ git, repo, branch, head, defaultBranch });
  if (plan.action !== 'delete') return `로컬 ${branch}: 건너뜀 — ${plan.reason}`;
  // 확인 뒤 바뀐 브랜치를 지우지 않도록 예상 SHA를 지정해 삭제한다.
  try { git(['update-ref', '-d', plan.ref, head]); } catch { return `로컬 ${branch}: 삭제 실패 — SHA가 바뀌었거나 Git 오류. 직접 확인 필요`; }
  tryGit(git, ['config', '--remove-section', `branch.${branch}`]);
  return `로컬 ${branch}: 삭제함(${head.slice(0, 10)} 조건부)`;
}

async function mergeAndCleanup({ gh, git, repo, number, assessment, out, err, sleep }) {
  const github = createGitHub({ gh, repo });
  const { pr, head, defaultBranch } = assessment;
  let directory; let merged = false; let after;
  try {
    // 셸 문자열을 만들지 않고 인수 배열과 UTF-8 파일로 제목·본문·Issue 자동 종료 키워드를 그대로 보존한다.
    directory = mkdtempSync(join(tmpdir(), 'merge-pr-'));
    const bodyFile = join(directory, 'body.txt');
    writeFileSync(bodyFile, pr.body, { encoding: 'utf8', mode: 0o600 });
    try {
      // squash만 사용하고 관리자 우회·GitHub auto-merge·gh의 브랜치 삭제 옵션은 쓰지 않는다.
      gh(['pr', 'merge', String(number), '--repo', repo, '--squash', '--match-head-commit', head, '--subject', pr.title, '--body-file', bodyFile]);
    } catch {
      // 실패 응답이어도 실제로는 병합됐을 수 있다. 다시 병합하지 않고 실제 상태만 조회한다.
      let now;
      try { now = github.api(`repos/${repo}/pulls/${number}`); } catch { now = null; }
      if (!now?.merged || now.head?.sha !== head) {
        err('병합 명령이 실패했습니다. 자동으로 다시 시도하지 않습니다. GitHub PR 상태를 확인하세요. 원시 오류·인증값은 출력하지 않습니다.');
        return 1;
      }
      out('병합 명령은 실패로 응답했지만 실제 병합을 확인했습니다. 사후 검증을 계속합니다.');
    }
    merged = true;
    after = github.api(`repos/${repo}/pulls/${number}`);
    if (!after.merged || !shaPattern.test(after.merge_commit_sha ?? '') || after.head?.sha !== head) throw new Error('병합 결과 조회 실패');
    const subject = github.api(`repos/${repo}/commits/${after.merge_commit_sha}`).commit.message.split('\n')[0];
    if (subject !== pr.title || !validTitle(subject)) throw new Error('저장된 병합 제목 불일치');
    out(`병합과 실제 제목 검증 완료: ${after.merge_commit_sha}`);
    out(subject);
  } catch {
    err(merged
      ? '병합 명령은 완료됐지만 사후 검증이 실패했습니다. PR과 실제 병합 커밋을 사람이 확인하세요. 재병합·이력 재작성·브랜치 정리는 하지 않습니다.'
      : '병합 준비 또는 병합 명령이 실패했습니다. GitHub PR 상태를 확인하세요. 원시 오류·인증값은 출력하지 않습니다.');
    return 1;
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
  // 병합과 제목 검증이 끝난 뒤에만 정리한다. 정리 실패는 이미 끝난 병합을 바꾸지 않고 보고만 한다.
  out('브랜치 정리:');
  out(`- ${await cleanupRemote({ github, git, repo, pr: after, head, defaultBranch, sleep })}`);
  out(`- ${cleanupLocal({ git, repo, branch: after.head?.ref, head, defaultBranch })}`);
  return 0;
}

function postReviewRequest({ gh, repo, number, out, err }) {
  let created;
  try { created = JSON.parse(gh(['api', `repos/${repo}/issues/${number}/comments`, '-f', `body=${reviewRequestBody}`])); } catch { created = null; }
  if (!Number.isSafeInteger(created?.id)) {
    err('리뷰 요청 댓글 작성 결과를 확인하지 못했습니다. 자동으로 다시 요청하지 않습니다. PR 댓글을 직접 확인하세요.');
    return 1;
  }
  out(`Codex 리뷰 요청 댓글 작성: ${created.id}. 결과는 다음 dry-run 또는 게이트 Summary에서 확인합니다.`);
  return 0;
}

// 실행 직전 마지막 확인. 두 번째 점검이 댓글을 모은 뒤 바뀐 PR과 댓글 근거를 다시 조회해 같은 판정 함수로 다시 계산한다.
// 댓글 목록을 모두 조회한 **뒤에** PR을 다시 읽어 목록이 완전한지 확인하므로, 무관한 새 댓글은 막지 않고 누락된 목록은 막는다.
async function finalEvidenceHolds({ github, repo, number, mode, first, again }) {
  const { shadow } = again;
  const [owner, name] = repo.split('/');
  const repoRef = { owner, repo: name };
  const comments = github.list(`repos/${repo}/issues/${number}/comments`);
  const requesting = mode === 'request-review';
  const reviews = requesting ? github.list(`repos/${repo}/pulls/${number}/reviews`) : [];
  const reviewComments = requesting ? github.list(`repos/${repo}/pulls/${number}/comments`) : [];
  const latest = github.api(`repos/${repo}/pulls/${number}`);
  assertPullRequestUnchanged(first.source, latest);
  if (comments.length !== latest.comments || (requesting && reviewComments.length !== latest.review_comments)) return false;
  if (requesting) {
    // 같은 head 요청·대기·상한·한도 초과를 Shadow와 같은 함수로 다시 계산한다. 결과는 commit_sha로만 head에 연결된다.
    const codex = evaluateCodexReview({ head: again.head, comments, reviews, reviewComments, bot: again.config.shadow.codexReviewer });
    return planReviewRequest({ comments, codex, maxReviewRequests: again.config.shadow.maxReviewRequests, headSeenAt: shadow.headSeenAt }).allowed;
  }
  if (shadow.risk.risk !== 'high') return true;
  // 같은 승인 댓글이 그대로 남아 있고(ID·작성자·본문·수정 시각), 지금도 같은 함수로 승인으로 판정돼야 한다(권한·head·fingerprint·변경 시각).
  const used = again.approvalComment;
  const now = comments.find(comment => comment.id === used?.id);
  if (!used || !now || now.user?.id !== used.user?.id || now.body !== used.body || now.updated_at !== used.updated_at) return false;
  const approval = await evaluateApproval({ github, repo: repoRef, number, head: again.head, fingerprint: again.fingerprint, comments, canConfirm: again.canConfirm });
  return approval.state === 'approved' && approval.commentId === used.id;
}

export async function runMergeTool({ argv, gh, git, out = console.log, err = console.error, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), lock = fileLock }) {
  const options = parseArgs(argv);
  if (!options) { err(usage); return 1; }
  const { repo, number } = options;
  const mode = options.requestReview ? 'request-review' : options.auto ? 'auto' : 'manual';
  const assess = () => assessMerge({ gh, git, repo, number, mode, expectedHead: options.head });
  if (options.dryRun) {
    // dry-run은 조회만 한다. 잠금 파일도 만들지 않는다.
    const assessment = await assess();
    out(formatAssessment(assessment, { dryRun: true }));
    return assessment.ok ? 0 : 1;
  }
  const held = lock(`${repo}#${number}`);
  if (!held.ok) {
    err(`같은 PR에 대한 병합 도구가 실행 중이거나 이전 실행의 잠금 파일이 남아 있습니다. 실행 중인 작업이 없는지 확인한 뒤 직접 삭제하세요: ${held.path}`);
    return 1;
  }
  try {
    const first = await assess();
    out(formatAssessment(first, { dryRun: false }));
    if (!first.ok) return 1;
    // 실행 직전에 모든 조건을 다시 조회한다. 그 사이 head·본문·파일·정책·판정이 바뀌면 진행하지 않는다.
    const again = await assess();
    const changed = async () => {
      try {
        assertPullRequestUnchanged(first.source, again.source);
        return !await finalEvidenceHolds({ github: createGitHub({ gh, repo }), repo, number, mode, first, again });
      } catch { return true; }
    };
    if (!again.ok || again.head !== first.head || again.fingerprint !== first.fingerprint || again.shadow.risk.risk !== first.shadow.risk.risk || await changed()) {
      err('실행 직전 재확인에서 조건이 바뀌었습니다. 진행하지 않습니다. dry-run으로 다시 점검하세요.');
      return 1;
    }
    // 여기서부터 GitHub 쓰기 호출까지의 경합은 병합 API의 --match-head-commit(head)과 브랜치 보호(strict·필수 검사)만 막는다.
    // base·제목·본문과 승인·요청 댓글을 병합·댓글 API가 원자적으로 고정하지는 않는다.
    if (mode === 'request-review') return postReviewRequest({ gh, repo, number, out, err });
    return await mergeAndCleanup({ gh, git, repo, number, assessment: again, out, err, sleep });
  } finally {
    held.release();
  }
}

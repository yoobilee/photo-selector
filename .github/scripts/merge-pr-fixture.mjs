import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { describe, gateEvidence, sha256 } from './review-gate-core.mjs';
import { gitBlobSha, trustedModules } from './merge-pr-core.mjs';
import { approvalText } from './review-shadow-core.mjs';

// 병합 도구 테스트용 가짜 gh·git. GitHub API 응답 형식과 실제 Codex GitHub 응답 원문을 사용한다.
// 테스트 안에서 직접 호출하거나(Windows 포함), Linux CLI 테스트에서 가짜 실행 파일이 불러 쓴다.
const real = JSON.parse(readFileSync(new URL('./fixtures/codex-github-responses.json', import.meta.url), 'utf8'));
const approvedConfig = readFileSync(new URL('../../.ai/review-config.json', import.meta.url), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));

export const repo = 'owner/repo';
export const head = real.photoSelectorPr5.head;
export const newHead = 'e'.repeat(40);
export const base = 'b'.repeat(40);
export const mergeSha = 'c'.repeat(40);
export const branch = 'feature/safe-merge';
export const title = 'fix: 한글 제목 "인용"과 $(명령) 보존';
const admin = { id: 1, login: 'owner', type: 'User' };
const peer = { id: 2, login: 'peer', type: 'User' };
const actionsApp = { id: 15368, slug: 'github-actions' };
const profiles = {
  low: { filename: 'README.md', sensitive: 'no' },
  medium: { filename: 'src/App.tsx', sensitive: 'no' },
  high: { filename: 'src/auth.ts', sensitive: 'yes' },
};

const failure = (message, status = 500) => Object.assign(new Error(message), { stderr: `gh: ${message} (HTTP ${status})` });

// 실제 PR #5 상태 댓글에서 상태 값만 바꾼다.
function stateComment(change = {}, sha = head) {
  const comment = clone(real.photoSelectorPr5.reviewSummaryCompleted);
  comment.body = comment.body.replace(/<!-- codex-review-state:v1 (\{.*\}) -->/, (_, json) => {
    const state = JSON.parse(json);
    Object.assign(state.code_review, { commit_sha: sha }, change);
    return `<!-- codex-review-state:v1 ${JSON.stringify(state)} -->`;
  });
  return comment;
}

export function createFake(options = {}, store = {}) {
  const o = {
    risk: 'high', implementedBy: 'claude', gate: true, codex: 'clean', approval: 'valid', requests: 1, lastEditedAt: null,
    ci: 'success', ciSource: 'ok', behindBy: 0, strict: true, enforceAdmins: true, verifyPinned: true, prChecks: true, gateCheck: 'ok',
    code: 'same', deleteOnMerge: true, remoteAfterMerge: 'deleted', otherHeadPr: false, otherBasePr: false, branchProtected: false,
    headChangeAtChecks: null, merge: 'ok', badSubject: false, apiError: null, state: 'open', draft: false, headRepo: repo, local: {},
    ...options,
  };
  const local = { repo: true, exists: true, sha: head, current: 'main', otherWorktree: false, dirty: false, ...o.local };
  store.calls ??= [];
  store.checksCalls ??= 0;
  store.head ??= head;
  store.merged ??= o.state === 'merged';
  store.remote ??= { exists: true, sha: head };
  store.localSha ??= local.exists ? local.sha : null;
  store.posted ??= [];

  const config = JSON.parse(approvedConfig);
  const profile = profiles[o.risk];
  const files = [{ filename: profile.filename, status: 'modified' }];
  const body = o.body ?? `<!-- ai-review\nimplemented-by: ${o.implementedBy}\nrisk: ${o.risk}\nsensitive-change: ${profile.sensitive}\n-->\nCloses #7`;
  // store.prChange: 점검 도중 PR이 바뀐 상황(재지정·제목·본문·draft·닫힘)을 흉내 낸다. 바뀐 base SHA는 compare 조회가 실패한다.
  const prAt = sha => {
    const change = store.prChange ?? {};
    return {
      number: 1, title: change.title ?? title, body: change.body ?? body, state: store.merged ? 'closed' : o.state === 'merged' ? 'closed' : change.state ?? o.state,
      draft: change.draft ?? o.draft, merged: store.merged, merge_commit_sha: store.merged ? mergeSha : null, changed_files: files.length,
      head: { sha, ref: branch, repo: { full_name: o.headRepo } }, base: { sha: change.baseSha ?? base, ref: change.baseRef ?? 'main', repo: { full_name: repo } },
    };
  };
  // 관리자 확인과 승인은 원래 head 기준으로 작성된 것으로 둔다. head가 바뀌면 둘 다 무효가 돼야 한다.
  const original = describe(prAt(head), files, config);
  const comments = [];
  if (o.gate) {
    const confirm = data => ({ id: 11, user: admin, created_at: '2026-10-27T15:01:00Z', updated_at: '2026-10-27T15:01:00Z', body: `/review-gate\n\`\`\`json\n${JSON.stringify({ fingerprint: original.fingerprint, ...data })}\n\`\`\`` });
    if (o.risk === 'low') comments.push(confirm({ decision: 'skip', reason: '문서만 변경' }));
    else {
      const report = `# 독립 리뷰 보고서\nHEAD: ${head}\nBASE: ${base}\n독립 리뷰 완료`;
      comments.push({ id: 10, user: admin, created_at: '2026-10-27T15:00:00Z', updated_at: '2026-10-27T15:00:00Z', body: report });
      comments.push(confirm({ decision: 'pass', reviewer: 'codex', reviewComplete: true, evidence: 'https://github.com/owner/repo/pull/1#issuecomment-10', evidenceHash: sha256(report), findings: { critical: 0, high: 0, medium: 0, low: 0 } }));
    }
  }
  for (let index = 0; index < o.requests; index += 1) comments.push({ id: 20 + index, user: admin, created_at: `2026-10-27T14:2${index}:00Z`, body: '@codex review' });
  let reviews = []; let reviewComments = [];
  if (o.codex === 'clean') comments.push(stateComment());
  if (o.codex === 'stale') comments.push(stateComment({}, 'd'.repeat(40)));
  if (o.codex === 'running') comments.push(stateComment({ status: 'running', has_any_findings: null, has_unresolved_findings: null }));
  if (o.codex === 'limit') comments.push(clone(real.workyUsageLimit));
  if (o.codex === 'spoof') comments.push({ ...stateComment(), user: { ...admin } });
  if (o.codex === 'findings') {
    comments.push(stateComment({ has_any_findings: true, has_unresolved_findings: true }));
    const { review, comments: inline } = clone(real.workyFindings);
    review.body = review.body.replace(`\`${review.commit_id.slice(0, 10)}\``, `\`${head.slice(0, 10)}\``);
    review.commit_id = head;
    reviews = [review];
    reviewComments = inline.map(comment => ({ ...comment, commit_id: head }));
  }
  const approvals = {
    valid: approvalText(head, original.fingerprint), 'old-head': approvalText('9'.repeat(40), original.fingerprint),
    'old-fingerprint': approvalText(head, '0'.repeat(64)), short: `/merge-approve ${head.slice(0, 7)}`,
  };
  if (approvals[o.approval]) comments.push({ id: 40, user: admin, created_at: '2026-10-28T01:00:00Z', updated_at: '2026-10-28T01:00:00Z', body: approvals[o.approval] });
  // store.commentChange: 점검 도중 댓글이 바뀐 상황. 목록과 PR 정보의 댓글 수가 함께 바뀐다.
  const liveComments = () => {
    switch (store.commentChange) {
      case 'delete-approval': return comments.filter(comment => comment.id !== 40);
      case 'edit-approval': return comments.map(comment => comment.id === 40 ? { ...comment, body: `${comment.body}\n수정`, updated_at: '2026-10-28T02:00:00Z' } : comment);
      // 본문은 그대로 두고 수정만 한 경우(수정 이력)도 승인 근거가 바뀐 것으로 본다.
      case 'touch-approval': return comments.map(comment => comment.id === 40 ? { ...comment, updated_at: '2026-10-28T02:00:00Z' } : comment);
      case 'add-request': return [...comments, { id: 60, user: admin, created_at: '2026-10-28T03:00:00Z', body: '@codex review' }];
      case 'add-bot': return [...comments, { ...clone(real.photoSelectorPr5.environmentNotice), created_at: '2026-10-28T03:00:00Z' }];
      // 기존 게이트 근거(보고서 10, 확인 11)의 수정·삭제·같은 본문 재작성.
      case 'edit-report': return comments.map(comment => comment.id === 10 ? { ...comment, body: `${comment.body}\n추가 메모`, updated_at: '2026-10-28T02:00:00Z' } : comment);
      case 'touch-report': return comments.map(comment => comment.id === 10 ? { ...comment, updated_at: '2026-10-28T02:00:00Z' } : comment);
      case 'delete-report': return comments.filter(comment => comment.id !== 10);
      case 'edit-confirmation': return comments.map(comment => comment.id === 11 ? { ...comment, body: `${comment.body}\n`, updated_at: '2026-10-28T02:00:00Z' } : comment);
      case 'delete-confirmation': return comments.filter(comment => comment.id !== 11);
      case 'repost-confirmation': return [...comments.filter(comment => comment.id !== 11), { ...comments.find(comment => comment.id === 11), id: 70, created_at: '2026-10-28T02:00:00Z', updated_at: '2026-10-28T02:00:00Z' }];
      default: return comments;
    }
  };
  // store.commentChange === 'add-blocking': 쓰기 권한자의 변경 요청 리뷰가 추가된 상황.
  const liveReviews = () => store.commentChange === 'add-blocking'
    ? [...reviews, { id: 80, user: peer, state: 'CHANGES_REQUESTED', commit_id: head, submitted_at: '2026-10-28T02:00:00Z', body: '수정 필요' }]
    : reviews;

  // 게이트가 처음 상태로 판정했을 때의 근거. 게이트 코드와 별개로 근거 댓글을 직접 골라 같은 digest가 나오는지 함께 확인한다.
  const byIdOf = id => comments.find(comment => comment.id === id);
  const initialEvidence = gateEvidence({
    confirmation: byIdOf(11) && { comment: byIdOf(11), role: 'admin' }, report: byIdOf(10) && { comment: byIdOf(10), role: 'admin' },
    approvals: byIdOf(40) ? [{ comment: byIdOf(40), role: 'admin' }] : [], blocking: [],
  });
  // o.gateCheck: 'v1'(근거 없는 이전 proof), 'stale-evidence'(다른 근거로 판정한 v2 proof), 'stale'(이전 fingerprint)
  const gateProof = o.gateCheck === 'v1'
    ? { pr: 1, fingerprint: original.fingerprint, runId: '42', attempt: '1' }
    : { v: 2, pr: 1, fingerprint: o.gateCheck === 'stale' ? 'stale' : original.fingerprint,
      evidenceDigest: o.gateCheck === 'stale-evidence' ? '0'.repeat(64) : initialEvidence.digest, runId: '42', attempt: '1' };
  // store.checkChange(또는 처음부터 o.checkChange): 같은 이름의 verify check가 새로 게시되거나 기존 check를 대체한 상황.
  // add-*는 기존 check(100)를 두고 더 새 check(101)를 더하고, replace-*는 기존 check를 없애고 101만 남긴다.
  store.checkChange ??= o.checkChange ?? null;
  const verifyChanges = {
    'add-other-workflow': { keep: true, path: '.github/workflows/other.yml' },
    'add-other-event': { keep: true, event: 'push' },
    'add-legit-rerun': { keep: true },
    'replace-other-workflow': { keep: false, path: '.github/workflows/other.yml' },
    'replace-other-app': { keep: false, app: { id: 1, slug: 'other' } },
    'replace-other-head': { keep: false, headSha: 'd'.repeat(40) },
  };
  const checkRuns = () => {
    const change = verifyChanges[store.checkChange];
    const original = o.ci === 'missing' || change?.keep === false ? [] : [{ id: 100, name: 'verify', head_sha: head, check_suite: { id: 500 }, app: actionsApp,
      status: o.ci === 'pending' ? 'in_progress' : 'completed', conclusion: o.ci === 'pending' ? null : o.ci }];
    const added = change ? [{ id: 101, name: 'verify', head_sha: change.headSha ?? head, check_suite: { id: 501 }, app: change.app ?? actionsApp, status: 'completed', conclusion: 'success' }] : [];
    return [
      { id: 99, name: 'independent-review', head_sha: head, status: 'completed', conclusion: o.gate ? 'success' : 'failure',
        app: o.gateCheck === 'wrong-app' ? { id: 1, slug: 'other' } : actionsApp, external_id: JSON.stringify(gateProof),
        details_url: o.gateCheck === 'check-url' ? 'https://github.com/owner/repo/runs/99'
          : o.gateCheck === 'wrong-check-url' ? 'https://github.com/owner/repo/runs/100' : 'https://github.com/owner/repo/actions/runs/42' },
      ...original, ...added,
    ];
  };
  const ciRun = { id: 77, check_suite_id: 500, path: o.ciSource === 'wrong-path' ? '.github/workflows/other.yml' : '.github/workflows/ci.yml',
    event: o.ciSource === 'other-event' ? 'push' : 'pull_request', head_sha: head, status: 'completed', conclusion: o.ci === 'success' ? 'success' : 'failure',
    repository: { full_name: repo }, head_repository: { full_name: o.headRepo } };
  // 새 verify check(101)를 게시한 workflow 실행.
  const changedRun = () => {
    const change = verifyChanges[store.checkChange];
    return change ? [{ ...ciRun, id: 78, check_suite_id: 501, path: change.path ?? ciRun.path, event: change.event ?? 'pull_request', conclusion: 'success' }] : [];
  };
  const protection = { required_status_checks: { strict: o.strict, checks: [{ context: 'independent-review', app_id: 15368 }, ...(o.verifyPinned ? [{ context: 'verify', app_id: 15368 }] : [])] }, enforce_admins: { enabled: o.enforceAdmins } };

  function route(path) {
    const p = path.replace(/[?&]per_page=100$/, '');
    if (o.apiError && path.includes(o.apiError)) throw failure('server error');
    // o.failAt: { at, nth } — 해당 경로의 n번째 조회만 실패한다.
    if (o.failAt && path.includes(o.failAt.at) && (store.failHits = (store.failHits ?? 0) + 1) === o.failAt.nth) throw failure('server error');
    // o.commentChangeAt: { at: 경로 일부, nth: 몇 번째 조회, change } — 해당 조회 직후부터 댓글·승인자 권한이 바뀐다.
    if (o.commentChangeAt && path.includes(o.commentChangeAt.at)) {
      store.commentChangeHits = (store.commentChangeHits ?? 0) + 1;
      if (store.commentChangeHits === o.commentChangeAt.nth) store.commentChange = o.commentChangeAt.change;
    }
    // o.checkChangeAt: { at: 경로 일부, nth: 몇 번째 조회, change } — 해당 조회 직후부터 verify check가 바뀐다(store.checkChange).
    if (o.checkChangeAt && path.includes(o.checkChangeAt.at)) {
      store.checkChangeHits = (store.checkChangeHits ?? 0) + 1;
      if (store.checkChangeHits === o.checkChangeAt.nth) store.checkChange = o.checkChangeAt.change;
    }
    // o.prChangeAt: { at: 경로 일부, nth: 몇 번째 조회, change } — 해당 조회 직후부터 PR 정보가 바뀐다.
    if (o.prChangeAt && path.includes(o.prChangeAt.at)) {
      store.prChangeHits = (store.prChangeHits ?? 0) + 1;
      if (store.prChangeHits === o.prChangeAt.nth) {
        const { headSha, ...change } = o.prChangeAt.change;
        if (headSha) store.head = headSha;
        store.prChange = change;
      }
    }
    if (p === `repos/${repo}`) return { default_branch: 'main', delete_branch_on_merge: o.deleteOnMerge };
    if (p === `repos/${repo}/pulls/1`) return { ...prAt(store.head), comments: liveComments().length, review_comments: reviewComments.length };
    if (p.startsWith(`repos/${repo}/pulls?state=open&head=`)) return [o.otherHeadPr ? [{ number: 2 }] : []];
    if (p.startsWith(`repos/${repo}/pulls?state=open&base=`)) return [o.otherBasePr ? [{ number: 3 }] : []];
    if (p === `repos/${repo}/pulls?state=open`) return [store.merged || o.state !== 'open' ? [] : [prAt(store.head)]];
    if (p === `repos/${repo}/pulls/1/files`) return [files];
    if (p === `repos/${repo}/pulls/1/reviews`) return [liveReviews()];
    if (p === `repos/${repo}/pulls/1/comments`) return [reviewComments];
    if (p === `repos/${repo}/issues/1/comments`) return [liveComments()];
    if (p === `repos/${repo}/collaborators/peer/permission`) return { permission: 'write' };
    if (p === `repos/${repo}/collaborators/owner/permission`) return { permission: store.commentChange === 'demote-approver' ? 'read' : 'admin' };
    if (p === `repos/${repo}/contents/.ai/review-config.json?ref=main`) return { encoding: 'base64', content: Buffer.from(JSON.stringify(config)).toString('base64') };
    if (p === `repos/${repo}/commits/${store.head}/check-runs?filter=all` || p === `repos/${repo}/commits/${store.head}/check-runs`) return [{ check_runs: checkRuns() }];
    if (p === `repos/${repo}/commits/${store.head}/check-suites`) return [{ check_suites: [{ id: 500, head_sha: store.head, created_at: o.headSeenAt ?? '2026-10-27T14:00:00Z' }] }];
    if (p === `repos/${repo}/compare/${base}...${store.head}?per_page=1`) {
      if (o.behindBy === 'error') throw failure('compare failed');
      return { behind_by: o.behindBy };
    }
    if (p === `repos/${repo}/actions/workflows/independent-review.yml`) return { id: 4, path: '.github/workflows/independent-review.yml' };
    if (p === `repos/${repo}/actions/runs/42`) return { id: o.gateCheck === 'wrong-run-id' ? 43 : 42, workflow_id: 4, path: '.github/workflows/independent-review.yml', status: 'completed', conclusion: 'success', run_attempt: 1, repository: { full_name: repo }, head_repository: { full_name: repo }, event: 'pull_request_target', head_sha: 'd'.repeat(40) };
    if (p === `repos/${repo}/actions/runs?head_sha=${store.head}`) return [{ workflow_runs: [ciRun, ...changedRun()] }];
    if (p.startsWith(`repos/${repo}/contents/.github/workflows/independent-review.yml?ref=`)) return { sha: 'gate-approved' };
    // 'main-workflow-updated': 같은 check여도 기본 브랜치의 승인된 ci.yml이 바뀌어 출처가 더 이상 승인 버전이 아닌 상황.
    if (p === `repos/${repo}/contents/.github/workflows/ci.yml?ref=main`) return { sha: store.checkChange === 'main-workflow-updated' ? 'ci-updated' : 'ci-approved' };
    if (p === `repos/${repo}/contents/.github/workflows/ci.yml?ref=${store.head}`) return { sha: o.ciSource === 'changed' ? 'ci-changed' : 'ci-approved' };
    if (p === `repos/${repo}/branches/main/protection`) return protection;
    // 기본 브랜치의 판정 코드. o.code: 'same'(지금 실행 중인 파일과 같음), 'changed'(한 파일이 다름), 'missing'(기본 브랜치에 없음)
    for (const name of trustedModules) {
      if (p !== `repos/${repo}/contents/.github/scripts/${name}?ref=main`) continue;
      if (o.code === 'missing' && name === 'merge-pr-core.mjs') throw failure('Not Found', 404);
      const local = gitBlobSha(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'));
      return { sha: o.code === 'changed' && name === 'review-gate-core.mjs' ? '0'.repeat(40) : local };
    }
    if (p === `repos/${repo}/commits/${mergeSha}`) return { commit: { message: o.badSubject ? 'Merge pull request #1' : `${title}\n\nCloses #7` } };
    if (p === `repos/${repo}/git/ref/heads/${branch}`) {
      if (!store.remote.exists) throw failure('Not Found', 404);
      return { ref: `refs/heads/${branch}`, object: { sha: store.remote.sha } };
    }
    if (p === `repos/${repo}/branches/${branch}`) return { name: branch, protected: o.branchProtected };
    throw failure(`unexpected path ${path}`, 404);
  }

  function gh(args) {
    store.calls.push(['gh', ...args]);
    if (args[0] === 'pr' && args[1] === 'checks') {
      store.checksCalls += 1;
      // 점검과 병합 사이에 새 커밋이 push된 상황을 흉내 낸다.
      if (o.headChangeAtChecks === store.checksCalls) store.head = newHead;
      if (!o.prChecks) throw failure('required checks failed');
      return '';
    }
    if (args[0] === 'pr' && args[1] === 'merge') {
      const value = flag => args[args.indexOf(flag) + 1];
      if (!args.includes('--squash') || ['--admin', '--auto', '--delete-branch', '--merge', '--rebase'].some(flag => args.includes(flag))) throw failure('unexpected merge flags');
      // 마지막 확인과 병합 API 호출 사이 push(남는 경합)와 GitHub의 --match-head-commit 거부를 흉내 낸다.
      if (o.headChangeAtMerge) store.head = newHead;
      if (value('--match-head-commit') !== store.head) throw failure('head changed', 409);
      if (value('--subject') !== title || readFileSync(value('--body-file'), 'utf8') !== body) throw failure('message mismatch', 422);
      if (o.merge === 'fail') throw failure('merge failed', 405);
      store.merged = true;
      // 마지막 재확인 뒤 병합 API 처리 중 근거가 바뀐 상황(병합 후 감사 대상).
      if (o.commentChangeAtMerge) store.commentChange = o.commentChangeAtMerge;
      if (o.remoteAfterMerge === 'deleted') store.remote = { exists: false };
      if (o.remoteAfterMerge === 'moved') store.remote = { exists: true, sha: 'f'.repeat(40) };
      if (o.merge === 'fail-after-merge') throw failure('timeout', 502);
      return '';
    }
    if (args[0] !== 'api') throw failure('unexpected command');
    if (args[1] === 'graphql') return JSON.stringify({ data: { repository: { pullRequest: { lastEditedAt: o.lastEditedAt, timelineItems: { nodes: [] } } } } });
    // 병합 도구는 댓글·API 쓰기를 하지 않는다. 쓰기 시도는 기록하고 실패시킨다.
    if (args.includes('-f') || args.includes('-X')) {
      store.posted.push(args.slice(1));
      throw failure('unexpected write');
    }
    return JSON.stringify(route(args[1]));
  }

  function git(args) {
    store.calls.push(['git', ...args]);
    if (!local.repo) throw new Error('not a git repository');
    const [command, ...rest] = args;
    const ref = `refs/heads/${branch}`;
    if (command === 'remote') return local.remotes ?? `origin\thttps://github.com/${repo}.git (fetch)\norigin\thttps://github.com/${repo}.git (push)\n`;
    if (command === 'rev-parse') {
      if (rest.at(-1) !== ref || !store.localSha) throw new Error('missing ref');
      return `${store.localSha}\n`;
    }
    if (command === 'symbolic-ref') return `${local.current}\n`;
    if (command === 'worktree') return `worktree /repo\nHEAD ${head}\nbranch refs/heads/${local.current}\n\n${local.otherWorktree ? `worktree /other\nHEAD ${head}\nbranch ${ref}\n` : ''}`;
    if (command === 'status') return local.dirty ? ' M src/App.tsx\n' : '';
    if (command === 'update-ref') {
      if (rest[0] !== '-d' || rest[1] !== ref || rest[2] !== store.localSha) throw new Error('ref changed');
      store.localSha = null;
      return '';
    }
    if (command === 'config') return '';
    if (command === 'push') {
      if (rest[0] !== `--force-with-lease=${ref}:${head}` || !['origin', 'upstream'].includes(rest[1]) || rest[2] !== `:${ref}`) throw new Error('unexpected push');
      if (!store.remote.exists || store.remote.sha !== head) throw new Error('stale info');
      store.remote = { exists: false };
      return '';
    }
    throw new Error('unexpected git command');
  }

  return { gh, git, store };
}

// 실제 상태를 바꾸는 호출. dry-run과 차단 상황에서는 하나도 없어야 한다.
export const sideEffects = calls => calls.filter(([tool, ...args]) => tool === 'gh'
  ? (args[0] === 'pr' && args[1] === 'merge') || (args[0] === 'api' && args[1] !== 'graphql' && (args.includes('-f') || args.includes('-X')))
  : ['push', 'update-ref', 'branch'].includes(args[0]) || (args[0] === 'config' && args.includes('--remove-section')));

// Linux CLI 테스트의 가짜 실행 파일 진입점. 프로세스마다 상태를 파일에 보관한다.
export function cliMain(tool, args) {
  const file = process.env.MERGE_FAKE_STORE;
  const store = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const fake = createFake(JSON.parse(process.env.MERGE_FAKE_OPTIONS ?? '{}'), store);
  try {
    process.stdout.write(fake[tool](args));
    return 0;
  } catch (error) {
    process.stderr.write(String(error.stderr ?? error.message));
    return 1;
  } finally {
    writeFileSync(file, JSON.stringify(store));
  }
}

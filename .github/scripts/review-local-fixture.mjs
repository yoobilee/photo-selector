import { readFileSync } from 'node:fs';
import { createFake, repo } from './merge-pr-fixture.mjs';
import { createEvidenceGitHub } from './review-evidence-cli.mjs';
import { collectReviewPacket, publishEvidence, prepareLocalConfirmation } from './review-evidence.mjs';
import { evidenceWorkflow, receiptName } from './review-evidence-source.mjs';
import { reportHash } from './review-gate-core.mjs';
import { gitBlobSha } from './merge-pr-core.mjs';

export function localFixture() {
  const fake = createFake({ risk: 'high', implementedBy: 'claude', gate: false, approval: 'none', codex: 'none', requests: 0 });
  const comments = []; const artifacts = []; const dispatches = [];
  // ref별 게시 코드 버전을 지정한다. 지정한 경로의 ref가 누락되면 SHA도 누락되어 fail-closed로 검증된다.
  const codeVersions = new Map();
  const mergedCodeVersions = new Map();
  const contentRequests = [];
  const codeSha = (path, ref, fallback) => {
    contentRequests.push({ path, ref });
    const versions = fake.store.merged && mergedCodeVersions.has(path) ? mergedCodeVersions : codeVersions;
    return versions.has(path) ? versions.get(path).get(ref) : fallback;
  };
  const gh = args => {
    if (args[0] === 'workflow') { dispatches.push(JSON.parse(readFileSync(args.at(-1).slice('request=@'.length), 'utf8'))); return ''; }
    if (args[0] !== 'api') return fake.gh(args);
    if (args[1] === `repos/${repo}/actions/runs/44`) return JSON.stringify(run);
    if (args[1] === `repos/${repo}/actions/workflows/review-evidence.yml`) return JSON.stringify({ id: 9, path: evidenceWorkflow });
    if (args[1].startsWith(`repos/${repo}/actions/runs/44/artifacts`)) return JSON.stringify([{ artifacts }]);
    if (args[1].startsWith(`repos/${repo}/contents/.github/scripts/`)) {
      const url = new URL(args[1], 'https://api.github.com/');
      const name = url.pathname.split('/scripts/')[1];
      return JSON.stringify({ sha: codeSha(`.github/scripts/${name}`, url.searchParams.get('ref'), gitBlobSha(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'))) });
    }
    if (args[1].startsWith(`repos/${repo}/contents/${evidenceWorkflow}`)) return JSON.stringify({ sha: codeSha(evidenceWorkflow, new URL(args[1], 'https://api.github.com/').searchParams.get('ref'), 'c'.repeat(40)) });
    const policy = args[1].includes('/contents/.ai/review-config.json');
    const value = JSON.parse(fake.gh(policy ? ['api', `repos/${repo}/contents/.ai/review-config.json?ref=main`] : args));
    if (args[1] === `repos/${repo}`) { value.full_name = repo; value.id = 12; }
    if (policy) value.sha = fake.store.merged && args[1].endsWith('ref=main') ? 'a'.repeat(40) : 'f'.repeat(40);
    if (args[1].includes('/check-runs') && fake.store.localEvidenceDigest) for (const page of value) {
      for (const check of page.check_runs.filter(c => c.name === 'independent-review')) {
        check.conclusion = 'success'; const proof = JSON.parse(check.external_id); proof.evidenceDigest = fake.store.localEvidenceDigest; check.external_id = JSON.stringify(proof);
      }
    }
    if (args[1] === `repos/${repo}/pulls/1`) value.comments += comments.length;
    if (args[1].startsWith(`repos/${repo}/issues/1/comments?`)) value.at(-1).push(...structuredClone(comments));
    return JSON.stringify(value);
  };
  const github = createEvidenceGitHub(gh, repo);
  const context = { repo: { owner: 'owner', repo: 'repo' }, eventName: 'workflow_dispatch', ref: 'refs/heads/main', sha: 'd'.repeat(40), runId: 44, runAttempt: 1, requestedNumber: '1' };
  const run = { id: 44, workflow_id: 9, path: evidenceWorkflow, event: 'workflow_dispatch', run_attempt: 1, head_sha: context.sha,
    head_branch: 'main', status: 'in_progress', conclusion: null, repository: { id: 12, full_name: repo }, head_repository: { id: 12, full_name: repo },
    actor: { id: 1, login: 'owner', type: 'User' }, run_started_at: '2026-11-10T00:00:00Z', updated_at: '2026-11-10T00:02:00Z' };
  github.rest.actions = { getWorkflowRun: async () => ({ data: run }), getWorkflow: async () => ({ data: { id: 9, path: evidenceWorkflow } }),
    listWorkflowRunArtifacts: async () => ({ data: artifacts }) };
  const original = github.rest.repos.getContent;
  github.rest.repos.getContent = args => args.path.startsWith('.github/') ? { data: { sha: codeSha(args.path, args.ref, 'c'.repeat(40)) } } : original(args);
  github.rest.issues.createComment = async ({ body }) => {
    const comment = { id: 200 + comments.length, user: { id: 41898282, login: 'github-actions[bot]', type: 'Bot' },
      performed_via_github_app: { id: 15368 }, created_at: '2026-11-10T00:01:00Z', updated_at: '2026-11-10T00:01:00Z', body,
      html_url: `https://github.com/${repo}/pull/1#issuecomment-${200 + comments.length}` };
    comments.push(comment); return { data: structuredClone(comment) };
  };
  const collect = () => collectReviewPacket({ github, repository: repo, number: 1 });
  const result = async () => {
    const { packet } = await collect();
    const report = 'No actionable defects were found. Lint passed. Build and E2E were not run.';
    return { v: 2, target: packet.target, role: 'independent', reviewer: 'codex', status: 'completed', reviewComplete: true,
      findings: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }, report,
      source: { kind: 'codex-plugin', sessionId: 'session-1', jobId: 'job-1', threadId: 'thread-1', turnId: 'turn-1',
        startedAt: '2026-11-09T00:00:00Z', completedAt: '2026-11-09T00:01:00Z', outputHash: reportHash(report) },
      checks: [{ name: 'Lint', status: 'passed', evidence: '리뷰어 원문의 주장, 실행 인증 아님' }], notRun: ['Build and E2E were not run.'] };
  };
  const request = async result => ({ v: 1, target: result.target, collectionHash: (await collect()).packet.collectionHash, result });
  const publish = async result => publishEvidence({ github, context, request: await request(result) });
  const finish = published => {
    run.status = 'completed'; run.conclusion = 'success';
    artifacts.push({ id: 55, name: receiptName(published.commentId, published.evidenceHash), expired: false, digest: `sha256:${'a'.repeat(64)}`,
      workflow_run: { id: run.id, head_sha: run.head_sha, head_branch: 'main', repository_id: 12, head_repository_id: 12 } });
  };
  const confirm = () => prepareLocalConfirmation({ github, repository: repo, number: 1 });
  const addConfirmation = confirmation => comments.push({ id: 300, user: { id: 1, login: 'owner', type: 'User' },
    created_at: '2026-11-10T00:03:00Z', updated_at: '2026-11-10T00:03:00Z', body: `/review-gate\n\`\`\`json\n${JSON.stringify(confirmation)}\n\`\`\`` });
  return { fake, gh, github, run, context, comments, artifacts, dispatches, codeVersions, mergedCodeVersions, contentRequests, collect, result, request, publish, finish, confirm, addConfirmation };
}

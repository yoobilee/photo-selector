import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFake, repo, head } from './merge-pr-fixture.mjs';
import { isReportBody } from './review-gate-core.mjs';
import { collectReviewPacket, reportRequest, renderEvidenceReport, publishEvidence, evidenceWorkflow } from './review-evidence.mjs';
import { createEvidenceGitHub, parseEvidenceArgs, runEvidenceCli } from './review-evidence-cli.mjs';

const clone = value => structuredClone(value);
const bot = { id: 41898282, login: 'github-actions[bot]', type: 'Bot' };
function fixture(options = {}) {
  const fake = createFake({ risk: 'high', implementedBy: 'codex', gate: false, approval: 'none', codex: 'none', ...options });
  const added = [];
  const dispatches = [];
  const gh = args => {
    if (args[0] === 'workflow') {
      const path = args.at(-1).slice('request=@'.length);
      dispatches.push({ args, input: JSON.parse(readFileSync(path, 'utf8')) });
      return '';
    }
    const data = JSON.parse(fake.gh(args));
    if (args[1] === `repos/${repo}`) data.full_name = repo;
    if (args[1]?.includes('/contents/.ai/review-config.json')) data.sha = 'f'.repeat(40);
    if (args[1] === `repos/${repo}/pulls/1`) data.comments += added.length;
    if (args[1]?.startsWith(`repos/${repo}/issues/1/comments?`)) data.at(-1).push(...clone(added));
    return JSON.stringify(data);
  };
  const github = createEvidenceGitHub(gh, repo);
  const context = { repo: { owner: 'owner', repo: 'repo' }, eventName: 'workflow_dispatch', ref: 'refs/heads/main',
    sha: 'd'.repeat(40), runId: 44, runAttempt: 1, requestedNumber: '1' };
  const run = { id: 44, workflow_id: 9, path: evidenceWorkflow, head_sha: context.sha, head_branch: 'main', event: 'workflow_dispatch',
    run_attempt: 1, status: 'in_progress', conclusion: null, repository: { full_name: repo }, head_repository: { full_name: repo },
    actor: { id: 1, login: 'owner', type: 'User' }, triggering_actor: { id: 1, login: 'owner', type: 'User' } };
  github.rest.actions = { getWorkflowRun: async () => ({ data: run }), getWorkflow: async () => ({ data: { id: 9, path: evidenceWorkflow } }) };
  const getContent = github.rest.repos.getContent;
  github.rest.repos.getContent = async args => args.path === evidenceWorkflow ? { data: { sha: 'c'.repeat(40) } } : getContent(args);
  github.rest.issues.createComment = async ({ body, issue_number }) => {
    assert.equal(issue_number, 1);
    const comment = { id: 200 + added.length, user: bot, performed_via_github_app: { id: 15368 }, body,
      created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z' };
    added.push(comment);
    return { data: clone(comment) };
  };
  const collect = result => collectReviewPacket({ github, repository: repo, number: 1, result });
  return { fake, gh, github, context, run, added, dispatches, collect };
}

function localResult(target, changes = {}) {
  return { v: 1, target: clone(target), role: 'independent', reviewer: 'claude', status: 'completed', reviewComplete: true,
    findings: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }, report: '독립 세션에서 코드·실패·권한 경계를 검토했습니다.',
    source: { kind: 'local-session', sessionId: 'session-1' }, ...changes };
}

test('읽기 전용 수집은 원격 SHA·fingerprint·digest·실제 기존 게이트를 계산하고 승인하지 않음', async () => {
  const subject = fixture();
  const { packet } = await subject.collect();
  assert.equal(packet.target.head, head);
  for (const digest of [packet.target.fingerprint, packet.collectionHash, packet.gateEvidenceDigest]) assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(packet.review.state, 'missing');
  assert.equal(packet.gate.state, 'failure');
  assert.equal(packet.humanConfirmationRequired, true);
  assert.equal(packet.mergeAuthorized, false);
  assert.deepEqual(subject.added, []);
  assert.deepEqual(subject.dispatches, []);
});

test('Codex 자체 리뷰와 Claude 독립 검증을 구분하며 0건 로컬 결과도 관리자 확인을 대체하지 않음', async () => {
  const subject = fixture();
  const { packet: initial } = await subject.collect();
  const independent = await subject.collect(localResult(initial.target));
  assert.equal(independent.packet.review.state, 'unverified-local-result');
  assert.equal(independent.packet.review.provenance, 'unverified-local-session');
  assert.match(renderEvidenceReport(independent.packet).body, /^# 미인증 로컬 독립 리뷰 자료/);
  assert.equal(isReportBody(renderEvidenceReport(independent.packet).body), false);
  assert.equal(independent.packet.result.authentication, 'unverified-local-session');
  assert.equal(independent.packet.gate.state, 'failure');
  const self = await subject.collect(localResult(initial.target, { role: 'self', reviewer: 'codex' }));
  assert.equal(self.packet.review.state, 'self-only');
  assert.match(renderEvidenceReport(self.packet).body, /^# 미인증 로컬 자체 리뷰 자료/);
  await assert.rejects(subject.collect(localResult(initial.target, { reviewer: 'codex' })), /역할 불일치/);
});

test('미완료·스킵·실패·한도와 모든 차단/unknown 지적은 확인 준비 완료가 아님', async () => {
  const subject = fixture();
  const { packet } = await subject.collect();
  for (const status of ['running', 'skipped', 'failed', 'limit']) {
    const result = localResult(packet.target, { status, reviewComplete: false });
    assert.equal((await subject.collect(result)).packet.review.state, 'incomplete');
  }
  for (const severity of ['critical', 'high', 'medium', 'unknown']) {
    const result = localResult(packet.target);
    result.findings[severity] = 1;
    assert.equal((await subject.collect(result)).packet.review.state, 'blocked');
  }
});

test('로컬 결과의 값 누락·오래된 SHA/base/fingerprint·위조 출처·잘못된 집계는 거부', async () => {
  const subject = fixture();
  const { packet } = await subject.collect();
  for (const change of [
    result => { result.target.head = 'a'.repeat(40); }, result => { result.target.base = 'a'.repeat(40); },
    result => { result.target.fingerprint = 'a'.repeat(64); }, result => { result.target.policySha = 'a'.repeat(40); },
    result => { result.target.repository = 'other/repo'; }, result => { result.target.number = 2; },
    result => { delete result.reviewComplete; }, result => { result.reviewComplete = false; },
    result => { result.source.kind = 'github'; }, result => { result.source.sessionId = ''; },
    result => { result.findings.unknown = 1.5; }, result => { delete result.findings.medium; },
    result => { result.findings.high = -1; }, result => { result.findings.low = '0'; },
    result => { result.report = ''; }, result => { result.report = 'x'.repeat(20_001); },
    result => { result.approved = true; }, result => { result.status = 'unknown'; },
  ]) {
    const result = localResult(packet.target); change(result);
    await assert.rejects(subject.collect(result));
  }
  await assert.rejects(subject.collect(false));
  await assert.rejects(subject.collect(0));
  assert.deepEqual(subject.added, []);
});

test('Claude 구현의 신뢰할 Codex GitHub 결과를 자동 수집하고 위장/이전 HEAD/스킵은 완료로 보지 않음', async () => {
  const valid = fixture({ implementedBy: 'claude', codex: 'clean' });
  const { packet } = await valid.collect();
  assert.equal(packet.result.authentication, 'trusted-bot-api');
  assert.equal(packet.review.state, 'awaiting-human-confirmation');
  for (const codex of ['spoof', 'stale', 'running', 'limit', 'none']) {
    const { packet: invalid } = await fixture({ implementedBy: 'claude', codex }).collect();
    assert.equal(invalid.review.state, 'missing', codex);
    assert.equal(invalid.gate.state, 'failure', codex);
  }
  const finding = await fixture({ implementedBy: 'claude', codex: 'findings' }).collect();
  assert.equal(finding.packet.review.state, 'blocked');
});

test('기존에 관리자가 확인한 보고서는 새 승인을 만들지 않고 수집하며 unknown 지적을 지우지 않음', async () => {
  const subject = fixture({ implementedBy: 'claude', gate: true });
  const { packet } = await subject.collect();
  assert.equal(packet.result.authentication, 'legacy-gate-verified');
  assert.equal(packet.result.source.reportCommentId, 10);
  assert.equal(packet.humanConfirmationRequired, false);
  assert.equal(packet.gate.kind, 'policy-reevaluation');
  assert.equal(packet.gate.publishedSourceVerified, false);
  assert.equal(packet.mergeAuthorized, false);
  assert.deepEqual(subject.added, []);
  const get = subject.github.rest.issues.listComments;
  subject.github.rest.issues.listComments = async args => {
    const response = await get(args);
    const confirmation = response.data.find(comment => comment.id === 11);
    const value = JSON.parse(confirmation.body.match(/```json\n([\s\S]*?)\n```/)[1]);
    value.findings.unknown = 1;
    confirmation.body = `/review-gate\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
    return response;
  };
  assert.equal((await subject.collect()).packet.review.state, 'blocked');
});

test('전체 페이지 adapter로 100건이 넘는 댓글을 수집하고 누락된 페이지는 거부', async () => {
  const subject = fixture();
  for (let index = 0; index < 102; index += 1) subject.added.push({ id: 1000 + index,
    user: { id: 3, login: 'reader', type: 'User' }, body: `comment ${index}` });
  let omit = false;
  const gh = args => {
    const output = subject.gh(args);
    if (!args[1]?.startsWith(`repos/${repo}/issues/1/comments?`)) return output;
    assert.ok(args.includes('--paginate'));
    assert.ok(args.includes('--slurp'));
    const all = JSON.parse(output).flat();
    return JSON.stringify(omit ? [all.slice(0, 100)] : [all.slice(0, 100), all.slice(100)]);
  };
  const github = createEvidenceGitHub(gh, repo);
  const { state } = await collectReviewPacket({ github, repository: repo, number: 1 });
  assert.equal(state.comments.length, 103);
  omit = true;
  await assert.rejects(collectReviewPacket({ github, repository: repo, number: 1 }), /전체 조회 실패/);
});

test('같은 댓글 수의 수정과 중복 ID, 등록된 보고서의 위조 앱·작성자는 통과 근거가 아님', async () => {
  const subject = fixture();
  subject.added.push({ id: 900, user: { id: 3, login: 'reader', type: 'User' }, body: 'before' });
  const get = subject.github.rest.issues.listComments;
  let count = 0;
  subject.github.rest.issues.listComments = async args => {
    if (++count === 2) subject.added[0].body = 'after';
    return get(args);
  };
  await assert.rejects(subject.collect(), /수집 중/);
  subject.github.rest.issues.listComments = async args => {
    const response = await get(args);
    response.data[1].id = response.data[0].id;
    return response;
  };
  await assert.rejects(subject.collect(), /중복 ID/);
  for (const change of [comment => { comment.user = { id: 1, login: 'owner', type: 'User' }; },
    comment => { comment.performed_via_github_app.id = 1; }]) {
    const spoof = fixture({ implementedBy: 'claude', codex: 'clean' });
    const initial = await spoof.collect();
    const request = reportRequest(initial.packet);
    await publishEvidence({ ...spoof, request });
    change(spoof.added[0]);
    await assert.rejects(publishEvidence({ ...spoof, request }), /근거 변경/);
    assert.equal((await spoof.collect()).packet.gate.state, 'failure');
    assert.equal(spoof.added.length, 1);
  }
});

test('수집 중 본문·HEAD·댓글 수정과 정책·검사·전체 조회 오류는 재시도 없이 거부', async () => {
  for (const options of [
    { prChangeAt: { at: '/issues/1/comments', nth: 2, change: { headSha: 'a'.repeat(40) } } },
    { prChangeAt: { at: '/issues/1/comments', nth: 2, change: { body: 'changed' } } },
    { commentChangeAt: { at: '/issues/1/comments', nth: 2, change: 'add-bot' } },
    { apiError: '/pulls/1/files' }, { apiError: '/pulls/1/reviews' }, { apiError: '/issues/1/comments' },
    { apiError: '/pulls/1/comments' }, { apiError: '/check-runs' }, { apiError: '/contents/.ai/review-config.json' },
  ]) await assert.rejects(fixture(options).collect());
  for (const kind of ['missing', 'duplicate', 'policy', 'checks', 'review-body']) {
    const subject = fixture();
    if (kind === 'policy') {
      const get = subject.github.rest.repos.getContent;
      let count = 0;
      subject.github.rest.repos.getContent = async args => {
        const response = await get(args); response.data.sha = (++count === 1 ? 'a' : 'b').repeat(40); return response;
      };
    } else if (kind === 'checks') {
      const get = subject.github.rest.checks.listForRef;
      let count = 0;
      subject.github.rest.checks.listForRef = async args => {
        const response = await get(args); if (++count === 2) response.data[1].conclusion = 'failure'; return response;
      };
    } else {
      const get = subject.github.rest.issues.listComments;
      subject.github.rest.issues.listComments = async args => {
        const response = await get(args);
        if (kind === 'missing') response.data = [{ id: 99 }];
        else if (kind === 'duplicate') response.data = [{ id: 99 }, { id: 99 }];
        else response.data = [];
        return response;
      };
    }
    await assert.rejects(subject.collect(), undefined, kind);
    assert.deepEqual(subject.added, []);
  }
});

test('등록은 봇 보고서 1개만 쓰고 중복 재사용하며 기존 게이트는 계속 관리자 확인을 요구', async () => {
  const subject = fixture({ implementedBy: 'claude', codex: 'clean' });
  const { packet } = await subject.collect();
  const request = reportRequest(packet);
  const first = await publishEvidence({ ...subject, request });
  assert.equal(first.approved, false);
  assert.match(first.evidenceHash, /^[a-f0-9]{64}$/);
  assert.equal(subject.added.length, 1);
  const again = await publishEvidence({ ...subject, request });
  assert.equal(again.reused, true);
  assert.equal(again.commentId, first.commentId);
  assert.equal(subject.added.length, 1);
  assert.equal((await subject.collect()).packet.gate.state, 'failure');
  assert.doesNotMatch(subject.added[0].body, /^\/(review-gate|merge-approve)/);
});

test('다른 workflow·ref·실행 ID/attempt·저장소와 오래된 요청은 댓글 작성 전 차단', async () => {
  for (const change of [
    subject => { subject.context.ref = 'refs/heads/feature/untrusted'; },
    subject => { subject.context.requestedNumber = '2'; }, subject => { subject.context.requestedNumber = ''; },
    subject => { subject.context.requestedNumber = '01'; }, subject => { subject.context.requestedNumber = 1; },
    subject => { subject.context.runAttempt = 2; }, subject => { subject.context.eventName = 'pull_request_target'; },
    subject => { subject.run.id = 45; }, subject => { subject.run.workflow_id = 10; },
    subject => { subject.run.head_sha = 'e'.repeat(40); }, subject => { subject.run.repository.full_name = 'other/repo'; },
    subject => { subject.run.head_repository.full_name = 'other/repo'; }, subject => { subject.run.path = '.github/workflows/other.yml'; },
    subject => { subject.run.status = 'completed'; }, subject => { subject.run.conclusion = 'failure'; },
    subject => { subject.run.triggering_actor = { id: 3, login: 'reader', type: 'User' }; },
    subject => { delete subject.run.actor; delete subject.run.triggering_actor; },
  ]) {
    const subject = fixture({ implementedBy: 'claude', codex: 'clean' });
    const { packet } = await subject.collect();
    const request = reportRequest(packet);
    change(subject);
    await assert.rejects(publishEvidence({ ...subject, request }));
    assert.deepEqual(subject.added, []);
  }
  const subject = fixture();
  const { packet } = await subject.collect();
  const request = reportRequest(packet);
  request.collectionHash = 'a'.repeat(64);
  await assert.rejects(publishEvidence({ ...subject, request }), /근거 변경/);
  assert.deepEqual(subject.added, []);
  const denied = fixture();
  const { packet: deniedPacket } = await denied.collect();
  denied.github.rest.repos.getCollaboratorPermissionLevel = async () => ({ data: { permission: 'read' } });
  await assert.rejects(publishEvidence({ ...denied, request: reportRequest(deniedPacket) }), /등록 요청자 쓰기 권한 없음/);
  assert.deepEqual(denied.added, []);
});

test('게시 성공 후 응답 실패는 자동 재시도하지 않고 다음 실행에서 실제 댓글을 복구', async () => {
  const subject = fixture({ implementedBy: 'claude', codex: 'clean' });
  const { packet } = await subject.collect();
  const request = reportRequest(packet);
  const create = subject.github.rest.issues.createComment;
  subject.github.rest.issues.createComment = async args => { await create(args); throw new Error('uncertain response'); };
  await assert.rejects(publishEvidence({ ...subject, request }), /uncertain/);
  assert.equal(subject.added.length, 1);
  const recovered = await publishEvidence({ ...subject, request });
  assert.equal(recovered.reused, true);
  assert.equal(subject.added.length, 1);
  subject.added[0].body += ' changed';
  await assert.rejects(publishEvidence({ ...subject, request }), /근거 변경/);
});

test('CLI 기본값은 읽기 전용이고 dispatch도 고정된 기본 브랜치 workflow만 요청', async () => {
  const subject = fixture({ implementedBy: 'claude', codex: 'clean' });
  const output = [];
  const args = ['owner/repo', '1'];
  assert.equal(await runEvidenceCli({ argv: args, gh: subject.gh, out: text => output.push(text) }), 0);
  assert.deepEqual(subject.dispatches, []);
  const gh = call => {
    if (call[0] === 'api' && call[1]?.includes(`/contents/${evidenceWorkflow}`)) return JSON.stringify({ sha: 'c'.repeat(40) });
    return subject.gh(call);
  };
  assert.equal(await runEvidenceCli({ argv: [...args, '--dispatch'], gh, out: () => {} }), 0);
  assert.equal(subject.dispatches.length, 1);
  assert.deepEqual(subject.dispatches[0].args.slice(0, 7), ['workflow', 'run', 'review-evidence.yml', '--repo', 'owner/repo', '--ref', 'main']);
  assert.ok(subject.dispatches[0].args.includes('pr_number=1'));
  assert.equal(subject.dispatches[0].input.result, null);
  assert.deepEqual(subject.added, []);
  for (const flag of ['--approve', '--publish-as-admin', '--merge', '--ref', '--token']) assert.equal(parseEvidenceArgs([...args, flag]), null);
  assert.equal(parseEvidenceArgs([...args, '--dispatch', '--dispatch']), null);
});

test('CLI 실패는 원시 오류·결과 파일을 출력하지 않고 workflow 요청을 재시도하지 않음', async () => {
  const errors = [];
  const subject = fixture({ apiError: '/issues/1/comments' });
  assert.equal(await runEvidenceCli({ argv: ['owner/repo', '1'], gh: subject.gh, err: text => errors.push(text) }), 1);
  assert.doesNotMatch(errors.join('\n'), /server error|HTTP 500/);
  assert.deepEqual(subject.dispatches, []);
  for (const value of ['null', 'false', '0', '[]']) {
    const existing = fixture({ implementedBy: 'claude', gate: true });
    assert.equal(await runEvidenceCli({ argv: ['owner/repo', '1', '--result', 'result.json'], gh: existing.gh,
      readFile: () => value, err: () => {}, out: () => {} }), 1);
  }
});

test('출력 파일은 올바른 UTF-8 JSON으로 저장하고 기존 파일을 덮어쓰지 않음', async () => {
  const subject = fixture();
  const directory = mkdtempSync(join(tmpdir(), 'review-packet-test-'));
  const path = join(directory, '자료.json');
  try {
    const argv = ['owner/repo', '1', '--output', path];
    assert.equal(await runEvidenceCli({ argv, gh: subject.gh, out: () => {} }), 0);
    const text = readFileSync(path, 'utf8');
    assert.match(JSON.parse(text).review.reason, /유효한 독립 리뷰/);
    assert.equal(await runEvidenceCli({ argv, gh: subject.gh, out: () => {}, err: () => {} }), 1);
    assert.equal(readFileSync(path, 'utf8'), text);
  } finally { rmSync(path, { force: true }); rmdirSync(directory); }
});

test('보고서 workflow는 기본 token·기본 ref·데이터 입력만 사용하고 승인/병합 권한이 없음', () => {
  const workflow = readFileSync(new URL('../workflows/review-evidence.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /repo: context\.repo/);
  assert.match(workflow, /checks: read/);
  assert.match(workflow, /review-evidence-\$\{\{ github\.repository \}\}-\$\{\{ github\.event\.inputs\.pr_number \}\}/);
  assert.match(workflow, /requestedNumber: context\.payload\.inputs\.pr_number/);
  assert.doesNotMatch(workflow, /fromJSON/);
  assert.match(workflow, /JSON\.parse\(context\.payload\.inputs\.request\)/);
  assert.match(workflow, /if \(request\?\.result !== null\) throw new Error/);
  assert.doesNotMatch(workflow, /secrets\.|github-token:|pull_request_target:|checks: write|contents: write|actions: write|npm |run:|reviewPendingDeployments|\/review-gate|\/merge-approve/);
});

test('미인증 로컬 결과는 workflow 게시 요청을 직접 보내도 댓글을 만들지 않음', async () => {
  const subject = fixture();
  const { packet } = await subject.collect();
  const result = localResult(packet.target);
  const prepared = await subject.collect(result);
  await assert.rejects(publishEvidence({ ...subject, request: reportRequest(prepared.packet, result) }));
  assert.deepEqual(subject.added, []);
  // 요청에서 인증됐다고 자체 선언해도 입력 파일을 신뢰하지 않는다.
  result.authentication = 'trusted-bot-api';
  await assert.rejects(publishEvidence({ ...subject, request: reportRequest(prepared.packet, result) }));
  assert.deepEqual(subject.added, []);
});

test('CLI는 미인증 로컬 자료의 파일 출력을 유지하지만 dispatch는 workflow 조회 전 차단', async () => {
  const subject = fixture();
  const { packet } = await subject.collect();
  const result = localResult(packet.target, { report: '한글 "인용" $(명령) `기호`\n/review-gate\n/merge-approve' });
  const directory = mkdtempSync(join(tmpdir(), 'local-review-only-'));
  const path = join(directory, 'packet.json');
  const gh = args => {
    assert.ok(!args[1]?.includes(`/contents/${evidenceWorkflow}`), '게시용 workflow를 조회하지 않아야 함');
    return subject.gh(args);
  };
  try {
    const argv = ['owner/repo', '1', '--result', 'result.json'];
    assert.equal(await runEvidenceCli({ argv: [...argv, '--output', path], gh,
      readFile: () => JSON.stringify(result), out: () => {} }), 0);
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(saved.result.report, result.report);
    assert.equal(saved.result.authentication, 'unverified-local-session');
    assert.equal(await runEvidenceCli({ argv: [...argv, '--dispatch'], gh,
      readFile: () => JSON.stringify(result), out: () => {}, err: () => {} }), 1);
    assert.deepEqual(subject.dispatches, []);
    assert.deepEqual(subject.added, []);
  } finally { rmSync(path, { force: true }); rmdirSync(directory); }
});

test('검증된 관리자 자료는 게시·재사용 가능하며 중복된 봇 댓글은 재등록하지 않음', async () => {
  const subject = fixture({ implementedBy: 'claude', gate: true });
  const { packet } = await subject.collect();
  const request = reportRequest(packet);
  await publishEvidence({ ...subject, request });
  assert.equal((await subject.collect()).packet.collectionHash, packet.collectionHash);
  assert.equal((await publishEvidence({ ...subject, request })).reused, true);
  subject.added.push({ ...clone(subject.added[0]), id: 201 });
  await assert.rejects(publishEvidence({ ...subject, request }), /등록 자료 불일치/);
  assert.equal(subject.added.length, 2);
  assert.equal((await subject.collect()).packet.gate.state, 'success');
});

test('검증된 원본 근거가 없거나 이전 HEAD이면 빈 요청으로도 게시하지 않음', async () => {
  for (const codex of ['none', 'spoof', 'stale', 'running', 'limit']) {
    const subject = fixture({ implementedBy: 'claude', codex });
    const { packet } = await subject.collect();
    await assert.rejects(publishEvidence({ ...subject, request: reportRequest(packet) }), /검증된 리뷰 근거 없음/);
    assert.deepEqual(subject.added, []);
  }
});

test('같은 Actions 앱이어도 다른 PR 대상·자료·변조 본문은 collectionHash에서 제외하지 않음', async () => {
  for (const change of [
    packet => { packet.target.number = 2; },
    packet => { packet.target.repository = 'other/repo'; },
    packet => { packet.target.head = 'a'.repeat(40); },
    packet => { packet.target.base = 'a'.repeat(40); },
    packet => { packet.target.fingerprint = 'a'.repeat(64); },
    packet => { packet.target.policySha = 'a'.repeat(40); },
    packet => { packet.result.source.stateCommentId = 999; },
    packet => { packet.result.source.reviewIds = [999]; },
    packet => { packet.result.report += ' forged'; },
    packet => { packet.result.authentication = 'unverified-local-session'; },
  ]) {
    const subject = fixture({ implementedBy: 'claude', codex: 'clean' });
    const { packet } = await subject.collect();
    const different = clone(packet);
    change(different);
    subject.added.push({ id: 200, user: bot, performed_via_github_app: { id: 15368 }, body: renderEvidenceReport(different).body });
    assert.notEqual((await subject.collect()).packet.collectionHash, packet.collectionHash);
  }
});

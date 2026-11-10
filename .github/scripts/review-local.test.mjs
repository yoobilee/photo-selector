import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localFixture } from './review-local-fixture.mjs';
import { publishEvidence } from './review-evidence.mjs';
import { parseLocalReport, validatePluginResult, verifyLocalReport } from './review-evidence-source.mjs';
import { parsePluginArgs, collectPluginResult, findingsFromText, runPluginPublication } from './review-plugin-cli.mjs';

test('완료 결과 봇 게시·영수증·직접 관리자 확인을 구분하고 링크·hash·확인 내용을 생성', async () => {
  const f = localFixture(); const result = await f.result();
  const published = await f.publish(result);
  assert.equal(published.approved, false); assert.match(published.commentUrl, /issuecomment-200$/);
  assert.equal((await f.collect()).packet.gate.state, 'failure');
  await assert.rejects(f.confirm(), /실행 출처/);
  f.finish(published);
  const prepared = await f.confirm();
  assert.equal(prepared.evidenceHash, published.evidenceHash); assert.equal(prepared.provenance, 'unverified-local-session');
  assert.match(prepared.text, /^\/review-gate\n```json/);
  assert.equal((await f.collect()).packet.gate.state, 'failure');
  f.addConfirmation(prepared.confirmation);
  const evaluated = await f.collect();
  assert.equal(evaluated.packet.gate.state, 'success');
  assert.equal(evaluated.state.evaluation.evidence.record.report.provenance.artifactId, 55);
  assert.equal(evaluated.state.evaluation.evidence.record.approvals.length, 0);
});

test('같은 결과는 재사용하며 게시 성공 후 응답 불명확·영수증 없는 실행은 재게시하지 않음', async () => {
  const f = localFixture(); const result = await f.result();
  const published = await f.publish(result); f.finish(published);
  f.context.runId = 45;
  // 실행 전 검증용 현재 run을 새 실행으로 보이게 하고 원본 run 조회는 보존한다.
  const original = structuredClone(f.run);
  f.github.rest.actions.getWorkflowRun = async ({ run_id }) => ({ data: run_id === 44 ? original : { ...original, id: 45, status: 'in_progress', conclusion: null } });
  assert.equal((await f.publish(result)).reused, true); assert.equal(f.comments.length, 1);
  const uncertain = localFixture(); const r = await uncertain.result();
  const create = uncertain.github.rest.issues.createComment;
  uncertain.github.rest.issues.createComment = async args => { await create(args); throw new Error('uncertain'); };
  await assert.rejects(uncertain.publish(r), /uncertain/);
  await assert.rejects(uncertain.publish(r));
  assert.equal(uncertain.comments.length, 1);
});

test('실패·중단·실행중·한도·누락·출처 위조는 완료 보고서로 게시하지 않음', async () => {
  for (const change of [
    r => { r.status = 'running'; }, r => { r.status = 'failed'; }, r => { r.status = 'interrupted'; }, r => { r.status = 'limit'; },
    r => { r.reviewComplete = false; }, r => { r.authentication = 'trusted-bot-api'; }, r => { delete r.notRun; },
    r => { r.source.outputHash = '0'.repeat(64); }, r => { r.reviewer = 'claude'; }, r => { r.role = 'self'; },
  ]) {
    const f = localFixture(); const r = await f.result(); change(r);
    await assert.rejects(f.publish(r)); assert.equal(f.comments.length, 0);
  }
});

test('head·base·본문·fingerprint·정책·다른 PR 결과는 게시 전 거부', async () => {
  for (const change of [
    r => { r.target.head = 'e'.repeat(40); }, r => { r.target.base = 'a'.repeat(40); }, r => { r.target.fingerprint = '0'.repeat(64); },
    r => { r.target.number = 2; }, r => { r.target.repository = 'other/repo'; }, r => { r.target.policySha = 'a'.repeat(40); },
  ]) { const f = localFixture(); const r = await f.result(); change(r); await assert.rejects(f.publish(r)); assert.equal(f.comments.length, 0); }
  for (const change of [{ body: '<!-- ai-review\nimplemented-by: claude\nrisk: high\nsensitive-change: yes\n-->\nchanged' }, { baseSha: 'a'.repeat(40) }]) {
    const f = localFixture(); const r = await f.result(); f.fake.store.prChange = change;
    await assert.rejects(f.publish(r)); assert.equal(f.comments.length, 0);
  }
});

test('위조 봇·댓글 변조·다른 workflow·run·수정·만료/누락/중복 영수증은 관리자 확인으로도 통과하지 않음', async () => {
  const mutations = [
    f => { f.comments[0].user.id = 9; }, f => { f.comments[0].user.type = 'User'; }, f => { f.comments[0].performed_via_github_app.id = 99; },
    f => { f.comments[0].body += 'changed'; }, f => { f.comments[0].updated_at = '2026-11-10T00:02:00Z'; },
    f => { f.run.workflow_id = 100; }, f => { f.run.event = 'pull_request'; }, f => { f.run.head_repository.full_name = 'other/repo'; },
    f => { f.run.run_attempt = 2; }, f => { f.run.conclusion = 'failure'; }, f => { f.run.head_sha = 'a'.repeat(40); f.artifacts[0].workflow_run.head_sha = 'x'; },
    f => { f.artifacts[0].expired = true; }, f => { f.artifacts[0].name += 'bad'; }, f => { f.artifacts.length = 0; },
    f => { f.artifacts.push(structuredClone(f.artifacts[0])); }, f => { f.artifacts[0].workflow_run.id = 99; },
    f => { f.artifacts[0].workflow_run.repository_id = 99; }, f => { f.artifacts[0].digest = null; },
    f => { const get = f.github.rest.repos.getContent; f.github.rest.repos.getContent = async args => ({ data: { ...(await get(args)).data, ...(args.ref === f.run.head_sha ? { sha: 'a'.repeat(40) } : {}) } }); },
  ];
  for (const change of mutations) {
    const f = localFixture(); const p = await f.publish(await f.result()); f.finish(p);
    const c = await f.confirm(); change(f); f.addConfirmation(c.confirmation);
    await assert.rejects(f.collect());
  }
});

test('관리자 확인 위장·지적 집계 축소와 출처 변경은 게이트·digest 경계에서 차단', async () => {
  const f = localFixture(); const p = await f.publish(await f.result()); f.finish(p);
  const c = await f.confirm(); f.addConfirmation(c.confirmation);
  const before = (await f.collect()).packet.gateEvidenceDigest;
  f.artifacts[0].id = 56;
  assert.notEqual((await f.collect()).packet.gateEvidenceDigest, before);
  f.comments[1].user = structuredClone(f.comments[0].user);
  assert.equal((await f.collect()).packet.gate.state, 'failure');
  const g = localFixture(); const r = await g.result(); r.findings.medium = 1;
  const pub = await g.publish(r); g.finish(pub);
  await assert.rejects(g.confirm(), /차단/);
  g.addConfirmation({ ...c.confirmation, evidenceHash: pub.evidenceHash });
  await assert.rejects(g.collect(), /불일치/);
});

test('게시 직전 마지막 PR 재조회에서 head가 바뀌면 댓글을 쓰지 않음', async () => {
  const f = localFixture(); const r = await f.result(); const request = await f.request(r);
  const get = f.github.rest.pulls.get; let reads = 0;
  f.github.rest.pulls.get = async args => { const response = await get(args); if (++reads === 7) response.data.head.sha = 'a'.repeat(40); return response; };
  await assert.rejects(publishEvidence({ github: f.github, context: f.context, request }));
  assert.equal(f.comments.length, 0);
});

function pluginFixture(target) {
  const output = { review: 'Review', threadId: 'thread-1', target: { mode: 'branch', baseRef: target.base }, codex: { status: 0, stdout: 'No actionable defects were found. Build and E2E were not run.' } };
  const job = { id: 'job-1', kind: 'review', status: 'completed', sessionId: 'session-1', threadId: 'thread-1', turnId: 'turn-1',
    createdAt: '2026-11-09T00:00:01Z', completedAt: '2026-11-09T00:01:00Z', result: output };
  return { output, stored: { job: { status: 'completed' }, storedJob: job } };
}

test('native 플러그인 완료 기록·동일 세션·출력·판정 형식을 검사하고 원문·미실행 한계를 보존', async () => {
  const target = (await localFixture().result()).target; const fixture = pluginFixture(target);
  const input = { ...fixture, target, session: 'session-1', startedAt: '2026-11-09T00:00:00Z', checks: [] };
  const result = collectPluginResult(input); validatePluginResult(result, target, 'claude');
  assert.equal(result.report, fixture.output.codex.stdout); assert.ok(result.notRun.length);
  assert.equal(findingsFromText('No actionable defects were found.').unknown, 0);
  assert.equal(findingsFromText('Looks good.').unknown, 1);
  assert.ok(findingsFromText('No findings. The review was skipped due to rate limit.').unknown > 0);
  assert.equal(findingsFromText('- [P2] bug').medium, 1);
  for (const change of [i => { i.stored.storedJob.status = 'running'; }, i => { i.stored.storedJob.status = 'failed'; },
    i => { i.stored.storedJob.status = 'cancelled'; }, i => { i.stored.storedJob.sessionId = 'other'; },
    i => { i.output.codex.status = 1; }, i => { i.output.codex.stdout = ''; }, i => { i.stored.storedJob.turnId = null; }]) {
    const bad = structuredClone(input); change(bad);
    assert.throws(() => validatePluginResult(collectPluginResult(bad), target, 'claude'));
  }
});

test('게시 wrapper는 같은 대상 완료 ledger를 재사용하고 실행 중 lock·미완료 ledger는 추가 리뷰하지 않음', async () => {
  const f = localFixture(); const r = await f.result(); const p = await f.publish(r); f.finish(p);
  const directory = mkdtempSync(join(tmpdir(), 'review-wrapper-test-')); const ledgerPath = join(directory, 'ledger.json');
  let calls = 0;
  const git = args => args[1] === '--git-path' ? ledgerPath : args.at(-1) === 'HEAD' ? r.target.head : r.target.base;
  const options = { repository: 'owner/repo', number: 1, session: 'session-1' };
  try {
    writeFileSync(ledgerPath, JSON.stringify({ state: 'completed', session: options.session, target: r.target, result: r }));
    const out = [];
    assert.equal(await runPluginPublication({ options, gh: f.gh, git, plugin: () => { calls++; }, out: t => out.push(t), maxPolls: 1 }), 0);
    assert.equal(JSON.parse(out[0]).state, 'published-awaiting-human');
    assert.equal(calls, 0); assert.equal(f.dispatches.length, 0);
    const ledger = JSON.parse(readFileSync(ledgerPath)); ledger.state = 'running'; writeFileSync(ledgerPath, JSON.stringify(ledger));
    await assert.rejects(runPluginPublication({ options, gh: f.gh, git, plugin: () => { calls++; }, maxPolls: 1 }), /미완료/);
    assert.equal(calls, 0);
    writeFileSync(ledgerPath + '.lock', '');
    await assert.rejects(runPluginPublication({ options, gh: f.gh, git, plugin: () => { calls++; } }));
    assert.equal(calls, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('wrapper 인수는 관리자 승인·토큰·ref 덮어쓰기·추가 리뷰 옵션을 받지 않음', () => {
  const args = ['owner/repo', '1', '--plugin-root', '/plugin', '--session', 'session-1'];
  assert.ok(parsePluginArgs(args, {}));
  for (const option of ['--approve', '--merge', '--token', '--ref', '--model', '--fresh']) assert.equal(parsePluginArgs([...args, option, 'value'], {}), null);
  assert.equal(parsePluginArgs(['owner/repo', '1', '--plugin-root', '/plugin'], {}), null);
  assert.throws(() => parseLocalReport('bad'));
});

test('동일 base SHA라도 기본 브랜치 밖으로 재지정한 봇 보고서는 근거가 아님', async () => {
  const f = localFixture(); const result = await f.result(); const published = await f.publish(result); f.finish(published);
  const pr = (await f.github.rest.pulls.get({ pull_number: 1 })).data;
  pr.base.ref = 'feature/other';
  await assert.rejects(verifyLocalReport({ github: f.github, repo: f.context.repo, pr, comment: f.comments[0], fingerprint: result.target.fingerprint }));
});

test('wrapper 정상 수집→dispatch→결과 확인, 응답 대기 재실행은 리뷰·요청을 반복하지 않음', async () => {
  const f = localFixture(); const { target } = await f.result();
  const directory = mkdtempSync(join(tmpdir(), 'review-flow-test-')); const path = join(directory, 'ledger.json');
  const git = args => args[1] === '--git-path' ? path : args.at(-1) === 'HEAD' ? target.head : target.base;
  const output = []; let reviews = 0;
  const data = pluginFixture(target);
  const options = { repository: 'owner/repo', number: 1, session: 'session-1' };
  const plugin = args => { if (args[0] === 'review') { reviews++; assert.ok(args.includes(target.base)); return data.output; } return data.stored; };
  const run = () => runPluginPublication({ options, gh: f.gh, git, plugin, maxPolls: 1, now: () => '2026-11-09T00:00:00Z', out: t => output.push(t) });
  try {
    await assert.rejects(run(), /완료를 확인하지 못함/);
    assert.equal(reviews, 1); assert.equal(f.dispatches.length, 1);
    await assert.rejects(run(), /완료를 확인하지 못함/);
    assert.equal(reviews, 1); assert.equal(f.dispatches.length, 1);
    const ledger = JSON.parse(readFileSync(path));
    const published = await f.publish(ledger.result); f.finish(published);
    assert.equal(await run(), 0);
    assert.equal(reviews, 1); assert.equal(f.dispatches.length, 1);
    assert.equal(JSON.parse(readFileSync(path)).publication.evidenceHash, published.evidenceHash);
    assert.equal(JSON.parse(output[0]).state, 'published-awaiting-human');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('wrapper 리뷰 완료 직후 원격 head 변경은 완료 결과·게시로 승격하지 않음', async () => {
  const f = localFixture(); const { target } = await f.result();
  const directory = mkdtempSync(join(tmpdir(), 'review-race-test-')); const path = join(directory, 'ledger.json');
  const git = args => args[1] === '--git-path' ? path : args.at(-1) === 'HEAD' ? target.head : target.base;
  const data = pluginFixture(target);
  const plugin = args => { if (args[0] === 'review') { f.fake.store.head = 'e'.repeat(40); return data.output; } return data.stored; };
  try {
    await assert.rejects(runPluginPublication({ options: { repository: 'owner/repo', number: 1, session: 'session-1' }, gh: f.gh, git, plugin,
      now: () => '2026-11-09T00:00:00Z', maxPolls: 1 }), /대상 변경/);
    assert.equal(f.comments.length, 0); assert.equal(f.dispatches.length, 0);
    assert.equal(JSON.parse(readFileSync(path)).state, 'running');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('로컬 ledger가 없는 다른 checkout도 이미 등록된 원격 결과를 확인하고 리뷰를 다시 실행하지 않음', async () => {
  const f = localFixture(); const result = await f.result(); const published = await f.publish(result); f.finish(published);
  const directory = mkdtempSync(join(tmpdir(), 'review-remote-test-')); const path = join(directory, 'ledger.json');
  let reviews = 0;
  try {
    const git = args => args[1] === '--git-path' ? path : args.at(-1) === 'HEAD' ? result.target.head : result.target.base;
    assert.equal(await runPluginPublication({ options: { repository: 'owner/repo', number: 1, session: 'another-session' },
      gh: f.gh, git, plugin: () => { reviews++; }, maxPolls: 1, out: () => {} }), 0);
    assert.equal(reviews, 0); assert.equal(f.dispatches.length, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

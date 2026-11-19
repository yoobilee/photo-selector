import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localFixture, pr23Report, pr28Report } from './review-local-fixture.mjs';
import { analyzeReviewText } from './review-result-parser.mjs';
import { reportHash, sha256 } from './review-gate-core.mjs';
import { publishEvidence } from './review-evidence.mjs';
import { parseLocalReport, renderLocalReport, validatePluginResult, verifyLocalReport, publicationModules, evidenceWorkflow } from './review-evidence-source.mjs';
import { assessMerge, runMergeTool } from './merge-pr-core.mjs';
import { parsePluginArgs, collectPluginResult, findingsFromText, runPluginPublication, pluginPublicationFailureMessage } from './review-plugin-cli.mjs';

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

test('CLI 중단 안내는 요청 전·불명확·충돌을 구분하고 원시 오류를 출력하지 않음', () => {
  for (const [code, pattern] of [
    ['review-publication-preflight', /동일한 검토 대상.*같은 명령을 직접 재실행.*대상이 바뀌면 기존 결과를 재사용하지 않습니다/],
    ['review-publication-uncertain', /불명확.*자동 재요청하지 않습니다/],
    ['review-publication-conflict', /게시 결과 충돌/],
    ['review-report-too-large', /16000바이트/],
    ['unexpected', /원시 오류는 출력하지 않습니다/],
    ['toString', /원시 오류는 출력하지 않습니다/],
  ]) {
    const text = pluginPublicationFailureMessage({ code, message: 'private API response' });
    assert.match(text, pattern); assert.doesNotMatch(text, /private API response/);
  }
});

function pluginFixture(target) {
  const output = { review: 'Review', threadId: 'thread-1', target: { mode: 'branch', baseRef: target.base }, codex: { status: 0, stdout: 'No actionable defects were found. Build and E2E were not run.' } };
  const job = { id: 'job-1', kind: 'review', status: 'completed', sessionId: 'session-1', threadId: 'thread-1', turnId: 'turn-1',
    createdAt: '2026-11-09T00:00:01Z', completedAt: '2026-11-09T00:01:00Z', result: output };
  return { output, stored: { job: { status: 'completed' }, storedJob: job } };
}

async function wrapperFixture(t, f = localFixture()) {
  const { target } = await f.result();
  const directory = mkdtempSync(join(tmpdir(), 'review-preflight-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'ledger.json');
  const data = pluginFixture(target);
  const calls = { reviews: 0, reads: 0, sleeps: 0 };
  const git = args => args[1] === '--git-path' ? path : args.at(-1) === 'HEAD' ? target.head : target.base;
  const plugin = args => {
    if (args[0] === 'review') { calls.reviews++; return data.output; }
    assert.deepEqual(args, ['result', '--json']); calls.reads++; return data.stored;
  };
  const options = { repository: 'owner/repo', number: 1, session: 'session-1' };
  const run = (overrides = {}) => runPluginPublication({ options, gh: f.gh, git, plugin,
    now: () => '2026-11-09T00:00:00Z', maxPolls: 3, sleep: async () => { calls.sleeps++; }, out: () => {}, ...overrides });
  return { f, path, target, data, calls, options, run };
}

test('CI 진행 중 완료 원문 보존 → 성공 후 모델 재호출 없이 한 번 게시·영수증 재사용', async t => {
  const w = await wrapperFixture(t); const { f, path, calls } = w;
  Object.assign(f.ci.check, { status: 'in_progress', conclusion: null });
  Object.assign(f.ci.run, { status: 'in_progress', conclusion: null });
  await assert.rejects(w.run(), error => {
    assert.match(error.message, /필수 CI/);
    assert.equal(error.code, 'review-publication-preflight');
    assert.match(pluginPublicationFailureMessage(error), /CI/);
    return true;
  });
  const completed = readFileSync(path, 'utf8'); const ledger = JSON.parse(completed);
  assert.equal(ledger.state, 'completed'); assert.equal(ledger.publicationRequested, undefined);
  assert.equal(ledger.result.report, w.data.output.codex.stdout);
  assert.equal(ledger.result.checks.find(c => c.name === 'GitHub check: verify').status, 'unknown');
  await assert.rejects(w.run(), /필수 CI/);
  assert.equal(readFileSync(path, 'utf8'), completed);
  assert.equal(calls.reviews, 1); assert.equal(f.dispatches.length, 0); assert.equal(f.comments.length, 0);
  Object.assign(f.ci.check, { status: 'completed', conclusion: 'success' });
  Object.assign(f.ci.run, { status: 'completed', conclusion: 'success' });
  await assert.rejects(w.run({ maxPolls: 1 }), /완료를 확인하지 못함/);
  const requested = JSON.parse(readFileSync(path));
  assert.deepEqual(requested.result, ledger.result); // Unknown check claims are never upgraded.
  assert.equal(f.dispatches.length, 1);
  const published = await f.publish(requested.result); f.finish(published);
  const evidence = JSON.stringify({ comments: f.comments, artifacts: f.artifacts });
  assert.equal(await w.run(), 0); assert.equal(await w.run(), 0);
  assert.equal(calls.reviews, 1); assert.equal(calls.reads, 1);
  assert.equal(f.dispatches.length, 1); assert.equal(f.comments.length, 1);
  assert.equal(JSON.stringify({ comments: f.comments, artifacts: f.artifacts }), evidence);
});

test('dispatch 준비 실패는 ledger 불변·재처리 가능, 실제 요청 응답 유실은 재요청 금지', async t => {
  const w = await wrapperFixture(t); const { f, path } = w;
  // Fail after result collection, while checking that the publisher exists on main.
  const unavailable = args => {
    if (args[0] === 'api' && args[1].includes('/contents/.github/workflows/review-evidence.yml')) throw new Error('unavailable');
    return f.gh(args);
  };
  await assert.rejects(w.run({ gh: unavailable }), error => {
    assert.equal(error.code, 'review-publication-preflight');
    assert.match(pluginPublicationFailureMessage(error), /같은 명령을 직접 재실행/);
    return true;
  });
  const completed = readFileSync(path, 'utf8');
  assert.equal(JSON.parse(completed).publicationRequested, undefined);
  await assert.rejects(w.run({ gh: unavailable }), /요청 전/);
  assert.equal(readFileSync(path, 'utf8'), completed);
  assert.equal(f.dispatches.length, 0);
  const uncertain = args => { const response = f.gh(args); if (args[0] === 'workflow') throw new Error('response lost'); return response; };
  await assert.rejects(w.run({ gh: uncertain }), error => {
    assert.equal(error.code, 'review-publication-uncertain');
    assert.match(pluginPublicationFailureMessage(error), /불명확.*자동 재요청하지 않습니다/);
    assert.doesNotMatch(pluginPublicationFailureMessage(error), /재실행할 수/);
    return true;
  });
  const requested = readFileSync(path, 'utf8');
  assert.equal(JSON.parse(requested).publicationRequested, true);
  await assert.rejects(w.run({ maxPolls: 1 }), /완료를 확인하지 못함/);
  assert.equal(readFileSync(path, 'utf8'), requested);
  assert.equal(w.calls.reviews, 1); assert.equal(f.dispatches.length, 1); assert.equal(f.comments.length, 0);
});

test('복구 파생 결과도 CI 대기 중 원본 ledger·원문을 보존하고 성공 뒤 한 번만 요청', async t => {
  const w = await wrapperFixture(t); const { f, data, path } = w;
  data.output.codex.stdout = observedReport;
  const result = collectPluginResult({ ...data, target: w.target, session: 'session-1', startedAt: '2026-11-09T00:00:00Z', checks: [] });
  result.findings.unknown = 1;
  const original = JSON.stringify({ state: 'completed', target: w.target, session: 'session-1', result });
  writeFileSync(path, original);
  Object.assign(f.ci.check, { status: 'in_progress', conclusion: null });
  const recover = () => w.run({ options: { ...w.options, recover: true }, maxPolls: 1 });
  await assert.rejects(recover(), /필수 CI/);
  const recovered = readFileSync(path + '.recovered.v3.json', 'utf8');
  assert.equal(JSON.parse(recovered).publicationRequested, undefined);
  await assert.rejects(recover(), /필수 CI/);
  assert.equal(readFileSync(path + '.recovered.v3.json', 'utf8'), recovered);
  Object.assign(f.ci.check, { status: 'completed', conclusion: 'success' });
  await assert.rejects(recover(), /완료를 확인하지 못함/);
  const p = await f.publish(JSON.parse(readFileSync(path + '.recovered.v3.json')).result); f.finish(p);
  assert.equal(await recover(), 0); assert.equal(await w.run(), 0);
  assert.equal(readFileSync(path, 'utf8'), original);
  assert.equal(w.calls.reviews, 0); assert.equal(w.calls.reads, 1);
  assert.equal(f.dispatches.length, 1); assert.equal(f.comments.length, 1);
});

test('게시 대기 중 다른 job 보고서가 도착하면 영수증 대기나 일반 timeout 대신 충돌', async t => {
  const w = await wrapperFixture(t);
  const result = await w.f.result(); // Different job and result from the wrapper's native result.
  result.source.jobId = 'other-job';
  let published = false;
  const gh = args => {
    const response = w.f.gh(args);
    if (args[0] === 'workflow') published = true;
    return response;
  };
  await assert.rejects(w.run({ gh, sleep: async () => {
    assert.equal(published, true);
    const p = await w.f.publish(result); w.f.finish(p);
  } }), /게시 결과 충돌/);
  const original = readFileSync(w.path, 'utf8');
  await assert.rejects(w.run(), /게시 결과 충돌/);
  assert.equal(readFileSync(w.path, 'utf8'), original);
  assert.equal(w.calls.reviews, 1); assert.equal(w.f.dispatches.length, 1); assert.equal(w.f.comments.length, 1);
});

test('필수 CI workflow·실행·대상·검사 경계를 wrapper·서버·확인에서 동일하게 차단', async t => {
  const cases = [
    ['pending', f => Object.assign(f.ci.check, { status: 'in_progress', conclusion: null })],
    ['failed', f => { f.ci.check.conclusion = 'failure'; }],
    ['unknown', f => { f.ci.check.conclusion = null; }],
    ['missing run', f => { f.ci.count = 0; }],
    ['duplicate run', f => { f.ci.count = 2; }],
    ['workflow', f => { f.ci.run.path = '.github/workflows/other.yml'; }],
    ['event', f => { f.ci.run.event = 'push'; }],
    ['repository', f => { f.ci.run.repository = { full_name: 'other/repo' }; }],
    ['head repository', f => { f.ci.run.head_repository = { full_name: 'other/repo' }; }],
    ['head', f => { f.ci.run.head_sha = 'a'.repeat(40); }],
    ['suite', f => { f.ci.run.check_suite_id = 999; }],
    ['run pending', f => { f.ci.run.status = 'in_progress'; }],
    ['run failure', f => { f.ci.run.conclusion = 'failure'; }],
    ['check app', f => { f.ci.check.app = { id: 1 }; }],
    ['check head', f => { f.ci.check.head_sha = 'a'.repeat(40); }],
    ['workflow changed', (f, target) => f.codeVersions.set('.github/workflows/ci.yml', new Map([[target.base, 'c'.repeat(40)], [target.head, 'a'.repeat(40)]]))],
    ['workflow missing', (f, target) => f.codeVersions.set('.github/workflows/ci.yml', new Map([[target.base, 'c'.repeat(40)]]))],
  ];
  for (const [name, mutate] of cases) await t.test(name, async t => {
    const w = await wrapperFixture(t); const { f } = w;
    const result = await f.result(); mutate(f, result.target);
    await assert.rejects(w.run(), /필수 CI/);
    const before = readFileSync(w.path, 'utf8');
    assert.equal(JSON.parse(before).publicationRequested, undefined);
    await assert.rejects(w.run(), /필수 CI/);
    assert.equal(readFileSync(w.path, 'utf8'), before);
    await assert.rejects(f.publish(result), /필수 CI/);
    assert.equal(w.calls.reviews, 1); assert.equal(f.dispatches.length, 0); assert.equal(f.comments.length, 0);
    const confirmedFixture = localFixture(); const r = await confirmedFixture.result();
    const p = await confirmedFixture.publish(r); confirmedFixture.finish(p);
    mutate(confirmedFixture, r.target);
    await assert.rejects(confirmedFixture.confirm(), /필수 CI/);
  });
});

test('CI 사전 확인 직후 head·CI 변경은 서버가 재검증하고 댓글을 만들지 않음', async t => {
  for (const kind of ['head', 'ci']) await t.test(kind, async t => {
    const w = await wrapperFixture(t);
    const gh = args => {
      const response = w.f.gh(args);
      if (args[0] === 'workflow') {
        if (kind === 'head') w.f.fake.store.head = 'e'.repeat(40);
        else w.f.ci.check.conclusion = 'failure';
      }
      return response;
    };
    await assert.rejects(w.run({ gh, maxPolls: 1 }), kind === 'head' ? /게시 대기 중 대상 변경/ : /완료를 확인하지 못함/);
    await assert.rejects(publishEvidence({ github: w.f.github, context: w.f.context, request: w.f.dispatches[0] }), kind === 'head' ? /대상/ : /등록 전 근거 변경/);
    if (kind === 'ci') {
      // 갱신된 collectionHash로 앞선 근거 변경 방어를 통과시켜 CI 재검증 자체도 확인한다.
      const freshRequest = await w.f.request(w.f.dispatches[0].result);
      await assert.rejects(publishEvidence({ github: w.f.github, context: w.f.context, request: freshRequest }), /필수 CI 미통과/);
    }
    assert.equal(w.f.dispatches.length, 1); assert.equal(w.f.comments.length, 0);
    await assert.rejects(w.run({ maxPolls: 1 }), kind === 'head' ? /로컬 검토 대상 SHA 불일치/ : /완료를 확인하지 못함/);
    assert.equal(w.calls.reviews, 1); assert.equal(w.f.dispatches.length, 1);
  });
});

test('복구는 running/captured 및 다른 세션 ledger를 조회·쓰기·모델 호출 없이 거부', async t => {
  for (const kind of ['running', 'captured', 'session']) await t.test(kind, async t => {
    const w = await wrapperFixture(t); const result = await w.f.result();
    const text = JSON.stringify({ state: kind === 'session' ? 'completed' : kind,
      session: kind === 'session' ? 'other-session' : 'session-1', target: w.target, result });
    writeFileSync(w.path, text);
    await assert.rejects(w.run({ options: { ...w.options, recover: true } }), /unpublished completed target/);
    if (kind !== 'captured') await assert.rejects(w.run(), /미완료·실패·다른 세션/);
    assert.equal(readFileSync(w.path, 'utf8'), text); assert.equal(existsSync(w.path + '.recovered.v3.json'), false);
    assert.equal(w.calls.reviews, 0); assert.equal(w.calls.reads, 0);
    assert.equal(w.f.dispatches.length, 0); assert.equal(w.f.comments.length, 0);
  });
});

test('손상·과거 v1 봇 보고서는 게시·확인·wrapper 모두 무시하지 않고 원문·영수증을 보존', async t => {
  for (const kind of ['malformed', 'v1', 'tampered', 'missing target', 'missing source']) await t.test(kind, async t => {
    const f = localFixture(); const r = await f.result(); const p = await f.publish(r); f.finish(p);
    const bad = structuredClone(f.comments[0]); bad.id = 201;
    if (kind === 'malformed') bad.body = '# 미인증 로컬 독립 리뷰 자료\n\nbroken';
    if (kind === 'v1') bad.body = '# 미인증 로컬 독립 리뷰 자료\n\n<!-- photo-selector-review-evidence:v1 old -->';
    if (kind === 'tampered') bad.body += 'changed';
    if (kind === 'missing target' || kind === 'missing source') {
      const invalid = structuredClone(r);
      delete invalid[kind === 'missing target' ? 'target' : 'source'];
      bad.body = renderLocalReport(invalid, 44).body;
    }
    f.comments.push(bad);
    const before = JSON.stringify({ comments: f.comments, artifacts: f.artifacts });
    const w = await wrapperFixture(t, f);
    await assert.rejects(f.confirm());
    const originalRun = structuredClone(f.run); f.context.runId = 45;
    f.github.rest.actions.getWorkflowRun = async ({ run_id }) => ({ data: run_id === 44 ? originalRun : { ...originalRun, id: 45, status: 'in_progress', conclusion: null } });
    await assert.rejects(f.publish(r));
    await assert.rejects(w.run());
    assert.equal(existsSync(w.path), false); assert.equal(w.calls.reviews, 0);
    assert.equal(f.dispatches.length, 0); assert.equal(JSON.stringify({ comments: f.comments, artifacts: f.artifacts }), before);
  });
});

const observedReport = 'No actionable defects were found in the changes against the specified base. Lint, 46 targeted unit tests, and 31 merge-tool tests passed; four platform-specific tests were skipped. Build and E2E checks were not run.';

test('PR23 관찰 문법 전체만 수용하고 혼재·모호함·미완료는 unknown 유지', () => {
  assert.equal(findingsFromText(observedReport).unknown, 0);
  assert.equal(findingsFromText(observedReport.replaceAll('. ', '.\r\n')).unknown, 0);
  for (const text of ['', 'Looks good.', observedReport + ' Hidden issue.', observedReport + ' [P2] bug',
    'No findings. Review was skipped.', 'No findings. quota exceeded', 'No findings.Unrecognised',
    observedReport.replace('passed;', 'failed;'), observedReport.replace('four', 'unknown')]) {
    assert.ok(findingsFromText(text).unknown > 0, text);
  }
  assert.equal(findingsFromText(observedReport + ' [P2] bug').medium, 1);
  const args = ['owner/repo', '1', '--plugin-root', '/plugin', '--session', 'session-1'];
  assert.equal(parsePluginArgs([...args, '--recover'], {}).recover, true);
  assert.equal(parsePluginArgs([...args, '--recover', '--recover'], {}), null);
});

test('완료 결과 복구는 result만 조회하고 원래 ledger 보존·재실행/중복 dispatch 금지', async () => {
  const f = localFixture(); const { target } = await f.result();
  const data = pluginFixture(target); data.output.codex.stdout = observedReport;
  const original = collectPluginResult({ ...data, target, session: 'session-1', startedAt: '2026-11-09T00:00:00Z', checks: [] });
  original.findings.unknown = 1; // Immutable old parser result.
  const directory = mkdtempSync(join(tmpdir(), 'review-recover-test-')); const path = join(directory, 'ledger.json');
  const originalText = JSON.stringify({ state: 'completed', session: 'session-1', target, result: original });
  const git = args => args[1] === '--git-path' ? path : args.at(-1) === 'HEAD' ? target.head : target.base;
  let reads = 0;
  const plugin = args => { assert.deepEqual(args, ['result', '--json']); reads++; return data.stored; };
  const run = (recover = true) => runPluginPublication({ options: { repository: 'owner/repo', number: 1, session: 'session-1', recover },
    gh: f.gh, git, plugin, maxPolls: 1, out: () => {} });
  try {
    await assert.rejects(run(), /No completed ledger/); assert.equal(reads, 0);
    writeFileSync(path, originalText);
    await assert.rejects(run(), /완료를 확인하지 못함/);
    const recovered = JSON.parse(readFileSync(path + '.recovered.v3.json'));
    assert.equal(recovered.result.findings.unknown, 0);
    assert.equal(recovered.result.report, original.report);
    assert.equal(recovered.recovery.parserVersion, 3);
    await assert.rejects(run(), /완료를 확인하지 못함/);
    await assert.rejects(run(false), /완료를 확인하지 못함/);
    assert.equal(reads, 1); assert.equal(f.dispatches.length, 1);
    const p = await f.publish(recovered.result); f.finish(p);
    assert.equal(await run(), 0);
    assert.equal(readFileSync(path, 'utf8'), originalText);
    assert.ok(JSON.parse(readFileSync(path + '.recovered.v3.json')).recovery.originalLedgerHash);
    assert.equal(reads, 1); assert.equal(f.comments.length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('복구의 대상·job 불일치와 이미 요청한 결과는 새 모델/게시 없이 차단', async () => {
  for (const kind of ['target', 'job', 'requested', 'unknown']) {
    const f = localFixture(); const { target } = await f.result(); const data = pluginFixture(target);
    if (kind === 'unknown') data.output.codex.stdout = 'Uncertain review.';
    const r = collectPluginResult({ ...data, target, session: 'session-1', startedAt: '2026-11-09T00:00:00Z', checks: [] });
    const ledger = { state: 'completed', session: 'session-1', target: structuredClone(target), result: r };
    if (kind === 'target') ledger.target.head = 'e'.repeat(40);
    if (kind === 'requested') ledger.publicationRequested = true;
    if (kind === 'job') data.stored.storedJob.id = 'different-job';
    const directory = mkdtempSync(join(tmpdir(), 'review-recover-deny-')); const path = join(directory, 'ledger.json');
    const git = args => args[1] === '--git-path' ? path : args.at(-1) === 'HEAD' ? target.head : target.base;
    const originalText = JSON.stringify(ledger); writeFileSync(path, originalText);
    try {
      const run = () => runPluginPublication({ options: { repository: 'owner/repo', number: 1, session: 'session-1', recover: true },
        gh: f.gh, git, plugin: args => { assert.equal(args[0], 'result'); return data.stored; }, maxPolls: 1, out: () => {} });
      if (kind === 'unknown') assert.equal(await run(), 2); else await assert.rejects(run());
      assert.equal(f.dispatches.length, 0); assert.equal(f.comments.length, 0); assert.equal(readFileSync(path, 'utf8'), originalText);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});

test('같은 base/head의 다른 결과 집계·job·fingerprint는 두 번째 댓글이 아님', async () => {
  const f = localFixture(); const r = await f.result(); const p = await f.publish(r); f.finish(p);
  for (const mutate of [x => { x.findings.low = 1; }, x => { x.source.jobId = 'different-job'; }, x => { x.target.fingerprint = '0'.repeat(64); }]) {
    const changed = structuredClone(r); mutate(changed); await assert.rejects(f.publish(changed));
    assert.equal(f.comments.length, 1);
  }
});

test('wrapper는 다른 job의 기존 게시를 현재 ledger의 성공으로 인정하지 않음', async () => {
  const f = localFixture(); const r = await f.result(); const p = await f.publish(r); f.finish(p);
  const directory = mkdtempSync(join(tmpdir(), 'review-job-conflict-')); const path = join(directory, 'ledger.json');
  const changed = structuredClone(r); changed.source.jobId = 'different-job';
  writeFileSync(path, JSON.stringify({ state: 'completed', target: r.target, session: 'session-1', result: changed }));
  const git = args => args[1] === '--git-path' ? path : args.at(-1) === 'HEAD' ? r.target.head : r.target.base;
  try {
    await assert.rejects(runPluginPublication({ options: { repository: 'owner/repo', number: 1, session: 'session-1' },
      gh: f.gh, git, plugin: () => assert.fail('No model call'), maxPolls: 3,
      sleep: () => assert.fail('Conflict must not poll'), out: () => assert.fail('No successful confirmation') }), /게시 결과 충돌/);
    assert.equal(f.dispatches.length, 0); assert.equal(f.comments.length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('서버는 원문 지적 축소 및 실패/다른 workflow CI를 차단', async () => {
  const f = localFixture(); const r = await f.result();
  r.report = 'No findings. [P2] Missing permission.';
  const { reportHash } = await import('./review-gate-core.mjs'); r.source.outputHash = reportHash(r.report);
  await assert.rejects(f.publish(r), /축소/); assert.equal(f.comments.length, 0);
  for (const kind of ['failed', 'wrong-source']) {
    const f = localFixture(); const r = await f.result();
    if (kind === 'failed') {
      const get = f.github.rest.checks.listForRef;
      f.github.rest.checks.listForRef = async args => { const response = await get(args); for (const c of response.data) if (c.name === 'verify') c.conclusion = 'failure'; return response; };
    } else {
      const get = f.github.rest.actions.listWorkflowRuns;
      f.github.rest.actions.listWorkflowRuns = async args => { const response = await get(args); for (const run of response.data) run.event = 'workflow_dispatch'; return response; };
    }
    await assert.rejects(f.publish(r), /필수 CI/); assert.equal(f.comments.length, 0);
  }
});

test('native 플러그인 완료 기록·동일 세션·출력·판정 형식을 검사하고 원문·미실행 한계를 보존', async () => {
  const target = (await localFixture().result()).target; const fixture = pluginFixture(target);
  const input = { ...fixture, target, session: 'session-1', startedAt: '2026-11-09T00:00:00Z', checks: [] };
  const result = collectPluginResult(input); validatePluginResult(result, target, 'claude');
  assert.equal(result.report, fixture.output.codex.stdout); assert.ok(result.notRun.length);
  assert.equal(findingsFromText('No actionable defects were found.').unknown, 0);
  assert.equal(findingsFromText('Looks good.').unknown, 1);
  assert.ok(findingsFromText('No findings. The review was skipped due to rate limit.').unknown > 0);
  assert.equal(findingsFromText('No findings. However, permission checks are missing.').unknown, 1);
  assert.equal(findingsFromText('No actionable defects were found. Critical bug in export.').unknown, 1);
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
    assert.equal(JSON.parse(readFileSync(path)).state, 'captured');
    assert.equal(JSON.parse(readFileSync(path)).output.codex.stdout, data.output.codex.stdout);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('완료 원문·job을 검증보다 먼저 보존하고 크기/조회 실패 뒤 추가 모델 호출 없이 복구', async () => {
  const f = localFixture(); const { target } = await f.result();
  const directory = mkdtempSync(join(tmpdir(), 'review-captured-test-')); const path = join(directory, 'ledger.json');
  const options = { repository: 'owner/repo', number: 1, session: 'session-1' };
  const data = pluginFixture(target); data.output.codex.stdout = 'No findings. ' + 'x'.repeat(16_001);
  let reviews = 0, reads = 0;
  const git = args => args[1] === '--git-path' ? path : args.at(-1) === 'HEAD' ? target.head : target.base;
  const plugin = args => { if (args[0] === 'review') { reviews++; return data.output; } if (++reads === 1) throw new Error('read failed'); return data.stored; };
  const run = () => runPluginPublication({ options, gh: f.gh, git, plugin, maxPolls: 1, now: () => '2026-11-09T00:00:00Z', out: () => {} });
  try {
    await assert.rejects(run(), /read failed/);
    assert.equal(JSON.parse(readFileSync(path)).output.codex.stdout, data.output.codex.stdout);
    await assert.rejects(run(), error => error.code === 'review-report-too-large');
    const captured = JSON.parse(readFileSync(path)); assert.equal(captured.stored.storedJob.id, 'job-1');
    assert.equal(reviews, 1); assert.equal(reads, 2); assert.equal(f.dispatches.length, 0);
    await assert.rejects(run(), error => error.code === 'review-report-too-large');
    assert.equal(reviews, 1); assert.equal(reads, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('공개 사용자가 복사한 봇 문구는 정상 보고서의 재사용·확인 생성을 막지 않음', async () => {
  const f = localFixture(); const result = await f.result(); const p = await f.publish(result); f.finish(p);
  f.comments.push({ ...structuredClone(f.comments[0]), id: 201, user: { id: 2, login: 'peer', type: 'User' }, performed_via_github_app: null });
  assert.equal((await f.confirm()).commentId, 200);
  const original = structuredClone(f.run); f.context.runId = 45;
  f.github.rest.actions.getWorkflowRun = async ({ run_id }) => ({ data: run_id === 44 ? original : { ...original, id: 45, status: 'in_progress', conclusion: null } });
  assert.equal((await f.publish(result)).reused, true); assert.equal(f.comments.length, 2);
});

test('게시 승인 코드 목록은 실제 로컬 import 폐쇄와 같음', () => {
  const seen = new Set();
  const visit = name => {
    if (seen.has(name)) return; seen.add(name);
    for (const match of readFileSync(new URL(`./${name}`, import.meta.url), 'utf8').matchAll(/from '\.\/([^']+)'/g)) visit(match[1]);
  };
  visit('review-evidence.mjs');
  assert.deepEqual([...seen].sort(), [...publicationModules].sort());
});

test('게시 코드 전체에서 승인 기준 커밋과 실행 커밋의 SHA 불일치·누락·형식 오류를 차단', async () => {
  for (const path of [evidenceWorkflow, ...publicationModules.map(name => `.github/scripts/${name}`)]) {
    const f = localFixture(); const result = await f.result(); const published = await f.publish(result); f.finish(published);
    const pr = (await f.github.rest.pulls.get({ pull_number: 1 })).data;
    const approved = pr.base.sha;
    const executed = f.run.head_sha;
    const versions = new Map([[approved, '1'.repeat(40)], [executed, '2'.repeat(40)], ['main', '1'.repeat(40)]]);
    f.codeVersions.set(path, versions);
    const verify = () => verifyLocalReport({ github: f.github, repo: f.context.repo, pr, comment: f.comments[0], fingerprint: result.target.fingerprint, approvedRef: approved });
    await assert.rejects(verify(), /게시 코드 승인 버전 불일치/, path);
    versions.set(executed, '1'.repeat(40));
    assert.equal((await verify()).runId, f.run.id, path);
    versions.delete(executed);
    await assert.rejects(verify(), /게시 코드 승인 버전 불일치/, `${path}: missing execution SHA`);
    versions.set(executed, 'invalid-sha');
    await assert.rejects(verify(), /게시 코드 승인 버전 불일치/, `${path}: malformed execution SHA`);
    versions.set(executed, '1'.repeat(40)); versions.delete(approved);
    await assert.rejects(verify(), /게시 코드 승인 버전 불일치/, `${path}: missing approved SHA`);
  }
});

test('게시 코드 snapshot은 최신 main 대신 승인 기준 커밋과 실행 커밋을 대조', async () => {
  const f = localFixture(); const result = await f.result(); const published = await f.publish(result); f.finish(published);
  const pr = (await f.github.rest.pulls.get({ pull_number: 1 })).data;
  const approved = pr.base.sha;
  const executed = f.run.head_sha;
  const paths = [evidenceWorkflow, ...publicationModules.map(name => `.github/scripts/${name}`)];
  for (const path of paths) f.codeVersions.set(path, new Map([[approved, '1'.repeat(40)], [executed, '1'.repeat(40)], ['main', '2'.repeat(40)]]));
  f.contentRequests.length = 0;
  const params = { github: f.github, repo: f.context.repo, pr, comment: f.comments[0], fingerprint: result.target.fingerprint };
  assert.equal((await verifyLocalReport({ ...params, approvedRef: approved })).runId, f.run.id);
  const requests = f.contentRequests.filter(request => paths.includes(request.path));
  assert.equal(requests.length, paths.length * 2);
  for (const path of paths) assert.deepEqual(requests.filter(request => request.path === path).map(request => request.ref).sort(), [approved, executed].sort());
  await assert.rejects(verifyLocalReport(params), /게시 코드 승인 버전 불일치/);
});

test('실제 병합 adapter로 봇 근거·proof v2·High 승인·병합 후 정책 snapshot 감사를 끝까지 검증', async () => {
  const f = localFixture(); const result = await f.result(); const p = await f.publish(result); f.finish(p);
  const codePath = '.github/scripts/review-evidence.mjs';
  const approvedRef = result.target.base;
  const executedRef = f.run.head_sha;
  const beforeMerge = new Map([['main', '1'.repeat(40)], [approvedRef, '1'.repeat(40)], [executedRef, '1'.repeat(40)]]);
  f.codeVersions.set(codePath, beforeMerge);
  f.mergedCodeVersions.set(codePath, new Map([['main', '2'.repeat(40)], [approvedRef, '1'.repeat(40)], [executedRef, '1'.repeat(40)]]));
  const c = await f.confirm(); f.addConfirmation(c.confirmation);
  f.fake.store.localEvidenceDigest = (await f.collect()).packet.gateEvidenceDigest;
  const withoutApproval = await assessMerge({ gh: f.gh, git: f.fake.git, repo: 'owner/repo', number: 1, expectedHead: result.target.head });
  assert.equal(withoutApproval.ok, false);
  assert.ok(withoutApproval.blockers.some(message => message.includes('사용자 승인')));
  f.comments.push({ id: 400, user: { id: 1, login: 'owner', type: 'User' }, created_at: '2026-11-10T00:04:00Z', updated_at: '2026-11-10T00:04:00Z',
    body: `/merge-approve ${result.target.head} ${result.target.fingerprint}` });
  f.fake.store.localEvidenceDigest = (await f.collect()).packet.gateEvidenceDigest;
  const assessment = await assessMerge({ gh: f.gh, git: f.fake.git, repo: 'owner/repo', number: 1, expectedHead: result.target.head });
  assert.equal(assessment.ok, true, assessment.blockers.join('; '));
  beforeMerge.set(executedRef, '3'.repeat(40));
  const mismatched = await assessMerge({ gh: f.gh, git: f.fake.git, repo: 'owner/repo', number: 1, expectedHead: result.target.head });
  assert.equal(mismatched.ok, false);
  assert.ok(mismatched.blockers.some(message => message.includes('기존 게이트 평가 실패')));
  beforeMerge.set(executedRef, '1'.repeat(40));
  const output = [], errors = [];
  const gh = args => { const value = f.gh(args); if (args[0] === 'pr' && args[1] === 'merge') f.contentRequests.length = 0; return value; };
  assert.equal(await runMergeTool({ argv: ['owner/repo', '1', 'squash', '--head', result.target.head], gh, git: f.fake.git,
    out: text => output.push(text), err: text => errors.push(text), sleep: async () => {}, lock: () => ({ ok: true, release() {} }) }), 0, errors.join('\n'));
  assert.ok(output.some(s => s.includes('병합 후 감사: 게이트 근거가 병합 직전 재확인과 같음')));
  assert.equal(f.fake.store.merged, true);
  assert.deepEqual(f.contentRequests.filter(request => request.path === codePath).map(request => request.ref).sort(), [approvedRef, executedRef].sort());
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

const zeroFindings = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };

test('PR #28 원문: wrapper는 지적 0건과 리뷰어 검사 실패를 분리해 출력하고 게시·모델 재호출하지 않음', async t => {
  const w = await wrapperFixture(t); w.data.output.codex.stdout = pr28Report;
  const outputs = [];
  const out = text => outputs.push(JSON.parse(text));
  assert.equal(await w.run({ out }), 2);
  assert.equal(await w.run({ out }), 2);
  const [first, second] = outputs;
  assert.deepEqual(second, first);
  assert.equal(first.state, 'review-checks-need-attention'); assert.equal(first.published, false);
  assert.deepEqual(first.blockers, ['reviewer-check-failed']);
  assert.deepEqual(first.codeFindings, zeroFindings);
  assert.deepEqual(first.reviewerCheckFailures, [{ name: 'privacyGuard', status: 'failed', count: null, cause: { kind: 'environment-claimed', text: '환경의 임시 폴더 생성 권한 제한' } }]);
  assert.ok(first.reviewerChecks.some(c => c.name === 'Build' && c.status === 'not-run'));
  assert.ok(first.remoteChecks.some(c => c.name === 'GitHub check: verify'));
  assert.equal(first.result.report, pr28Report); assert.match(first.note, /통과로 바꾸지 않았/);
  const ledger = JSON.parse(readFileSync(w.path, 'utf8'));
  assert.equal(ledger.state, 'completed'); assert.equal(ledger.publicationRequested, undefined); assert.equal(ledger.result.v, 3);
  assert.equal(w.calls.reviews, 1); assert.equal(w.calls.reads, 1);
  assert.equal(w.f.dispatches.length, 0); assert.equal(w.f.comments.length, 0);
});

test('원인 없는 실패와 코드 지적은 review-needs-attention으로 남기고 검사 실패도 함께 노출', async t => {
  const w = await wrapperFixture(t); w.data.output.codex.stdout = 'No findings. Lint passed, but privacyGuard failed. [P2] Export drops metadata.';
  let output;
  assert.equal(await w.run({ out: text => { output = JSON.parse(text); } }), 2);
  assert.equal(output.state, 'review-needs-attention'); assert.deepEqual(output.blockers, ['findings', 'reviewer-check-failed']);
  assert.equal(output.codeFindings.medium, 1); assert.ok(output.codeFindings.unknown > 0);
  assert.deepEqual(output.reviewerCheckFailures.map(c => [c.name, c.cause]), [['privacyGuard', null]]);
  assert.equal(w.f.dispatches.length, 0); assert.equal(w.f.comments.length, 0);
});

test('PR #28 형태 v2 ledger 복구: 원본 불변·parser v3로 실패를 분리·게시하지 않음, 손상 원본은 거부', async t => {
  const legacy = async (t, mutate = () => {}) => {
    const w = await wrapperFixture(t); w.data.output.codex.stdout = pr28Report;
    const current = collectPluginResult({ ...w.data, target: w.target, session: 'session-1', startedAt: '2026-11-09T00:00:00Z', checks: [] });
    const rest = { ...current }; delete rest.reviewerChecks;
    // parser v2가 PR #28에 기록한 결과 형태: 검사 기록 없음, unknown 1.
    const result = { ...rest, v: 2, findings: { ...current.findings, unknown: 1 } }; mutate(result);
    const original = JSON.stringify({ state: 'completed', target: w.target, session: 'session-1', result });
    writeFileSync(w.path, original);
    return { w, original };
  };
  await t.test('recover', async t => {
    const { w, original } = await legacy(t);
    const outputs = [];
    const recover = () => w.run({ options: { ...w.options, recover: true }, out: text => outputs.push(JSON.parse(text)) });
    assert.equal(await recover(), 2); assert.equal(await recover(), 2);
    assert.equal(readFileSync(w.path, 'utf8'), original);
    const recovered = JSON.parse(readFileSync(w.path + '.recovered.v3.json', 'utf8'));
    assert.equal(recovered.recovery.parserVersion, 3); assert.equal(recovered.result.v, 3);
    assert.deepEqual(recovered.result.findings, zeroFindings); assert.equal(recovered.result.report, pr28Report);
    assert.equal(outputs[0].state, 'review-checks-need-attention'); assert.deepEqual(outputs[1], outputs[0]);
    assert.equal(w.calls.reviews, 0); assert.equal(w.calls.reads, 1);
    assert.equal(w.f.dispatches.length, 0); assert.equal(w.f.comments.length, 0);
  });
  for (const [name, mutate] of [['hash', r => { r.report += ' '; }], ['version', r => { r.v = 1; }], ['status', r => { r.status = 'failed'; }],
    ['source', r => { r.source.kind = 'local-session'; }]]) await t.test(name, async t => {
    const { w, original } = await legacy(t, mutate);
    await assert.rejects(w.run({ options: { ...w.options, recover: true } }), /Recovery original result invalid/);
    assert.equal(readFileSync(w.path, 'utf8'), original); assert.equal(existsSync(w.path + '.recovered.v3.json'), false);
    assert.equal(w.calls.reviews, 0); assert.equal(w.calls.reads, 0); assert.equal(w.f.dispatches.length, 0);
  });
});

test('로컬 게시·판정 코드가 기본 브랜치와 다르면 dispatch하지 않고 완료 결과 보존·모델 재호출 없음', async t => {
  const w = await wrapperFixture(t); const { f, path } = w;
  f.codeVersions.set('.github/scripts/review-result-parser.mjs', new Map([['main', 'a'.repeat(40)]]));
  const mismatch = error => {
    assert.equal(error.code, 'review-publication-code-mismatch'); assert.match(error.message, /review-result-parser\.mjs/);
    assert.match(pluginPublicationFailureMessage(error), /기본 브랜치와 달라.*수동 리뷰 보고 절차/);
    return true;
  };
  await assert.rejects(w.run(), mismatch);
  const completed = readFileSync(path, 'utf8');
  assert.equal(JSON.parse(completed).state, 'completed'); assert.equal(JSON.parse(completed).publicationRequested, undefined);
  await assert.rejects(w.run(), mismatch);
  assert.equal(readFileSync(path, 'utf8'), completed);
  assert.equal(w.calls.reviews, 1); assert.equal(f.dispatches.length, 0); assert.equal(f.comments.length, 0);
});

test('서버는 원문과 다른 리뷰어 검사 기록(실패 삭제·통과 변조·원인 변경·추가)과 이전 형식을 거부', async () => {
  for (const mutate of [
    c => c.splice(c.findIndex(x => x.status === 'failed'), 1),
    c => { c.find(x => x.status === 'failed').status = 'passed'; },
    c => { c.find(x => x.status === 'failed').cause = null; },
    c => { c.find(x => x.status === 'failed').cause.kind = 'confirmed-environment'; },
    c => { c.find(x => x.status === 'not-run').status = 'passed'; },
    c => { c.push({ name: 'E2E', status: 'passed', count: null, cause: null }); },
  ]) {
    const f = localFixture(); const r = await f.result();
    r.report = pr28Report; r.source.outputHash = reportHash(pr28Report);
    r.reviewerChecks = analyzeReviewText(pr28Report).reviewerChecks; mutate(r.reviewerChecks);
    await assert.rejects(f.publish(r), /원문과 다른 리뷰어 검사 기록/); assert.equal(f.comments.length, 0);
  }
  for (const mutate of [r => { r.v = 2; }, r => { delete r.reviewerChecks; }, r => { r.reviewerChecks = null; }]) {
    const f = localFixture(); const r = await f.result(); mutate(r);
    await assert.rejects(f.publish(r)); assert.equal(f.comments.length, 0);
  }
});

test('리뷰어 검사 실패 결과는 봇 보고서로 기록돼도 관리자 확인 내용·게이트 근거가 되지 않음', async () => {
  const f = localFixture(); const r = await f.result();
  r.report = pr28Report; r.source.outputHash = reportHash(pr28Report); r.reviewerChecks = analyzeReviewText(pr28Report).reviewerChecks;
  const p = await f.publish(r); f.finish(p);
  await assert.rejects(f.confirm(), /리뷰어 로컬 검사 실패/);
  f.addConfirmation({ fingerprint: r.target.fingerprint, decision: 'pass', reviewer: 'codex', reviewComplete: true,
    evidence: p.commentUrl, evidenceHash: p.evidenceHash, findings: r.findings });
  await assert.rejects(f.collect(), /리뷰어 로컬 검사 실패/);
});

// parser v2 --recover가 남긴 복구 기록 형태. 원래 ledger와 함께 만들고, 두 파일은 테스트 내내 바뀌면 안 된다.
async function legacyRecoveryFixture(t, { report = pr23Report, legacy = () => {}, original = () => {}, legacyText = null } = {}) {
  const w = await wrapperFixture(t); w.data.output.codex.stdout = report;
  const current = collectPluginResult({ ...w.data, target: w.target, session: 'session-1', startedAt: '2026-11-09T00:00:00Z', checks: [] });
  const v2 = { ...current, v: 2, findings: { ...current.findings, unknown: 1 } }; delete v2.reviewerChecks;
  const originalLedger = { state: 'completed', target: structuredClone(w.target), session: 'session-1', result: v2 }; original(originalLedger);
  const originalText = JSON.stringify(originalLedger);
  writeFileSync(w.path, originalText);
  const legacyLedger = { state: 'completed', target: structuredClone(w.target), session: 'session-1',
    result: { ...structuredClone(v2), findings: { ...zeroFindings } }, recovery: { originalLedgerHash: sha256(originalText), parserVersion: 2 } };
  legacy(legacyLedger);
  const text = legacyText ?? JSON.stringify(legacyLedger);
  writeFileSync(w.path + '.recovered.json', text);
  const unchanged = () => {
    assert.equal(readFileSync(w.path, 'utf8'), originalText);
    assert.equal(readFileSync(w.path + '.recovered.json', 'utf8'), text);
  };
  const recover = (overrides = {}) => w.run({ options: { ...w.options, recover: true }, maxPolls: 1, ...overrides });
  return { w, text, unchanged, recover };
}

const manualRecovery = error => {
  assert.equal(error.code, 'review-recovery-manual');
  assert.match(pluginPublicationFailureMessage(error), /수정하지 않았으며 자동 재해석·재요청·모델 호출을 하지 않습니다/);
  return true;
};

test('v2 복구 파일 부재: v3 파일을 새로 만들고 legacyRecoveredHash는 null', async t => {
  const w = await wrapperFixture(t); w.data.output.codex.stdout = pr23Report;
  const current = collectPluginResult({ ...w.data, target: w.target, session: 'session-1', startedAt: '2026-11-09T00:00:00Z', checks: [] });
  const v2 = { ...current, v: 2 }; delete v2.reviewerChecks;
  const originalText = JSON.stringify({ state: 'completed', target: w.target, session: 'session-1', result: v2 });
  writeFileSync(w.path, originalText);
  await assert.rejects(w.run({ options: { ...w.options, recover: true }, maxPolls: 1 }), /완료를 확인하지 못함/);
  const recovered = JSON.parse(readFileSync(w.path + '.recovered.v3.json', 'utf8'));
  assert.equal(recovered.recovery.legacyRecoveredHash, null); assert.equal(recovered.result.v, 3);
  assert.equal(existsSync(w.path + '.recovered.json'), false); assert.equal(readFileSync(w.path, 'utf8'), originalText);
  assert.equal(w.calls.reviews, 0); assert.equal(w.calls.reads, 1); assert.equal(w.f.dispatches.length, 1);
});

test('게시 요청 전 v2 복구 파일: 보존한 채 v3로 재해석, 한 번만 요청, v3 복구 중복 실행은 재사용', async t => {
  const { w, text, unchanged, recover } = await legacyRecoveryFixture(t);
  await assert.rejects(recover(), /완료를 확인하지 못함/);
  unchanged();
  const recovered = JSON.parse(readFileSync(w.path + '.recovered.v3.json', 'utf8'));
  assert.equal(recovered.recovery.legacyRecoveredHash, sha256(text)); assert.equal(recovered.recovery.parserVersion, 3);
  assert.equal(recovered.result.v, 3); assert.deepEqual(recovered.result.findings, zeroFindings);
  assert.ok(recovered.result.reviewerChecks.some(c => c.status === 'skipped'));
  assert.equal(recovered.publicationRequested, true); assert.equal(w.f.dispatches.length, 1);
  // 응답 대기 중 재실행(복구·일반 모두)은 v3 파일을 재사용하고 다시 조회·요청하지 않는다.
  await assert.rejects(recover(), /완료를 확인하지 못함/);
  await assert.rejects(w.run({ maxPolls: 1 }), /완료를 확인하지 못함/);
  const p = await w.f.publish(w.f.dispatches[0].result); w.f.finish(p);
  assert.equal(await recover(), 0); assert.equal(await w.run(), 0);
  unchanged();
  assert.equal(w.calls.reviews, 0); assert.equal(w.calls.reads, 1);
  assert.equal(w.f.dispatches.length, 1); assert.equal(w.f.comments.length, 1);
});

test('게시 요청 전 v2 복구 파일 + PR #28 원문: v3 재해석 후 검사 실패로 게시하지 않음', async t => {
  const { w, unchanged, recover } = await legacyRecoveryFixture(t, { report: pr28Report });
  let output;
  assert.equal(await recover({ out: text => { output = JSON.parse(text); } }), 2);
  unchanged();
  assert.equal(output.state, 'review-checks-need-attention'); assert.deepEqual(output.codeFindings, zeroFindings);
  assert.deepEqual(output.reviewerCheckFailures.map(c => c.name), ['privacyGuard']);
  assert.equal(w.calls.reviews, 0); assert.equal(w.calls.reads, 1); assert.equal(w.f.dispatches.length, 0);
});

test('v2 복구 파일의 게시 요청 기록·불명확·부분 기록·변조·다른 대상/세션은 수동 확인으로 중단', async t => {
  const cases = [
    ['requested', { legacy: l => { l.publicationRequested = true; } }],
    ['requested false', { legacy: l => { l.publicationRequested = false; } }],
    ['published', { legacy: l => { l.publicationRequested = true; l.publication = { commentUrl: 'x', evidenceHash: '0'.repeat(64) }; } }],
    ['unknown field', { legacy: l => { l.extra = 1; } }],
    ['partial json', { legacyText: '{"state":"completed","target":' }],
    ['not object', { legacyText: '[]' }],
    ['missing recovery', { legacy: l => { delete l.recovery; } }],
    ['recovery extra', { legacy: l => { l.recovery.publicationRequested = true; } }],
    ['parser version', { legacy: l => { l.recovery.parserVersion = 3; } }],
    ['original hash', { legacy: l => { l.recovery.originalLedgerHash = '0'.repeat(64); } }],
    ['captured', { legacy: l => { l.state = 'captured'; } }],
    ['session', { legacy: l => { l.session = 'other-session'; } }],
    ['head', { legacy: l => { l.target.head = 'e'.repeat(40); } }],
    ['base', { legacy: l => { l.target.base = 'a'.repeat(40); } }],
    ['result version', { legacy: l => { l.result.v = 3; } }],
    ['report tampered', { legacy: l => { l.result.report += ' Hidden.'; } }],
    ['report hash', { legacy: l => { l.result.report += ' Hidden.'; l.result.source.outputHash = reportHash(l.result.report); } }],
    ['job', { legacy: l => { l.result.source.jobId = 'other-job'; } }],
  ];
  for (const [name, options] of cases) await t.test(name, async t => {
    const { w, unchanged, recover } = await legacyRecoveryFixture(t, options);
    await assert.rejects(recover(), manualRecovery);
    await assert.rejects(recover(), manualRecovery);
    // --recover 없이 실행해도 원래 ledger로 되돌아가 새 리뷰·게시를 시도하지 않는다.
    await assert.rejects(w.run(), manualRecovery);
    unchanged(); assert.equal(existsSync(w.path + '.recovered.v3.json'), false);
    assert.equal(w.calls.reviews, 0); assert.equal(w.calls.reads, 0);
    assert.equal(w.f.dispatches.length, 0); assert.equal(w.f.comments.length, 0);
  });
});

test('v2 복구 파일이 있어도 원래 ledger의 다른 대상·세션·게시 요청·원문 변조는 먼저 거부', async t => {
  for (const [name, original, pattern] of [
    ['head', o => { o.target.head = 'e'.repeat(40); }, /unpublished completed target/],
    ['base', o => { o.target.base = 'a'.repeat(40); }, /unpublished completed target/],
    ['session', o => { o.session = 'other-session'; }, /unpublished completed target/],
    ['requested', o => { o.publicationRequested = true; }, /unpublished completed target/],
    ['report', o => { o.result.report += ' Hidden.'; }, /Recovery original result invalid/],
  ]) await t.test(name, async t => {
    const { w, unchanged, recover } = await legacyRecoveryFixture(t, { original });
    await assert.rejects(recover(), pattern);
    unchanged(); assert.equal(existsSync(w.path + '.recovered.v3.json'), false);
    assert.equal(w.calls.reviews, 0); assert.equal(w.calls.reads, 0); assert.equal(w.f.dispatches.length, 0);
  });
});

test('부분 기록된 v3 복구 파일은 덮어쓰거나 재해석하지 않고 중단', async t => {
  const { w, unchanged, recover } = await legacyRecoveryFixture(t);
  writeFileSync(w.path + '.recovered.v3.json', '{"state":"completed"');
  await assert.rejects(recover()); await assert.rejects(w.run());
  unchanged(); assert.equal(readFileSync(w.path + '.recovered.v3.json', 'utf8'), '{"state":"completed"');
  assert.equal(w.calls.reviews, 0); assert.equal(w.calls.reads, 0); assert.equal(w.f.dispatches.length, 0);
});

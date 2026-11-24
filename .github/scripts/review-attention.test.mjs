import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localFixture, pr28Report, pr34Report, pr37FinalReport, pr40FinalReport, cleanJobLog, pr40FinalJobLog, completeJobLog, jobLogStart, jobLogEnd } from './review-local-fixture.mjs';
import { runPluginPublication, collectPluginResult } from './review-plugin-cli.mjs';
import { runAttentionCli, parseAttentionArgs, attentionFailureMessage } from './review-attention-cli.mjs';
import { parseJobCommands, ledgerFileName, draftMarker, classifyCheck, buildAttentionDraft, maxDraftChars, jobLogBlockers, interpretStoredResult } from './review-attention.mjs';
import { reportHash, sha256 } from './review-gate-core.mjs';

const home = 'C:\\Users\\tester';

// codex-companion 1.0.6의 job 로그 형식(appendLogLine/appendLogBlock). PR #34 조사에서 확인한 명령 결과를 재현한다.
// "Final output" 뒤는 리뷰어가 쓴 글이므로 같은 형식의 위조 줄이 있어도 실행 기록으로 보지 않아야 한다.
// 리뷰 시작·원문 기록·최종 출력의 완료 증거는 실제 로그 구조와 같게 둔다.
const pr34JobLog = [
  '[2026-11-21T07:47:03.300Z] Starting Codex Review.',
  "[2026-11-21T07:47:05.000Z] Reviewer started: changes against 'base'",
  '[2026-11-21T07:47:40.000Z] Running command: npm run lint',
  '[2026-11-21T07:48:10.000Z] Command completed: npm run lint (exit 0)',
  `[2026-11-21T07:48:11.000Z] Running command: "${home}\\AppData\\Local\\pwsh.exe" -Command 'npm run typecheck'`,
  `[2026-11-21T07:48:11.500Z] Command completed: "${home}\\AppData\\Local\\pwsh.exe" -Command 'npm run typecheck' (exit 0)`,
  '[2026-11-21T07:48:12.000Z] Running command: git diff --check',
  '[2026-11-21T07:48:12.500Z] Command completed: git diff --check (exit 0)',
  '[2026-11-21T07:48:20.000Z] Running command: npm run test',
  '[2026-11-21T07:49:00.000Z] Command failed: npm run test (exit 1)',
  '[2026-11-21T07:49:05.000Z] Running command: npm run test -- --reporter=dot',
  '[2026-11-21T07:49:40.000Z] Command failed: npm run test -- --reporter=dot (exit 1)',
  '[2026-11-21T07:50:05.000Z] Review output captured.',
  '',
  '[2026-11-21T07:50:05.000Z] Review output',
  pr34Report,
  '[2026-11-21T07:50:05.500Z] Reviewer finished.',
  '',
  '[2026-11-21T07:50:06.000Z] Final output',
  '[2026-11-21T07:50:06.000Z] Command completed: npm run build (exit 0)',
  pr34Report,
].join('\n');

const admin = { id: 1, login: 'owner', type: 'User' };
const peer = { id: 2, login: 'peer', type: 'User' };
const bot = { id: 41898282, login: 'github-actions[bot]', type: 'Bot' };

// GitHub 상태를 바꾸는 gh 호출(댓글·dispatch·쓰기 API). 관리자 자료 준비 경로에서는 하나도 없어야 한다.
const writes = calls => calls.filter(args => args[0] !== 'api' || args.includes('-X') || args.includes('--method')
  || (args[1] !== 'graphql' && args.includes('-f')) || args.some(value => /^query=\s*mutation/.test(String(value))));

async function setup(t, { report = pr34Report, log = pr34JobLog } = {}) {
  const f = localFixture();
  const { target } = await f.result();
  const directory = mkdtempSync(join(tmpdir(), 'review-attention-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ledgerPath = join(directory, ledgerFileName(target));
  const logPath = join(directory, 'job-1.log');
  if (log !== null) writeFileSync(logPath, log);
  const output = { review: 'Review', threadId: 'thread-1', target: { mode: 'branch', baseRef: target.base }, codex: { status: 0, stdout: report } };
  const job = { id: 'job-1', kind: 'review', status: 'completed', sessionId: 'session-1', threadId: 'thread-1', turnId: 'turn-1',
    createdAt: '2026-11-09T00:00:01Z', completedAt: '2026-11-09T00:01:00Z', result: output, logFile: logPath };
  const calls = { reviews: 0, reads: 0, jobReads: 0 };
  const plugin = args => {
    if (args[0] === 'review') { calls.reviews++; return output; }
    if (args.length === 3) { assert.deepEqual(args, ['result', 'job-1', '--json']); calls.jobReads++; return { job: { status: 'completed' }, storedJob: job }; }
    assert.deepEqual(args, ['result', '--json']); calls.reads++; return { job: { status: 'completed' }, storedJob: job };
  };
  const ghCalls = [];
  const gh = args => { ghCalls.push(args); return f.gh(args); };
  const git = args => args[1] === '--git-path' ? ledgerPath : args.at(-1) === 'HEAD' ? target.head : target.base;
  const outputs = []; const cliOut = []; const cliErr = [];
  const publish = (overrides = {}) => runPluginPublication({ options: { repository: 'owner/repo', number: 1, session: 'session-1' }, gh, git, plugin,
    now: () => '2026-11-09T00:00:00Z', maxPolls: 1, sleep: async () => {}, out: text => outputs.push(JSON.parse(text)), homeDir: home, ...overrides });
  const attention = (...extra) => runAttentionCli({ argv: ['owner/repo', '1', ...extra], gh, git, homeDir: home,
    out: text => cliOut.push(JSON.parse(text)), err: text => cliErr.push(text) });
  const post = (body, user = admin, id = 400) => {
    f.comments.push({ id, user, created_at: '2026-11-10T00:05:00Z', updated_at: '2026-11-10T00:05:00Z', body,
      ...(user.type === 'Bot' ? { performed_via_github_app: { id: 15368 } } : {}), html_url: `https://github.com/owner/repo/pull/1#issuecomment-${id}` });
    return `https://github.com/owner/repo/pull/1#issuecomment-${id}`;
  };
  const files = () => readdirSync(directory).sort();
  return { f, target, directory, ledgerPath, logPath, job, calls, ghCalls, publish, outputs, attention, cliOut, cliErr, post, files };
}

test('정상 리뷰는 job 로그(모든 명령 exit 0)를 대조한 뒤 기존 자동 게시를 유지하고 관리자 초안을 만들지 않음', async t => {
  const report = 'No actionable defects were found. Lint passed. Build and E2E were not run.';
  const s = await setup(t, { report, log: cleanJobLog(report) });
  await assert.rejects(s.publish(), /완료를 확인하지 못함/);
  assert.equal(s.f.dispatches.length, 1);
  const published = await s.f.publish(JSON.parse(readFileSync(s.ledgerPath, 'utf8')).result); s.f.finish(published);
  assert.equal(await s.publish(), 0);
  assert.equal(s.outputs.at(-1).state, 'published-awaiting-human'); assert.equal(s.outputs.at(-1).adminDraft, undefined);
  // job 로그는 게시 요청 전 한 번만 조회·저장한다. 요청 뒤 재실행은 영수증 확인 경로라 다시 조회하지 않는다.
  assert.deepEqual(s.calls, { reviews: 1, reads: 1, jobReads: 1 }); assert.equal(s.f.dispatches.length, 1);
  assert.deepEqual(s.files().filter(name => /attention|job-log|review-gate-/.test(name)), [`${ledgerFileName(s.target)}.job-log.json`]);
  // 이미 게시 요청한 결과는 관리자 초안으로 다시 다루지 않는다.
  assert.equal(await s.attention(), 1); assert.match(s.cliErr.at(-1), /이미 봇 게시를 요청/);
});

test('PR #34 원문: 게시 차단 시 기존 ledger·job 기록으로 관리자 초안을 만들고 원본·리뷰·게시를 바꾸지 않음', async t => {
  const s = await setup(t);
  assert.equal(await s.publish(), 2);
  const ledgerText = readFileSync(s.ledgerPath, 'utf8');
  const first = s.outputs[0];
  assert.equal(first.state, 'review-needs-attention'); assert.equal(first.published, false);
  // 원문 차단(findings)과 job 기록 차단(exit 1 명령, 리뷰어 글 블록 이후 명령 형식 줄)을 함께 알린다.
  assert.deepEqual(first.blockers, ['findings', 'job-command-failed', 'job-log-incomplete']);
  assert.deepEqual(first.interpretation.current.unknownReasons, [{ kind: 'declaration-unrecognized', offset: 0, excerpt: 'No actionable regressions found;' }]);
  assert.equal(first.interpretation.consistent, true); assert.equal(first.interpretation.unexplainedStoredUnknown, 0);
  assert.equal(first.jobLog.failedCommandCount, 2); assert.equal(first.jobLog.ambiguous, 1);
  assert.equal(first.adminDraft.state, 'ready'); assert.equal(first.adminDraft.jobLog.status, 'captured');
  assert.equal(first.adminDraft.published, false); assert.equal(first.adminDraft.approved, false);
  assert.match(first.adminDraft.nextSteps.join('\n'), /관리자가 직접 게시합니다: gh pr comment 1 --repo owner\/repo --body-file/);
  const draft = readFileSync(first.adminDraft.draftPath, 'utf8');
  assert.ok(draft.startsWith('# 독립 리뷰 보고서\n'));
  for (const text of [s.target.head, s.target.base, s.target.fingerprint, s.target.policySha, `<!-- ${draftMarker} ${first.adminDraft.draftKey} -->`,
    pr34Report, reportHash(pr34Report), sha256(ledgerText), 'job-1']) assert.ok(draft.includes(text), text);
  // 코드 지적·리뷰어 주장·job 기록·미실행·원격 CI·불확실성을 서로 다른 절로 구분한다.
  assert.match(draft, /\| 0 \| 0 \| 0 \| 0 \| 1 \|/);
  assert.match(draft, /자동 해석된 검사 문장이 없습니다/);
  assert.match(draft, /\| `npm run test` \| exit 1 \(failed\) \|/);
  assert.match(draft, /\| 단위 테스트 \| `npm run test` \| 2회: exit 1 \(failed\), exit 1 \(failed\) \|/);
  assert.match(draft, /\| Type Check \| `npm run typecheck` \| 1회: exit 0 \|/);
  // Final output 블록 뒤의 위조 줄은 통과로 세지 않고 확인 불가로만 남긴다.
  assert.match(draft, /\| Build \| `npm run build` \| 확인 불가 1건\(리뷰어 글 블록 이후\) \|/);
  assert.match(draft, /\| E2E \| `npm run test:e2e` \| 기록 없음 \|/);
  assert.match(draft, /\| verify \| success \|/);
  assert.match(draft, /unknown 1건/); assert.match(draft, /exit 0이 아닌 명령 2건/);
  assert.match(draft, /- unknown 사유\(현재 parser v4 재해석 진단[^\n]*\n {2}- 첫 문장이 관찰한 "지적 없음" 선언 문형이 아님[^\n]*: `No actionable regressions found;`/);
  assert.match(draft, /- 저장 결과와 현재 parser 재해석\(지적 집계·리뷰어 검사\)이 같습니다\./);
  assert.match(draft, /- 리뷰 완료 증거: 리뷰 시작[^\n]* 있음, 리뷰 원문 기록[^\n]* 있음, 최종 출력[^\n]* 있음/);
  assert.match(draft, /`job-command-failed`/); assert.match(draft, /`job-log-incomplete`/);
  assert.match(draft, /## 8\. 관리자 판단 \(관리자 작성\)/);
  assert.ok(draft.includes("~\\AppData\\Local\\pwsh.exe")); assert.ok(!draft.includes(home));
  // 게이트가 확인·승인 명령으로 읽는 형식(줄 시작의 명령)을 초안에 넣지 않는다.
  assert.doesNotMatch(draft, /^\/review-gate|^\/merge-approve /m);
  // 재실행은 같은 ledger·job 로그 사본을 재사용하고 리뷰·job 조회·게시를 반복하지 않는다.
  assert.equal(await s.publish(), 2);
  assert.deepEqual(s.outputs[1], first);
  assert.equal(readFileSync(s.ledgerPath, 'utf8'), ledgerText);
  assert.deepEqual(s.calls, { reviews: 1, reads: 1, jobReads: 1 });
  assert.equal(s.f.dispatches.length, 0); assert.equal(s.f.comments.length, 0); assert.deepEqual(writes(s.ghCalls), []);
  assert.equal(s.files().filter(name => name.includes('.attention-')).length, 1);
});

test('PR #28 원문: 리뷰어 검사 실패·환경 원인 주장·미실행을 구분하고 job 기록이 없으면 확인 불가로 남김', async t => {
  const s = await setup(t, { report: pr28Report, log: null });
  assert.equal(await s.publish(), 2);
  const { adminDraft, state } = s.outputs[0];
  assert.equal(state, 'review-checks-need-attention'); assert.equal(adminDraft.jobLog.status, 'unavailable');
  const draft = readFileSync(adminDraft.draftPath, 'utf8');
  assert.match(draft, /`reviewer-check-failed`/);
  assert.match(draft, /\| `privacyGuard` \| 실패 \| - \| 환경의 임시 폴더 생성 권한 제한 \(확인 안 됨\) \|/);
  assert.match(draft, /리뷰어가 원문에서 미실행·건너뜀으로 보고: `Build`\(미실행\), `E2E`\(미실행\)/);
  assert.match(draft, /\| Lint \| `npm run lint` \| 확인 불가 \|/);
  assert.match(draft, /job 실행 기록 확인 불가: plugin job 로그 파일을 읽지 못했습니다/);
  assert.match(draft, /환경 원인\("환경의 임시 폴더 생성 권한 제한"\)은 리뷰어의 주장이며 확인되지 않았습니다/);
  assert.equal(s.files().filter(name => name.endsWith('.job-log.json')).length, 0);
  assert.deepEqual(writes(s.ghCalls), []);
});

test('세션이 끝난 뒤 review:attention은 같은 ledger로 초안을 다시 만들고 job 로그 누락·손상은 확인 불가로 표시', async t => {
  const s = await setup(t);
  await s.publish();
  const ledgerText = readFileSync(s.ledgerPath, 'utf8');
  const fromWrapper = s.outputs[0].adminDraft;
  // job 사본이 있으면 wrapper와 같은 초안(같은 파일)을 다시 만든다. 세션 ID나 plugin 호출이 필요 없다.
  assert.equal(await s.attention(), 0);
  assert.equal(s.cliOut[0].state, 'admin-draft-ready'); assert.equal(s.cliOut[0].draftPath, fromWrapper.draftPath);
  assert.equal(s.cliOut[0].draftKey, fromWrapper.draftKey);
  unlinkSync(`${s.ledgerPath}.job-log.json`);
  assert.equal(await s.attention(), 0);
  assert.equal(s.cliOut[1].jobLog.status, 'missing'); assert.notEqual(s.cliOut[1].draftPath, fromWrapper.draftPath);
  assert.equal(s.cliOut[1].draftKey, fromWrapper.draftKey);
  assert.match(readFileSync(s.cliOut[1].draftPath, 'utf8'), /job 로그 사본이 없습니다/);
  writeFileSync(`${s.ledgerPath}.job-log.json`, JSON.stringify({ v: 1, id: 'job-other', log: 'x', logSha256: sha256('x') }));
  assert.equal(await s.attention(), 0);
  assert.equal(s.cliOut[2].jobLog.status, 'invalid');
  assert.equal(readFileSync(s.ledgerPath, 'utf8'), ledgerText);
  assert.deepEqual(s.calls, { reviews: 1, reads: 1, jobReads: 1 }); assert.deepEqual(writes(s.ghCalls), []);
});

test('review:attention은 실행 중·v2 복구·복구 연결 불일치·차단되지 않은 결과에서 자료를 만들지 않음', async t => {
  await t.test('lock', async t => {
    const s = await setup(t); await s.publish();
    writeFileSync(`${s.ledgerPath}.lock`, '');
    assert.equal(await s.attention(), 1); assert.match(s.cliErr.at(-1), /lock/);
  });
  await t.test('v2 recovery', async t => {
    const s = await setup(t); await s.publish();
    writeFileSync(`${s.ledgerPath}.recovered.json`, '{}');
    assert.equal(await s.attention(), 1); assert.match(s.cliErr.at(-1), /v2/);
  });
  await t.test('v3 recovery link', async t => {
    const s = await setup(t); await s.publish();
    const ledger = JSON.parse(readFileSync(s.ledgerPath, 'utf8'));
    writeFileSync(`${s.ledgerPath}.recovered.v3.json`, JSON.stringify({ ...ledger, recovery: { originalLedgerHash: '0'.repeat(64), parserVersion: 3 } }));
    assert.equal(await s.attention(), 1); assert.match(s.cliErr.at(-1), /복구 연결/);
  });
  await t.test('not blocked', async t => {
    const s = await setup(t);
    const result = await s.f.result();
    writeFileSync(s.ledgerPath, JSON.stringify({ state: 'completed', target: result.target, session: 'session-1', result }));
    // 원문이 깨끗해도 job 로그 사본이 없으면 확인 불가로 차단된 결과다.
    assert.equal(await s.attention(), 0); assert.deepEqual(s.cliOut.at(-1).blockers, ['job-log-unverified']);
    assert.equal(s.cliOut.at(-1).blockedState, 'review-job-log-needs-attention');
    // 원문과 대조된 깨끗한 job 로그 사본이 있으면 차단 사유가 없어 기존 게시 흐름을 안내한다.
    const log = cleanJobLog(result.report);
    const { source } = result;
    writeFileSync(`${s.ledgerPath}.job-log.json`, JSON.stringify({ v: 1, id: source.jobId, threadId: source.threadId, turnId: source.turnId,
      completedAt: source.completedAt, outputHash: source.outputHash, capturedAt: '2026-11-09T00:02:00Z', logSha256: sha256(log), log }));
    assert.equal(await s.attention(), 1); assert.match(s.cliErr.at(-1), /review:publish/);
    assert.equal(await s.attention('--confirm', '400'), 1); assert.match(s.cliErr.at(-1), /review:publish/);
  });
  await t.test('no ledger', async t => {
    const s = await setup(t);
    assert.equal(await s.attention(), 1); assert.match(s.cliErr.at(-1), /완료 ledger가 없습니다/);
    assert.deepEqual(s.calls, { reviews: 0, reads: 0, jobReads: 0 });
  });
});

test('관리자가 직접 게시한 초안으로 기존 게이트 형식의 /review-gate 문구만 만들고 게시·승인하지 않음', async t => {
  const s = await setup(t); await s.publish();
  const ledgerText = readFileSync(s.ledgerPath, 'utf8');
  const body = readFileSync(s.outputs[0].adminDraft.draftPath, 'utf8').replace('- 판단 메모: (작성)', '- 판단 메모: 원격 CI 성공과 job 기록을 확인함');
  const url = s.post(body);
  assert.equal(await s.attention('--confirm', url), 0);
  const prepared = s.cliOut.at(-1);
  assert.equal(prepared.state, 'awaiting-admin-post'); assert.equal(prepared.published, false); assert.equal(prepared.approved, false);
  assert.deepEqual(prepared.confirmation, { fingerprint: s.target.fingerprint, decision: 'pass', reviewer: 'codex', reviewComplete: true,
    evidence: url, evidenceHash: reportHash(body), findings: { critical: 0, high: 0, medium: 0, low: 0, unknown: 1 } });
  assert.equal(readFileSync(prepared.confirmationPath, 'utf8'), `${prepared.text}\n`);
  assert.match(prepared.text, /^\/review-gate\n```json\n/);
  // 도구는 확인 댓글을 쓰지 않는다. 관리자가 게시하기 전 게이트는 실패 상태다.
  assert.equal((await s.f.collect()).packet.gate.state, 'failure');
  assert.equal(s.f.comments.length, 1); assert.deepEqual(writes(s.ghCalls), []); assert.equal(s.f.dispatches.length, 0);
  s.post(readFileSync(prepared.confirmationPath, 'utf8'), admin, 401);
  assert.equal((await s.f.collect()).packet.gate.state, 'success');
  // 다시 실행하면 같은 확인 댓글을 알려 주고 새 파일·게시를 만들지 않는다.
  const before = s.files();
  assert.equal(await s.attention('--confirm', '400'), 0);
  assert.equal(s.cliOut.at(-1).state, 'already-confirmed'); assert.equal(s.cliOut.at(-1).existingConfirmationId, 401);
  assert.equal(s.cliOut.at(-1).confirmationPath, prepared.confirmationPath); assert.deepEqual(s.files(), before);
  assert.equal(readFileSync(s.ledgerPath, 'utf8'), ledgerText); assert.deepEqual(s.calls, { reviews: 1, reads: 1, jobReads: 1 });
  // PR #37 리뷰 지적: 같은 확인 뒤에 더 최근 관리자 `/review-gate`(거부)가 있으면 게이트는 최신 댓글만 읽어 실패한다.
  // 이때 완료로 안내하지 않고 다시 게시가 필요하다고 알려야 한다.
  s.post(`/review-gate\n\`\`\`json\n${JSON.stringify({ ...prepared.confirmation, decision: 'fail' })}\n\`\`\``, admin, 402);
  assert.equal((await s.f.collect()).packet.gate.state, 'failure');
  assert.equal(await s.attention('--confirm', '400'), 0);
  assert.equal(s.cliOut.at(-1).state, 'awaiting-admin-post'); assert.equal(s.cliOut.at(-1).existingConfirmationId, null);
  assert.match(s.cliOut.at(-1).nextSteps[0], /관리자가 내용을 확인한 뒤 직접 게시합니다/);
  // 쓰기 권한 사용자의 같은 내용 댓글은 게이트가 읽지 않으므로 완료로 보지 않는다.
  s.post(readFileSync(prepared.confirmationPath, 'utf8'), peer, 403);
  assert.equal(await s.attention('--confirm', '400'), 0);
  assert.equal(s.cliOut.at(-1).state, 'awaiting-admin-post');
  assert.deepEqual(writes(s.ghCalls), []);
});

test('잘못된 승인 시도는 /review-gate 문구를 만들지 않음', async t => {
  const refused = async (t, { report, prepare, ref = 'url', pattern }) => {
    const s = await setup(t, report ? { report } : {});
    assert.equal(await s.publish(), 2);
    const ledgerText = readFileSync(s.ledgerPath, 'utf8');
    const draft = readFileSync(s.outputs[0].adminDraft.draftPath, 'utf8');
    const url = await prepare(s, draft);
    const before = s.files();
    assert.equal(await s.attention('--confirm', ref === 'url' ? url : ref), 1);
    assert.match(s.cliErr.at(-1), pattern);
    assert.equal(s.cliOut.length, 0); assert.deepEqual(s.files(), before); assert.equal(readFileSync(s.ledgerPath, 'utf8'), ledgerText);
    assert.deepEqual(writes(s.ghCalls), []); assert.equal(s.calls.reviews, 1);
  };
  await t.test('쓰기 권한 사용자', t => refused(t, { prepare: (s, d) => s.post(d, peer), pattern: /관리자\(admin\/maintain\)/ }));
  await t.test('봇 댓글', t => refused(t, { prepare: (s, d) => s.post(d, bot), pattern: /관리자\(admin\/maintain\)/ }));
  await t.test('marker 삭제', t => refused(t, { prepare: (s, d) => s.post(d.replace(/<!-- photo-selector-admin-review-draft:v1 [a-f0-9]+ -->\n/, '')), pattern: /marker/ }));
  await t.test('원문 변경', t => refused(t, { prepare: (s, d) => s.post(d.replace('one suite failed', 'all suites passed')), pattern: /marker/ }));
  await t.test('제목 변경', t => refused(t, { prepare: (s, d) => s.post(d.replace('# 독립 리뷰 보고서', '# 리뷰 메모')), pattern: /marker/ }));
  await t.test('다른 PR 링크', t => refused(t, { prepare: (s, d) => { s.post(d); }, ref: 'https://github.com/owner/repo/pull/2#issuecomment-400', pattern: /marker/ }));
  await t.test('없는 댓글', t => refused(t, { prepare: (s, d) => { s.post(d); }, ref: '999', pattern: /marker/ }));
  await t.test('게시 뒤 head 변경', t => refused(t, { prepare: (s, d) => { const url = s.post(d); s.f.fake.store.head = 'e'.repeat(40); return url; }, pattern: /현재 PR 대상/ }));
  await t.test('차단 지적', t => refused(t, { report: 'No findings. [P1] Export drops original bytes.', prepare: (s, d) => s.post(d), pattern: /critical\/high\/medium/ }));
  await t.test('필수 CI 실패', t => refused(t, { prepare: (s, d) => { s.f.ci.check = { conclusion: 'failure' }; s.f.ci.run = { conclusion: 'failure' }; return s.post(d); }, pattern: /필수 CI/ }));
  await t.test('봇 보고서 존재', t => refused(t, { prepare: async (s, d) => {
    await s.f.publish(JSON.parse(readFileSync(s.ledgerPath, 'utf8')).result); return s.post(d);
  }, pattern: /봇 보고서/ }));
});

test('차단 지적이 있는 초안은 통과 확인 대신 수정·재리뷰를 안내', async t => {
  const s = await setup(t, { report: 'No findings. [P1] Export drops original bytes.' });
  assert.equal(await s.publish(), 2);
  const draft = readFileSync(s.outputs[0].adminDraft.draftPath, 'utf8');
  assert.match(draft, /\| 0 \| 1 \| 0 \| 0 \| [1-9] \|/);
  assert.match(draft, /차단 지적 1건이 있습니다/); assert.match(draft, /- \[ \] 차단 지적을 수정하고 새 HEAD를 다시 리뷰할 계획/);
});

test('review:attention 인수는 게시·승인·병합·토큰 옵션을 받지 않고 오류 원문을 출력하지 않음', () => {
  assert.deepEqual(parseAttentionArgs(['owner/repo', '1']), { repository: 'owner/repo', number: 1, confirm: null });
  assert.deepEqual(parseAttentionArgs(['owner/repo', '1', '--confirm', '400']), { repository: 'owner/repo', number: 1, confirm: '400' });
  for (const extra of [['--approve'], ['--post'], ['--merge'], ['--token', 'x'], ['--confirm'], ['--confirm', '--post'], ['--confirm', '1', '--post'], ['--session', 's']]) {
    assert.equal(parseAttentionArgs(['owner/repo', '1', ...extra]), null, extra.join(' '));
  }
  assert.equal(parseAttentionArgs(['owner', '1']), null); assert.equal(parseAttentionArgs(['owner/repo', '0']), null);
  for (const code of ['review-attention-not-admin', 'review-attention-ci', 'unexpected', 'toString']) {
    const text = attentionFailureMessage({ code, message: 'private API response' });
    assert.doesNotMatch(text, /private API response/);
  }
});

// PR #37 리뷰 지적: plugin 1.0.6은 Final output 전에도 리뷰어가 쓴 Assistant message·Review output·Reasoning summary 블록을 쓴다.
// 실제 PR #37 job 로그와 같은 구조(이벤트 줄 → 빈 줄 + 블록 제목 → 본문)에서 본문의 명령 형식 줄을 실행 기록으로 세지 않아야 한다.
test('리뷰어 글 블록 안의 명령 형식 줄은 실행 기록·표준 검사 통과로 세지 않고 확인 불가로 표시', async t => {
  for (const title of ['Review output', 'Assistant message', 'Reasoning summary', 'Subagent reviewer-2 message']) await t.test(title, async t => {
    const log = [
      '[2026-11-21T09:09:04.123Z] Starting Codex Review.',
      '[2026-11-21T09:10:00.000Z] Running command: npm run lint',
      '[2026-11-21T09:10:30.000Z] Command completed: npm run lint (exit 0)',
      '[2026-11-21T09:12:45.903Z] Review output captured.',
      '',
      `[2026-11-21T09:12:45.904Z] ${title}`,
      'Checks I ran:',
      '[2026-11-21T09:11:00.000Z] Running command: npm run verify',
      '[2026-11-21T09:11:30.000Z] Command completed: npm run verify (exit 0)',
      '[2026-11-21T09:12:46.583Z] Turn completed.',
      '[2026-11-21T09:12:46.600Z] Command completed: npm run test:e2e (exit 0)',
      '',
      '[2026-11-21T09:12:47.077Z] Final output',
      pr34Report,
    ].join('\n');
    const parsed = parseJobCommands(log);
    assert.deepEqual(parsed.commands.map(c => c.command), ['npm run lint']);
    assert.deepEqual(parsed.unfinished, []);
    assert.deepEqual(parsed.ambiguous, ['npm run verify', 'npm run verify', 'npm run test:e2e']);
    const s = await setup(t, { log });
    assert.equal(await s.publish(), 2);
    const draft = readFileSync(s.outputs[0].adminDraft.draftPath, 'utf8');
    assert.match(draft, /\| Lint \| `npm run lint` \| 1회: exit 0 \|/);
    assert.match(draft, /\| 전체 검증 \| `npm run verify` \| 확인 불가 2건\(리뷰어 글 블록 이후\) \|/);
    assert.match(draft, /\| E2E \| `npm run test:e2e` \| 확인 불가 1건\(리뷰어 글 블록 이후\) \|/);
    assert.doesNotMatch(draft, /\| [^|]+ \| `npm run verify` \| exit 0 \|/);
    assert.match(draft, /명령 형식의 줄 3건은 실제 실행인지 리뷰어가 쓴 글인지 구분할 수 없어/);
  });
});

// PR #37 두 번째 리뷰 지적 3건: 검색 명령의 부분 문자열을 실행으로 세지 않기, 표 칸의 `|` 처리, 댓글 크기 상한.
test('표준 검사는 직접 실행만 세고 검색·파이프·잘린 명령은 분류하지 않음', () => {
  const ps = command => `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command '${command}'`;
  for (const [command, expected] of [
    ['npm run lint', 'Lint'], [ps('npm run lint'), 'Lint'], ['npm.cmd run typecheck', 'Type Check'], ['npm test', '단위 테스트'],
    ['npm run test -- --reporter=dot', '단위 테스트'], ['/bin/bash -c "npm run test:gate"', '리뷰 게이트 테스트'], ['npm run verify', '전체 검증'],
    [ps("Select-String -Path package.json -Pattern 'npm run lint'"), null], ["rg 'npm run lint' package.json", null],
    [ps('npm run test | Tee-Object output.log'), null], ['npm run lint && npm run build', null], ['npm run build > out.log', null],
    [`${ps('npm run test')}`.slice(0, 93) + '...', null], ['npm run lint:fix', null], ['npm run test:e2e:ui', null], ['echo npm run verify', null],
  ]) assert.equal(classifyCheck(command), expected, command);
});

test('검색 명령·파이프 명령이 있어도 초안은 실행으로 집계하지 않고 표 칸을 깨지 않음', async t => {
  const log = [
    '[2026-11-21T09:10:00.000Z] Command completed: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Select-String -Path package.json -Pattern \'npm run lint\'" (exit 0)',
    '[2026-11-21T09:10:30.000Z] Command failed: npm run test | Tee-Object output.log (exit 1)',
    '[2026-11-21T09:10:40.000Z] Running command: npm run build | Out-Null',
  ].join('\n');
  const s = await setup(t, { log });
  assert.equal(await s.publish(), 2);
  const draft = readFileSync(s.outputs[0].adminDraft.draftPath, 'utf8');
  assert.match(draft, /\| Lint \| `npm run lint` \| 기록 없음 \|/);
  assert.match(draft, /\| 단위 테스트 \| `npm run test` \| 기록 없음 \|/);
  // 명령 칸 안의 `|`는 `\|`로 표시해 결과(exit) 칸이 밀리지 않는다. 각 표 행의 칸 구분자는 정확히 4개다.
  const row = draft.split('\n').find(line => line.includes('Tee-Object'));
  assert.equal(row, '| 2026-11-21T09:10:30.000Z | `npm run test \\| Tee-Object output.log` | exit 1 (failed) |');
  assert.equal(row.replace(/\\\|/g, '').split('|').length - 1, 4);
  assert.match(draft, /- 완료 기록 없음: `npm run build \| Out-Null`/);
});

test('초안은 명령 목록이 많아도 GitHub 댓글 상한 안에 들어가고 원문·marker·대상은 유지', async t => {
  const fill = n => Array.from({ length: n }, (_, i) => `[2026-11-21T09:11:00.000Z] Command completed: npm run verify ${'x'.repeat(60)}${i} (exit 0)`);
  const log = [
    '[2026-11-21T09:10:00.000Z] Command completed: npm run lint (exit 0)',
    ...Array.from({ length: 600 }, (_, i) => `[2026-11-21T09:10:01.000Z] Running command: npm run e2e ${'y'.repeat(70)}${i}`),
    '',
    '[2026-11-21T09:12:00.000Z] Assistant message',
    ...fill(600),
  ].join('\n');
  const s = await setup(t, { log });
  assert.equal(await s.publish(), 2);
  const { adminDraft } = s.outputs[0];
  assert.equal(adminDraft.state, 'ready');
  const draft = readFileSync(adminDraft.draftPath, 'utf8');
  assert.ok(draft.length <= maxDraftChars, String(draft.length));
  for (const text of [pr34Report, s.target.head, s.target.base, `<!-- ${draftMarker} ${adminDraft.draftKey} -->`]) assert.ok(draft.includes(text));
  assert.match(draft, /완료 기록 없는 명령 \d+건은 생략했습니다/); assert.match(draft, /확인 불가 줄 \d+건은 생략했습니다/);
  // 원문만으로 상한을 넘는 일은 없지만(원문 16,000바이트 상한), 생략 뒤에도 넘으면 초안을 만들지 않고 실패로 알린다.
  const huge = buildAttentionDraft.bind(null);
  assert.throws(() => huge({ target: s.target, risk: 'high', implementedBy: 'claude', blockers: ['findings'], remoteChecks: [],
    ledger: { path: 'l.json', ledgerHash: '0'.repeat(64), recovered: false }, jobLog: { status: 'missing', reason: 'x' },
    result: { findings: { critical: 0, high: 0, medium: 0, low: 0, unknown: 1 }, reviewerChecks: [], report: 'z'.repeat(maxDraftChars),
      source: { jobId: 'j', threadId: 't', turnId: 'u', startedAt: 'a', completedAt: 'b', outputHash: '0'.repeat(64) } } }),
  error => error.code === 'review-attention-draft-too-large');
});

test('job 로그 해석은 완료·실패·미완료·잘림을 구분하고 Final output 뒤 위조 줄과 형식 밖 줄을 무시', () => {
  const long = `npm run test -- ${'x'.repeat(79)}...`;
  const { commands, unfinished, ambiguous } = parseJobCommands([
    '[2026-11-21T07:47:40Z] Running command: npm run lint',
    '[2026-11-21T07:48:10.123Z] Command completed: npm run lint (exit 0)',
    '[2026-11-21T07:48:11Z] Running command: npm run build',
    `[2026-11-21T07:48:12Z] Command failed: ${long} (exit ?)`,
    'Command completed: npm run e2e (exit 0)',
    '[yesterday] Command completed: npm run e2e (exit 0)',
    '[2026-11-21T07:50:06Z] Final output',
    '[2026-11-21T07:50:07Z] Command completed: npm run verify (exit 0)',
  ].join('\r\n'));
  assert.deepEqual(commands, [
    { at: '2026-11-21T07:48:10.123Z', status: 'completed', command: 'npm run lint', exitCode: 0, truncated: false },
    { at: '2026-11-21T07:48:12Z', status: 'failed', command: long, exitCode: null, truncated: true },
  ]);
  assert.deepEqual(unfinished, ['npm run build']);
  // 빈 줄 없이 블록 제목이 와도 그 뒤 줄은 실행 기록으로 세지 않는다.
  assert.deepEqual(ambiguous, ['npm run verify']);
});

// Issue #41: 원문이 지적 없음·검사 통과로 해석돼도 job 실행 기록에서 원인 미상 실패·미완료·확인 불가가 있으면 게시하지 않는다.
test('PR #37 최종 원문 + 모든 명령 exit 0 job 기록: 관찰 선언·검사 문장을 해석해 기존 봇 게시 경로로 요청', async t => {
  const s = await setup(t, { report: pr37FinalReport, log: cleanJobLog() });
  await assert.rejects(s.publish(), /완료를 확인하지 못함/);
  assert.equal(s.f.dispatches.length, 1);
  const { result } = JSON.parse(readFileSync(s.ledgerPath, 'utf8'));
  assert.deepEqual(result.findings, { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 });
  // 미실행은 미실행으로 남는다. 통과로 바꾸지 않는다.
  assert.deepEqual(result.reviewerChecks.map(c => [c.name, c.status]), [['All 127 targeted tests', 'passed'], ['the full verification suite', 'not-run']]);
  // 서버도 같은 parser로 다시 해석해 같은 결과를 받아들인다.
  const published = await s.f.publish(s.f.dispatches[0].result); s.f.finish(published);
  assert.equal(await s.publish(), 0);
  assert.equal(s.outputs.at(-1).state, 'published-awaiting-human');
  assert.deepEqual(s.calls, { reviews: 1, reads: 1, jobReads: 1 }); assert.equal(s.f.comments.length, 1);
  assert.equal(s.files().filter(name => name.includes('.attention-')).length, 0);
});

test('PR #40 최종 원문 + 실제 exit 1 job 기록: 선언 문법 차단과 job 명령 실패를 함께 남기고 게시하지 않음', async t => {
  const s = await setup(t, { report: pr40FinalReport, log: pr40FinalJobLog() });
  assert.equal(await s.publish(), 2);
  const [output] = s.outputs;
  assert.equal(output.state, 'review-needs-attention'); assert.deepEqual(output.blockers, ['findings', 'job-command-failed']);
  assert.deepEqual(output.interpretation.current.unknownReasons, [{ kind: 'declaration-unrecognized', offset: 0,
    excerpt: 'No actionable regressions were identified in the documentation reorganization or configuration changes.' }]);
  assert.equal(output.jobLog.status, 'captured'); assert.equal(output.jobLog.failedCommandCount, 2);
  assert.deepEqual(output.jobLog.failedCommands.map(c => [c.exitCode, c.status, c.truncated]), [[1, 'failed', true], [1, 'failed', true]]);
  const draft = readFileSync(output.adminDraft.draftPath, 'utf8');
  assert.equal((draft.match(/\| exit 1 \(failed\) \|/g) ?? []).length, 2);
  assert.match(draft, /`job-command-failed`: job 기록에 exit 0이 아니거나/);
  assert.equal(s.f.dispatches.length, 0); assert.equal(s.f.comments.length, 0); assert.deepEqual(writes(s.ghCalls), []);
});

test('해석 가능한 지적 없음 원문이라도 job 기록의 실패·종료 코드 없음·미완료·확인 불가·완료 증거 없음·로그 없음은 게시하지 않고 관리자 초안으로 넘김', async t => {
  const event = (at, text) => `[2026-11-22T02:43:${at}.000Z] ${text}`;
  const report = pr37FinalReport;
  const cases = [
    ['exit 1', pr40FinalJobLog(report), ['job-command-failed']],
    ['exit ?', completeJobLog(report, [event('00', 'Running command: npm run lint'), event('01', 'Command failed: npm run lint (exit ?)')]), ['job-command-failed']],
    ['declined', completeJobLog(report, [event('00', 'Running command: npm run lint'), event('01', 'Command declined: npm run lint (exit 0)')]), ['job-command-failed']],
    ['unfinished', completeJobLog(report, [event('00', 'Running command: npm run test')]), ['job-log-incomplete']],
    ['ambiguous', completeJobLog(report, [], ['', event('50', 'Assistant message'), event('51', 'Command completed: npm run verify (exit 0)')]), ['job-log-incomplete']],
    // PR #42 독립 검토 지적: 아래 로그는 명령 목록이 비어 이전에는 차단 사유가 없었다. 완료 증거가 없으면 기록 유실·잘림으로 보고 차단한다.
    ['empty log', '', ['job-log-not-completed']],
    ['start events only', `${jobLogStart.join('\n')}\n`, ['job-log-not-completed']],
    ['cut before review output', [...jobLogStart, event('00', 'Running command: npm run lint'), event('01', 'Command completed: npm run lint (exit 0)')].join('\n'), ['job-log-not-completed']],
    ['cut before final output', [...jobLogStart, ...jobLogEnd(report).slice(0, 5)].join('\n'), ['job-log-not-completed']],
    ['other job review output', completeJobLog(pr40FinalReport), ['job-log-not-completed']],
    ['no job start', jobLogEnd(report).join('\n'), ['job-log-not-completed']],
    ['block after final output', `${completeJobLog(report)}\n[2026-11-22T02:44:33.000Z] Assistant message\nlate text`, ['job-log-not-completed']],
    ['failed and cut', [...jobLogStart, event('00', 'Running command: npm run lint'), event('01', 'Command failed: npm run lint (exit 1)'), event('02', 'Running command: npm run test')].join('\n'),
      ['job-command-failed', 'job-log-incomplete', 'job-log-not-completed']],
    ['no log', null, ['job-log-unverified']],
  ];
  for (const [name, log, blockers] of cases) await t.test(name, async t => {
    const s = await setup(t, { report: pr37FinalReport, log });
    assert.equal(await s.publish(), 2);
    const ledgerText = readFileSync(s.ledgerPath, 'utf8');
    const [output] = s.outputs;
    assert.equal(output.state, 'review-job-log-needs-attention'); assert.deepEqual(output.blockers, blockers);
    assert.deepEqual(output.codeFindings, { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }); assert.deepEqual(output.interpretation.current.unknownReasons, []);
    assert.equal(output.published, false); assert.equal(output.adminDraft.state, 'ready');
    if (log !== null) assert.equal(output.jobLog.completed, !blockers.includes('job-log-not-completed'));
    const draft = readFileSync(output.adminDraft.draftPath, 'utf8');
    for (const blocker of blockers) assert.ok(draft.includes(`\`${blocker}\``), blocker);
    if (blockers.includes('job-log-not-completed')) assert.match(draft, /job 로그에 리뷰 완료 증거가 모두 있지 않아 기록 유실·잘림/);
    // 재실행해도 리뷰·게시를 반복하지 않고 같은 결과를 낸다. 완료 ledger는 바뀌지 않는다.
    assert.equal(await s.publish(), 2); assert.deepEqual(s.outputs[1], output);
    assert.equal(readFileSync(s.ledgerPath, 'utf8'), ledgerText);
    assert.equal(s.calls.reviews, 1); assert.equal(s.f.dispatches.length, 0); assert.equal(s.f.comments.length, 0); assert.deepEqual(writes(s.ghCalls), []);
    // 세션이 끝난 뒤 review:attention도 같은 차단 사유를 낸다. job 사본이 있으면 같은 초안을 다시 만든다
    // (로그가 없으면 wrapper는 "조회 불가", CLI는 "사본 없음"으로 사유 문구가 달라 초안 파일도 다르다).
    assert.equal(await s.attention(), 0);
    assert.deepEqual(s.cliOut.at(-1).blockers, blockers);
    if (log !== null) assert.equal(s.cliOut.at(-1).draftPath, output.adminDraft.draftPath);
  });
  // 관리자가 초안을 직접 게시하면 기존 확인 경로를 쓸 수 있다. 판단은 관리자가 하며 도구는 게시·승인하지 않는다.
  await t.test('admin confirm', async t => {
    const s = await setup(t, { report: pr37FinalReport, log: pr40FinalJobLog(pr37FinalReport) });
    assert.equal(await s.publish(), 2);
    const url = s.post(readFileSync(s.outputs[0].adminDraft.draftPath, 'utf8'));
    assert.equal(await s.attention('--confirm', url), 0);
    assert.equal(s.cliOut.at(-1).state, 'awaiting-admin-post'); assert.equal(s.cliOut.at(-1).approved, false);
    assert.deepEqual(writes(s.ghCalls), []);
  });
});

test('job 기록 차단 사유는 확인된 사본에 완료 증거가 모두 있고 모든 명령이 exit 0으로 완료되고 미완료·확인 불가 줄이 없을 때만 비어 있음', () => {
  const done = { reviewStarted: true, reviewOutput: true, finalOutput: true };
  const captured = (commands = [], unfinished = [], ambiguous = [], completion = done) => ({ status: 'captured', commands, unfinished, ambiguous, completion });
  const ok = { status: 'completed', exitCode: 0 };
  assert.deepEqual(jobLogBlockers(captured([ok, ok])), []);
  // 명령 0건은 완료 증거가 있을 때만 정상 종료다. 개수만으로 성공·실패를 정하지 않는다.
  assert.deepEqual(jobLogBlockers(captured()), []);
  for (const missing of ['reviewStarted', 'reviewOutput', 'finalOutput']) {
    assert.deepEqual(jobLogBlockers(captured([], [], [], { ...done, [missing]: false })), ['job-log-not-completed'], missing);
    assert.deepEqual(jobLogBlockers(captured([ok], [], [], { ...done, [missing]: false })), ['job-log-not-completed'], missing);
  }
  assert.deepEqual(jobLogBlockers(captured([], [], [], null)), ['job-log-not-completed']);
  assert.deepEqual(jobLogBlockers({ status: 'captured', ...parseJobCommands('', pr37FinalReport) }), ['job-log-not-completed']);
  assert.deepEqual(jobLogBlockers({ status: 'captured', ...parseJobCommands(completeJobLog(pr37FinalReport), pr37FinalReport) }), []);
  // 원문 없이 해석하면 원문 일치를 확인할 수 없어 완료로 보지 않는다.
  assert.deepEqual(jobLogBlockers({ status: 'captured', ...parseJobCommands(completeJobLog(pr37FinalReport)) }), ['job-log-not-completed']);
  for (const status of ['missing', 'invalid', 'unavailable', undefined]) assert.deepEqual(jobLogBlockers({ status }), ['job-log-unverified']);
  assert.deepEqual(jobLogBlockers(null), ['job-log-unverified']);
  assert.deepEqual(jobLogBlockers(captured([ok, { status: 'completed', exitCode: 2 }])), ['job-command-failed']);
  assert.deepEqual(jobLogBlockers(captured([{ status: 'completed', exitCode: null }])), ['job-command-failed']);
  assert.deepEqual(jobLogBlockers(captured([{ status: 'failed', exitCode: 0 }])), ['job-command-failed']);
  assert.deepEqual(jobLogBlockers(captured([ok], ['npm run test'])), ['job-log-incomplete']);
  assert.deepEqual(jobLogBlockers(captured([ok], [], ['npm run verify'])), ['job-log-incomplete']);
  assert.deepEqual(jobLogBlockers(captured([{ status: 'failed', exitCode: 1 }], ['x'])), ['job-command-failed', 'job-log-incomplete']);
});

// PR #42 독립 검토 지적 1: 명령 0건만으로 판단하지 않는다. 완료 증거가 모두 있으면 명령 없이 끝난 리뷰는 기존 게시 경로를 쓴다.
test('완료 증거가 있는 명령 0건 job은 정상 종료로 보고 기존 게시를 요청하며 원문의 미실행은 미실행으로 남김', async t => {
  const report = 'No actionable defects were found. Build and E2E were not run.';
  const s = await setup(t, { report, log: completeJobLog(report) });
  await assert.rejects(s.publish(), /완료를 확인하지 못함/);
  assert.equal(s.f.dispatches.length, 1);
  const ledger = JSON.parse(readFileSync(s.ledgerPath, 'utf8'));
  assert.equal(ledger.parserVersion, 4); assert.equal(ledger.publicationRequested, true);
  assert.deepEqual(ledger.result.reviewerChecks.map(c => [c.name, c.status]), [['Build', 'not-run'], ['E2E', 'not-run']]);
  const published = await s.f.publish(s.f.dispatches[0].result); s.f.finish(published);
  assert.equal(await s.publish(), 0); assert.equal(s.f.dispatches.length, 1); assert.equal(s.f.comments.length, 1);
  assert.deepEqual(s.calls, { reviews: 1, reads: 1, jobReads: 1 });
});

// PR #42 독립 검토 지적 2·3: 이전 parser(v3)로 저장한 완료 ledger. 실제 PR #37 최종 ledger(1118f8f)와 같이 unknown 1·검사 기록 없음으로 저장돼 있고
// 현재 parser는 같은 원문을 unknown 0·검사 2건으로 해석한다. 이전에는 wrapper·review:attention 모두 "원문과 다른 리뷰어 검사 기록"으로 실패했다.
async function oldParserLedger(t, { report = pr37FinalReport, log = completeJobLog(report), mutate = () => {}, recovered = false } = {}) {
  const s = await setup(t, { report, log });
  const current = collectPluginResult({ output: s.job.result, stored: { job: { status: 'completed' }, storedJob: s.job }, target: s.target,
    session: 'session-1', startedAt: '2026-11-09T00:00:00Z', checks: [] });
  const result = { ...current, findings: { ...current.findings, unknown: 1 }, reviewerChecks: [] };
  const ledger = { state: 'completed', target: s.target, session: 'session-1', result }; mutate(ledger);
  const originalText = JSON.stringify(ledger);
  writeFileSync(s.ledgerPath, originalText);
  let recoveredText = null;
  if (recovered) {
    recoveredText = JSON.stringify({ ...ledger, recovery: { originalLedgerHash: sha256(originalText), legacyRecoveredHash: null, parserVersion: 3 } });
    writeFileSync(`${s.ledgerPath}.recovered.v3.json`, recoveredText);
  }
  const unchanged = () => {
    assert.equal(readFileSync(s.ledgerPath, 'utf8'), originalText);
    if (recovered) assert.equal(readFileSync(`${s.ledgerPath}.recovered.v3.json`, 'utf8'), recoveredText);
  };
  return { ...s, result, unchanged };
}

test('이전 parser로 저장한 v3 ledger는 재해석으로 바꾸거나 게시하지 않고 parser-mismatch 관리자 초안으로 넘기며 저장 unknown을 유지', async t => {
  const recoverOptions = { options: { repository: 'owner/repo', number: 1, session: 'session-1', recover: true } };
  await t.test('원래 ledger', async t => {
    const s = await oldParserLedger(t);
    assert.equal(await s.publish(), 2);
    const [output] = s.outputs;
    assert.equal(output.state, 'review-needs-attention'); assert.deepEqual(output.blockers, ['findings', 'parser-mismatch']);
    // 저장 결과(리뷰 당시)와 현재 재해석을 다른 필드로 구분한다. 사유를 재현할 수 없는 저장 unknown도 지우지 않는다.
    assert.deepEqual(output.codeFindings, { critical: 0, high: 0, medium: 0, low: 0, unknown: 1 });
    assert.deepEqual(output.interpretation.stored, { parserVersion: null, findings: { critical: 0, high: 0, medium: 0, low: 0, unknown: 1 } });
    assert.deepEqual(output.interpretation.current.findings, { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 });
    assert.equal(output.interpretation.current.parserVersion, 4); assert.deepEqual(output.interpretation.current.unknownReasons, []);
    assert.equal(output.interpretation.current.reviewerChecksMatch, false); assert.equal(output.interpretation.consistent, false);
    assert.equal(output.interpretation.unexplainedStoredUnknown, 1); assert.equal(output.interpretation.effectiveFindings.unknown, 1);
    assert.deepEqual(output.reviewerChecks, []); assert.equal(output.jobLog.completed, true);
    const draft = readFileSync(output.adminDraft.draftPath, 'utf8');
    assert.match(draft, /\| 리뷰 당시 저장 결과 \(parser 버전 기록 없음[^|]*\| 0 \| 0 \| 0 \| 0 \| 1 \|/);
    assert.match(draft, /\| 현재 parser v4 재해석 \(참고, 저장 결과를 바꾸지 않음\) \| 0 \| 0 \| 0 \| 0 \| 0 \|/);
    assert.match(draft, /저장 결과와 현재 parser 재해석이 다릅니다\(`parser-mismatch`\)/);
    assert.match(draft, /저장된 unknown 1건 중 1건은 현재 parser로 사유를 재현할 수 없습니다\. 리뷰 당시 판정이므로 유지하며/);
    assert.match(draft, /- 자동 해석된 검사 문장이 없습니다/); assert.match(draft, /\| `All 127 targeted tests` \| 통과 \| - \| - \|/);
    assert.match(draft, /unknown 1건: /); assert.doesNotMatch(draft, /- unknown 사유\(/);
    // 재실행·세션 종료 뒤 review:attention도 같은 차단과 같은 초안을 낸다. 리뷰·게시·ledger 변경이 없다.
    assert.equal(await s.publish(), 2); assert.deepEqual(s.outputs[1], output);
    assert.equal(await s.attention(), 0);
    assert.deepEqual(s.cliOut.at(-1).blockers, ['findings', 'parser-mismatch']); assert.equal(s.cliOut.at(-1).draftPath, output.adminDraft.draftPath);
    assert.deepEqual(s.cliOut.at(-1).codeFindings, output.codeFindings); assert.deepEqual(s.cliOut.at(-1).interpretation, output.interpretation);
    // 관리자 확인 문구에도 저장된 unknown을 그대로 넣는다(두 해석 중 큰 값).
    assert.equal(await s.attention('--confirm', s.post(draft)), 0);
    assert.deepEqual(s.cliOut.at(-1).confirmation.findings, { critical: 0, high: 0, medium: 0, low: 0, unknown: 1 });
    s.unchanged();
    assert.equal(s.calls.reviews, 0); assert.equal(s.f.dispatches.length, 0); assert.equal(s.f.comments.length, 1); assert.deepEqual(writes(s.ghCalls), []);
  });
  await t.test('이전 코드가 만든 복구 기록(.recovered.v3.json, 복구 시 parser v3)', async t => {
    const s = await oldParserLedger(t, { recovered: true });
    assert.equal(await s.publish(), 2);
    assert.deepEqual(s.outputs[0].blockers, ['findings', 'parser-mismatch']); assert.equal(s.outputs[0].interpretation.stored.parserVersion, 3);
    // --recover를 다시 줘도 기존 복구 기록을 재사용하며 새로 재해석하지 않는다.
    assert.equal(await s.publish(recoverOptions), 2);
    assert.deepEqual(s.outputs[1], s.outputs[0]);
    assert.match(readFileSync(s.outputs[0].adminDraft.draftPath, 'utf8'), /복구 기록\(복구 시 parser v3\)/);
    assert.equal(await s.attention(), 0); assert.deepEqual(s.cliOut.at(-1).blockers, ['findings', 'parser-mismatch']);
    s.unchanged(); assert.equal(s.calls.reads, 0); assert.equal(s.f.dispatches.length, 0); assert.equal(s.f.comments.length, 0);
  });
  await t.test('이전 v3 원래 ledger의 --recover', async t => {
    const s = await oldParserLedger(t);
    await assert.rejects(s.publish(recoverOptions), error => error.code === 'review-recovery-manual');
    s.unchanged(); assert.deepEqual(s.files().filter(name => name.includes('.recovered')), []);
    assert.equal(s.calls.reads, 0); assert.equal(s.f.dispatches.length, 0);
  });
  await t.test('이미 게시 요청한 결과(중복 게시 방지)', async t => {
    const s = await oldParserLedger(t, { mutate: ledger => { ledger.publicationRequested = true; } });
    await assert.rejects(s.publish(), error => error.code === 'review-parser-mismatch');
    await assert.rejects(s.publish(), error => error.code === 'review-parser-mismatch');
    assert.equal(await s.attention(), 1); assert.match(s.cliErr.at(-1), /이미 봇 게시를 요청/);
    s.unchanged(); assert.equal(s.calls.jobReads, 0); assert.equal(s.f.dispatches.length, 0); assert.equal(s.f.comments.length, 0);
  });
  await t.test('저장 집계가 현재 해석보다 작은 기록', async t => {
    // 원문은 현재 parser로 unknown 1인데 저장 결과가 0이면, 저장 값을 믿지 않고 큰 값으로 차단·확인한다.
    const s = await oldParserLedger(t, { report: pr40FinalReport, log: completeJobLog(pr40FinalReport),
      mutate: ledger => { ledger.result.findings.unknown = 0; } });
    assert.equal(await s.publish(), 2);
    assert.deepEqual(s.outputs[0].blockers, ['findings', 'parser-mismatch']); assert.equal(s.outputs[0].interpretation.effectiveFindings.unknown, 1);
    assert.equal(await s.attention('--confirm', s.post(readFileSync(s.outputs[0].adminDraft.draftPath, 'utf8'))), 0);
    assert.equal(s.cliOut.at(-1).confirmation.findings.unknown, 1);
    s.unchanged(); assert.equal(s.f.dispatches.length, 0);
  });
  await t.test('형식이 깨진 저장 검사 기록', async t => {
    const s = await oldParserLedger(t, { mutate: ledger => { ledger.result.reviewerChecks = [{ name: 'Lint', status: 'passed' }]; } });
    await assert.rejects(s.publish());
    assert.equal(await s.attention(), 1); assert.match(s.cliErr.at(-1), /형식/);
    s.unchanged(); assert.equal(s.f.dispatches.length, 0);
  });
  await t.test('해석이 같은 버전 기록 없는 ledger는 기존 판정 그대로', async t => {
    const s = await oldParserLedger(t, { report: pr40FinalReport, log: pr40FinalJobLog(),
      mutate: ledger => { const { findings, reviewerChecks } = interpretStoredResult(ledger.result).current; Object.assign(ledger.result, { findings, reviewerChecks }); } });
    assert.equal(await s.publish(), 2);
    assert.deepEqual(s.outputs[0].blockers, ['findings', 'job-command-failed']); assert.equal(s.outputs[0].interpretation.consistent, true);
    assert.equal(s.outputs[0].interpretation.stored.parserVersion, null);
    s.unchanged();
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localFixture, pr28Report, pr34Report, pr37FinalReport, pr40FinalReport, cleanJobLog, pr40FinalJobLog, completeJobLog, jobLogStart, jobLogEnd } from './review-local-fixture.mjs';
import { runPluginPublication, collectPluginResult, pluginPublicationFailureMessage } from './review-plugin-cli.mjs';
import { runAttentionCli, parseAttentionArgs, attentionFailureMessage } from './review-attention-cli.mjs';
import { parseJobCommands, ledgerFileName, draftMarker, classifyCheck, buildAttentionDraft, maxDraftChars, jobLogBlockers, interpretStoredResult,
  publicationState, decidePublication, nodeFiles } from './review-attention.mjs';
import { analyzeReviewText, parserVersion } from './review-result-parser.mjs';
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
    assert.equal(await s.attention(), 1); assert.match(s.cliErr.at(-1), /v3 복구 기록의 연결/);
  });
  await t.test('not blocked', async t => {
    const s = await setup(t);
    const result = await s.f.result();
    // 현재 parser로 만든 최신 기록이어야 자동 게시 대상이다(이전 parser 기록은 legacy-record로 따로 차단, 별도 테스트).
    writeFileSync(s.ledgerPath, JSON.stringify({ state: 'completed', target: result.target, session: 'session-1', result, parserVersion }));
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

// PR #42 4차 재검증 복구 정책: 이전 parser 기록은 자동 게시 대상이 아니다(legacy-record). 판정·원문·검사 기록은 관리자 자료에 그대로 남긴다.
test('이전 parser로 저장한 v3 ledger는 재해석으로 바꾸거나 게시하지 않고 parser-mismatch·legacy-record 관리자 초안으로 넘기며 저장 unknown을 유지', async t => {
  const recoverOptions = { options: { repository: 'owner/repo', number: 1, session: 'session-1', recover: true } };
  await t.test('원래 ledger', async t => {
    const s = await oldParserLedger(t);
    assert.equal(await s.publish(), 2);
    const [output] = s.outputs;
    assert.equal(output.state, 'review-needs-attention'); assert.deepEqual(output.blockers, ['findings', 'parser-mismatch', 'legacy-record']);
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
    assert.match(draft, /`legacy-record`: /); assert.match(draft, /- 기록 구분: 구형 기록, 관리자 검토 전용\(원본 parser 버전 기록 없음\(현재 v4\)\)/);
    assert.match(draft, /저장된 unknown 1건 중 1건은 현재 parser로 사유를 재현할 수 없습니다\. 리뷰 당시 판정이므로 유지하며/);
    assert.match(draft, /- 자동 해석된 검사 문장이 없습니다/); assert.match(draft, /\| `All 127 targeted tests` \| 통과 \| - \| - \|/);
    assert.match(draft, /unknown 1건: /); assert.doesNotMatch(draft, /- unknown 사유\(/);
    // 재실행·세션 종료 뒤 review:attention도 같은 차단과 같은 초안을 낸다. 리뷰·게시·ledger 변경이 없다.
    assert.equal(await s.publish(), 2); assert.deepEqual(s.outputs[1], output);
    assert.equal(await s.attention(), 0);
    assert.deepEqual(s.cliOut.at(-1).blockers, ['findings', 'parser-mismatch', 'legacy-record']); assert.equal(s.cliOut.at(-1).draftPath, output.adminDraft.draftPath);
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
    assert.deepEqual(s.outputs[0].blockers, ['findings', 'parser-mismatch', 'legacy-record']); assert.equal(s.outputs[0].interpretation.stored.parserVersion, 3);
    // --recover는 중단된 경로다. 기존 복구 기록을 다시 읽거나 재해석하지 않고 안내만 한다.
    await assert.rejects(s.publish(recoverOptions), error => error.code === 'review-recovery-retired');
    const draft = readFileSync(s.outputs[0].adminDraft.draftPath, 'utf8');
    assert.match(draft, /복구 기록\(복구 시 parser v3\)/); assert.match(draft, /- 기록 구분: 구형 기록, 관리자 검토 전용\(복구 기록 있음/);
    assert.equal(await s.attention(), 0); assert.deepEqual(s.cliOut.at(-1).blockers, ['findings', 'parser-mismatch', 'legacy-record']);
    s.unchanged(); assert.equal(s.calls.reads, 0); assert.equal(s.f.dispatches.length, 0); assert.equal(s.f.comments.length, 0);
  });
  await t.test('이전 v3 원래 ledger의 --recover', async t => {
    const s = await oldParserLedger(t);
    await assert.rejects(s.publish(recoverOptions), error => error.code === 'review-recovery-retired');
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
    assert.deepEqual(s.outputs[0].blockers, ['findings', 'parser-mismatch', 'legacy-record']); assert.equal(s.outputs[0].interpretation.effectiveFindings.unknown, 1);
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
    assert.deepEqual(s.outputs[0].blockers, ['findings', 'legacy-record', 'job-command-failed']); assert.equal(s.outputs[0].interpretation.consistent, true);
    assert.equal(s.outputs[0].interpretation.stored.parserVersion, null);
    s.unchanged();
  });
});

// PR #42 재검증 지적 1: 복구 파일(.recovered.v3.json)이 원본 ledger의 판정을 가리지 않아야 한다.
// 원본·복구본·현재 parser 해석을 함께 비교하고, 원본과의 연결(대상·세션·job·원문·hash·게시 요청 기록)을 모든 경로에서 같은 기준으로 확인한다.
// legacyRecord를 주면 이전 wrapper 형태(원본 v2 결과 + 유효한 v2 복구 기록)로 만들고, v2 기록을 바꾼 뒤 그 파일의 실제 hash를 v3 복구 기록에 넣는다.
// withRecovered: false면 v3 복구 기록을 만들지 않는다(v2 복구 기록만 있는 대상, v3 복구 전).
async function recoveryLedgers(t, { report = pr37FinalReport, log = completeJobLog(report), original = () => {}, recovered = () => {}, legacy = null, legacyRecord = null,
  withRecovered = true } = {}) {
  const s = await setup(t, { report, log });
  const current = collectPluginResult({ output: s.job.result, stored: { job: { status: 'completed' }, storedJob: s.job }, target: s.target,
    session: 'session-1', startedAt: '2026-11-09T00:00:00Z', checks: [] });
  const v2 = () => { const copy = { ...structuredClone(current), v: 2 }; delete copy.reviewerChecks; return copy; };
  const originalLedger = { state: 'completed', target: structuredClone(s.target), session: 'session-1', result: legacyRecord ? v2() : structuredClone(current) };
  original(originalLedger);
  const originalText = JSON.stringify(originalLedger);
  writeFileSync(s.ledgerPath, originalText);
  if (legacyRecord) {
    const legacyLedger = { state: 'completed', target: structuredClone(s.target), session: 'session-1', result: v2(),
      recovery: { originalLedgerHash: sha256(originalText), parserVersion: 2 } };
    legacyRecord(legacyLedger);
    legacy = JSON.stringify(legacyLedger);
  }
  if (legacy !== null) writeFileSync(`${s.ledgerPath}.recovered.json`, legacy);
  const recoveredLedger = { state: 'completed', target: structuredClone(s.target), session: 'session-1', result: structuredClone(current),
    recovery: { originalLedgerHash: sha256(originalText), legacyRecoveredHash: legacyRecord ? sha256(legacy) : null, parserVersion: 4 } };
  recovered(recoveredLedger);
  const recoveredText = JSON.stringify(recoveredLedger);
  if (withRecovered) writeFileSync(`${s.ledgerPath}.recovered.v3.json`, recoveredText);
  const unchanged = ({ recoveredToo = true } = {}) => {
    assert.equal(readFileSync(s.ledgerPath, 'utf8'), originalText);
    if (legacy !== null) assert.equal(readFileSync(`${s.ledgerPath}.recovered.json`, 'utf8'), legacy);
    if (recoveredToo && withRecovered) assert.equal(readFileSync(`${s.ledgerPath}.recovered.v3.json`, 'utf8'), recoveredText);
    if (!withRecovered) assert.ok(!s.files().some(name => name.endsWith('.recovered.v3.json')));
  };
  const recover = () => s.publish({ options: { repository: 'owner/repo', number: 1, session: 'session-1', recover: true } });
  return { ...s, current, originalText, recoveredText, unchanged, recover };
}

// PR #42 4차 재검증 복구 정책: 복구 기록이 있는 대상은 관리자 검토 전용(legacy-record)이고 --recover는 안내만 한다. 원본 판정 유지(recovery-reduced)는 그대로 검증한다.
test('복구본이 원본보다 unknown·차단 지적·검사 실패를 줄이면 일반 실행·초안·--confirm 모두 게시하지 않고 원본 판정을 유지하며 --recover는 안내만', async t => {
  const cases = [
    // 재검증 재현 조건: 원본 v3 unknown 1, 복구본 unknown 0, 원본 hash 일치, 게시 요청 전.
    ['unknown 1 → 0', { original: l => { l.result.findings.unknown = 1; } }, { unknown: 1 }, ['findings', 'recovery-reduced']],
    ['medium 1 → 0', { original: l => { l.result.findings.medium = 1; } }, { medium: 1 }, ['findings', 'recovery-reduced']],
    ['low 1 → 0', { original: l => { l.result.findings.low = 1; } }, { low: 1 }, ['recovery-reduced']],
    // 원본에 기록된 검사 실패가 복구본에서 사라진 경우(복구본은 현재 parser와 같은 해석).
    ['check failure removed', { report: 'No findings. Lint passed. Build was not run.',
      original: l => { l.result.reviewerChecks = [...l.result.reviewerChecks, { name: 'privacyGuard', status: 'failed', count: null, cause: null }]; } },
    {}, ['reviewer-check-failed', 'recovery-reduced']],
  ];
  for (const [name, options, raised, blockers] of cases) await t.test(name, async t => {
    const s = await recoveryLedgers(t, options);
    const expected = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0, ...raised };
    assert.equal(await s.publish(), 2);
    const output = s.outputs.at(-1);
    assert.deepEqual(output.blockers, [...blockers, 'legacy-record']);
    assert.deepEqual(output.interpretation.effectiveFindings, expected);
    assert.equal(output.interpretation.recoveryReduced, true);
    assert.equal(output.adminDraft.state, 'ready');
    await assert.rejects(s.recover(), error => error.code === 'review-recovery-retired');
    assert.equal(await s.attention(), 0);
    assert.deepEqual(s.cliOut.at(-1).blockers, [...blockers, 'legacy-record']);
    const draft = readFileSync(s.cliOut.at(-1).draftPath, 'utf8');
    assert.match(draft, /`recovery-reduced`/); assert.match(draft, /\| 원본 ledger 저장 결과/);
    const url = s.post(draft);
    if (['critical', 'high', 'medium'].some(level => expected[level])) {
      assert.equal(await s.attention('--confirm', url), 1); assert.match(s.cliErr.at(-1), /critical\/high\/medium/);
    } else {
      assert.equal(await s.attention('--confirm', url), 0);
      assert.deepEqual(s.cliOut.at(-1).confirmation.findings, expected);
    }
    s.unchanged();
    assert.equal(s.calls.reviews, 0); assert.equal(s.f.dispatches.length, 0); assert.deepEqual(writes(s.ghCalls), []);
  });
});

// 3차까지는 원본·복구본·현재 해석이 모두 같으면 복구 기록으로 새 게시를 요청했다(dispatch 1회). 4차 복구 정책으로 이 자동 게시 경로를 없앴다.
// 대체 검증: 같은 조합이 관리자 초안(legacy-record)과 확인 문구 준비로만 이어지고, 이미 게시 요청한 복구 기록은 새 요청 없이 영수증만 확인한다.
test('원본·복구본·현재 해석이 모두 같아도 복구 기록으로는 새로 게시 요청하지 않고 관리자 검토 자료로만 쓰며, 게시 요청한 복구 기록은 영수증만 확인', async t => {
  await t.test('게시 이력 없음: 관리자 초안·확인 문구', async t => {
    const s = await recoveryLedgers(t);
    assert.equal(await s.publish(), 2); assert.equal(await s.publish(), 2);
    assert.deepEqual(s.outputs[0].blockers, ['legacy-record']); assert.equal(s.outputs[0].state, 'review-legacy-needs-attention');
    assert.deepEqual(s.outputs[1], s.outputs[0]);
    await assert.rejects(s.recover(), error => error.code === 'review-recovery-retired');
    assert.equal(await s.attention(), 0); assert.deepEqual(s.cliOut.at(-1).blockers, ['legacy-record']);
    const draft = readFileSync(s.cliOut.at(-1).draftPath, 'utf8');
    assert.match(draft, /`legacy-record`: /); assert.match(draft, /\| 원본 ledger 저장 결과/);
    assert.equal(await s.attention('--confirm', s.post(draft)), 0);
    assert.deepEqual(s.cliOut.at(-1).confirmation.findings, { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 });
    s.unchanged();
    assert.deepEqual([s.calls.reviews, s.calls.reads, s.f.dispatches.length, s.f.comments.length], [0, 0, 0, 1]);
  });
  await t.test('이전 wrapper가 게시 요청한 복구 기록: 새 요청 없이 영수증 확인, 복구 기록은 쓰지 않음', async t => {
    const s = await recoveryLedgers(t, { recovered: l => { l.publicationRequested = true; } });
    await assert.rejects(s.publish(), /완료를 확인하지 못함/);
    const published = await s.f.publish(s.current); s.f.finish(published);
    assert.equal(await s.publish(), 0); assert.equal(await s.publish(), 0);
    assert.equal(s.outputs.at(-1).state, 'published-awaiting-human');
    s.unchanged();
    assert.deepEqual([s.calls.reviews, s.calls.reads, s.calls.jobReads, s.f.dispatches.length, s.f.comments.length], [0, 0, 0, 0, 1]);
  });
});

test('원본과 같은 검사 실패를 유지한 복구본은 축소가 아니며 리뷰어 검사 실패와 구형 기록으로만 차단', async t => {
  const s = await recoveryLedgers(t, { report: pr28Report });
  assert.equal(await s.publish(), 2);
  assert.deepEqual(s.outputs[0].blockers, ['reviewer-check-failed', 'legacy-record']); assert.equal(s.outputs[0].interpretation.recoveryReduced, false);
  s.unchanged(); assert.equal(s.f.dispatches.length, 0);
});

test('복구본과 원본의 연결이 맞지 않으면 일반 실행·초안 모두 중단하고 기록을 바꾸지 않으며 --recover는 안내만', async t => {
  const cases = [
    ['original hash', { recovered: l => { l.recovery.originalLedgerHash = '0'.repeat(64); } }],
    ['original target', { original: l => { l.target.fingerprint = '0'.repeat(64); } , recovered: () => {} }],
    ['original session', { original: l => { l.session = 'other-session'; } }],
    ['original job', { original: l => { l.result.source.jobId = 'other-job'; } }],
    ['original turn', { original: l => { l.result.source.turnId = 'other-turn'; } }],
    ['original report', { original: l => { l.result.report += ' Hidden.'; l.result.source.outputHash = reportHash(l.result.report); } }],
    ['original report hash', { original: l => { l.result.report += ' Hidden.'; } }],
    ['original state', { original: l => { l.state = 'captured'; } }],
    ['original requested', { original: l => { l.publicationRequested = true; } }],
    ['original published', { original: l => { l.publicationRequested = true; l.publication = { commentUrl: 'x', evidenceHash: '0'.repeat(64) }; } }],
    ['original findings format', { original: l => { l.result.findings = { unknown: 0 }; } }],
    ['original version', { original: l => { l.result.v = 1; } }],
    ['legacy appeared', { legacy: '{}' }],
    ['legacy hash', { legacy: '{}', recovered: l => { l.recovery.legacyRecoveredHash = '0'.repeat(64); } }],
    ['recovered session', { recovered: l => { l.session = 'other-session'; } }],
    ['recovered source', { recovered: l => { l.result.source.completedAt = '2026-11-09T00:02:00Z'; } }],
  ];
  for (const [name, options] of cases) await t.test(name, async t => {
    const s = await recoveryLedgers(t, options);
    await assert.rejects(s.publish(), error => error.code === 'review-recovery-manual');
    await assert.rejects(s.recover(), error => error.code === 'review-recovery-retired');
    assert.equal(await s.attention(), 1); assert.match(s.cliErr.at(-1), /복구 기록을 사람이 먼저 확인/);
    s.unchanged();
    assert.equal(s.calls.reviews, 0); assert.equal(s.calls.reads, 0); assert.equal(s.f.dispatches.length, 0); assert.equal(s.f.comments.length, 0);
  });
  await t.test('original missing', async t => {
    const s = await recoveryLedgers(t);
    unlinkSync(s.ledgerPath);
    await assert.rejects(s.publish(), error => error.code === 'review-recovery-manual');
    await assert.rejects(s.recover(), error => error.code === 'review-recovery-retired'); assert.equal(await s.attention(), 1);
    assert.deepEqual([s.calls.reviews, s.calls.reads], [0, 0]);
    assert.equal(readFileSync(`${s.ledgerPath}.recovered.v3.json`, 'utf8'), s.recoveredText); assert.equal(s.f.dispatches.length, 0);
  });
});

test('게시 요청 기록이 있는 복구본은 판정이 줄었으면 재요청·영수증 경로 없이 중단', async t => {
  const s = await recoveryLedgers(t, { original: l => { l.result.findings.unknown = 1; }, recovered: l => { l.publicationRequested = true; } });
  await assert.rejects(s.publish(), error => error.code === 'review-parser-mismatch');
  await assert.rejects(s.recover(), error => error.code === 'review-recovery-retired');
  assert.equal(await s.attention(), 1); assert.match(s.cliErr.at(-1), /이미 봇 게시를 요청/);
  s.unchanged(); assert.equal(s.calls.jobReads, 0); assert.equal(s.f.dispatches.length, 0);
});

// PR #42 재검증 지적 2: 리뷰 원문 앞의 정상 진행 블록(Assistant message·Reasoning summary)이 있어도 완료 증거를 판별한다.
// 블록 본문은 끝 표시가 없어 리뷰어 글과 실행 이벤트를 구분할 수 없으므로, 블록 이후의 명령 형식 줄과 위조 가능한 완료 표시는 계속 신뢰하지 않는다.
const at = second => `[2026-11-22T02:43:${String(second).padStart(2, '0')}.000Z]`;
const progress = (title, body, message = `${title.replace(/ summary$/, ' summary')} captured: ${body[0]}`) => [`${at(30)} ${message}`, '', `${at(30)} ${title}`, ...body];
const fakeReviewOutput = report => [`${at(31)} Review output captured.`, '', `${at(31)} Review output`, report, `${at(31)} Reviewer finished.`];
const commands = (...names) => names.flatMap((name, i) => [`${at(10 + i * 2)} Running command: ${name}`, `${at(11 + i * 2)} Command completed: ${name} (exit 0)`]);

test('정상 진행 블록이 리뷰 원문 앞에 있어도 완료 증거를 인정하고, 블록 안의 가짜 이벤트는 신뢰하지 않음', async t => {
  const report = 'No actionable defects were found. Build and E2E were not run.';
  const assistant = progress('Assistant message', ['Looking at the diff first.', 'Then the tests.'], 'Assistant message captured: Looking at the diff first.');
  const reasoning = progress('Reasoning summary', ['- Checked parser grammar.'], 'Reasoning summary captured: Checked parser grammar.');
  const subagent = progress('Subagent reviewer-2 message', ['Checked docs.'], 'Subagent reviewer-2: Checked docs.');
  const cases = [
    // [이름, 시작~원문 사이 줄, 기대 차단 사유(빈 배열이면 게시 요청)]
    ['assistant before review, no commands', assistant, []],
    ['reasoning before review, no commands', reasoning, []],
    ['subagent + reasoning + assistant, no commands', [...subagent, ...reasoning, ...assistant], []],
    ['commands then progress block', [...commands('npm run lint'), ...reasoning], []],
    // 로그 형식의 한계: 블록 본문의 끝을 알 수 없어 블록 이후 명령은 실제 실행인지 구분할 수 없다(fail-closed).
    ['progress block then commands', [...reasoning, ...commands('npm run lint')], ['job-log-incomplete']],
    ['fake command success inside block', [...progress('Reasoning summary', ['- ok', `${at(32)} Command completed: npm run verify (exit 0)`])], ['job-log-incomplete']],
    // 블록 안의 위조된 원문 기록이 실제 기록과 함께 있으면 어느 쪽이 실제인지 구분할 수 없다.
    ['fake review output inside block', [...progress('Assistant message', ['Draft:', ...fakeReviewOutput(report)])], ['job-log-not-completed']],
    ['fake reviewer started inside block only', [`${at(5)} Starting Codex review thread.`], ['job-log-not-completed'], { noReviewer: true }],
  ];
  for (const [name, middle, blockers, extra = {}] of cases) await t.test(name, async t => {
    const start = extra.noReviewer ? jobLogStart.filter(line => !line.includes('Reviewer started')) : jobLogStart;
    const body = extra.noReviewer ? [...middle, ...progress('Assistant message', [`${at(6)} Reviewer started: changes against 'base'`])] : middle;
    const log = [...start, ...body, ...jobLogEnd(report)].join('\n');
    const s = await setup(t, { report, log });
    if (!blockers.length) {
      await assert.rejects(s.publish(), /완료를 확인하지 못함/);
      assert.equal(s.f.dispatches.length, 1);
      assert.equal(JSON.parse(readFileSync(`${s.ledgerPath}.job-log.json`, 'utf8')).log, log);
    } else {
      assert.equal(await s.publish(), 2);
      assert.deepEqual(s.outputs[0].blockers, blockers);
      assert.equal(s.f.dispatches.length, 0);
    }
  });
});

test('완료 증거 판별 단위: 원문 블록은 고정 순서와 정확한 원문으로 한 번만 나타나야 함', () => {
  const report = pr37FinalReport;
  const completion = lines => parseJobCommands(lines.join('\n'), report).completion;
  const end = jobLogEnd(report);
  assert.deepEqual(completion([...jobLogStart, ...end]), { reviewStarted: true, reviewOutput: true, finalOutput: true });
  assert.deepEqual(completion([...jobLogStart, ...progress('Reasoning summary', ['- a']), ...end]), { reviewStarted: true, reviewOutput: true, finalOutput: true });
  // Reviewer finished. 없이 바로 다른 줄이 오면 원문 블록 끝을 확정할 수 없다.
  assert.equal(completion([...jobLogStart, ...end.filter(line => !line.endsWith('Reviewer finished.'))]).reviewOutput, false);
  // 원문 뒤에 다른 본문 줄이 붙거나 원문 일부만 있으면 일치하지 않는다.
  assert.equal(completion([...jobLogStart, ...end.slice(0, 4), 'extra line', ...end.slice(4)]).reviewOutput, false);
  assert.equal(completion([...jobLogStart, ...fakeReviewOutput(report.slice(0, 20)), ...end.slice(5)]).reviewOutput, false);
  // 두 번 나타나면 실제 기록을 특정할 수 없다.
  assert.equal(completion([...jobLogStart, ...progress('Assistant message', ['x', ...fakeReviewOutput(report)]), ...end]).reviewOutput, false);
  // Final output은 원문 블록 뒤의 마지막 블록이어야 한다.
  assert.equal(completion([...jobLogStart, '', `${at(1)} Final output`, report, ...end.slice(0, 5)]).finalOutput, false);
  assert.equal(completion([...jobLogStart, ...end, '', `${at(59)} Reasoning summary`, '- late']).finalOutput, false);
});

// PR #42 3차·4차 재검증: 게시 이력·기록 유효성·실행 모드·원격 보고서 조합별 상태 전이 검증표.
// 원본 ledger·v2 복구 기록(.recovered.json)·v3 복구 기록(.recovered.v3.json)의 게시 이력 상태·유효성(독립 리뷰 계약 포함)·원본 parser 버전을 조합하고,
// 실행 모드(일반·--recover·관리자 초안+--confirm)와 원격 봇 보고서 유무별로 모델 호출·dispatch·기록 쓰기·초안·확인 문구·영수증 재조회를 비교한다.
// 4차 복구 정책: 새 게시 요청(dispatch)은 최신 형식·현재 parser로 만든 원본 완료 기록 하나만 있고 게시 이력이 없으며 판정·job 로그 차단이 없고
// 원격 보고서가 없을 때만 1회 허용된다. 구형·복구 기록은 관리자 검토 전용이고, --recover는 어떤 상태에서도 조회·쓰기·모델 호출·dispatch 없이 안내만 한다.
// 3차의 90개 기록 조합(720개 경우)은 모두 포함하고, 독립 리뷰 계약 위반·이전 parser 원본 조합을 더했다.
const receiptStub = { commentUrl: 'https://github.com/owner/repo/pull/1#issuecomment-999', evidenceHash: 'b'.repeat(64) };
const recordVariants = {
  none: () => {},
  requested: l => { l.publicationRequested = true; },
  confirmed: (l, receipt) => { l.publicationRequested = true; l.publication = { ...(receipt ?? receiptStub) }; },
  'unclear:false': l => { l.publicationRequested = false; },
  'unclear:null': l => { l.publicationRequested = null; },
  'unclear:empty-publication': l => { l.publicationRequested = true; l.publication = {}; },
  'unclear:publication-only': (l, receipt) => { l.publication = { ...(receipt ?? receiptStub) }; },
  'unclear:unknown-field': l => { l.published = true; },
  'invalid:session': l => { l.session = 'other-session'; },
  'invalid:findings': l => { l.result.findings = { unknown: 0 }; },
  // 독립 리뷰 계약 위반(PR #42 4차 재검증 Medium). 대상·세션·job·원문·hash는 그대로다.
  'invalid:role': l => { l.result.role = 'self'; },
  'invalid:reviewer': l => { l.result.reviewer = 'claude'; },
};
const publicationVariants = Object.keys(recordVariants).filter(name => !name.startsWith('invalid'));
const variantState = variant => variant === 'absent' ? 'absent' : variant.split(':')[0];
const judgements = {
  // 지적 없음·완료 증거가 있는 job 로그: 최신 원본 기록이고 게시 이력이 없으면 새 요청 대상
  clean: 'No actionable defects were found. Lint passed. Build and E2E were not run.',
  // unknown 1(차단 지적 없음): 관리자 초안·확인 문구 대상
  unknown: pr40FinalReport,
};

async function transitionCase(t, { original, legacy, recovered, judgement, remote, oldParser = false }) {
  const report = judgements[judgement];
  const s = await setup(t, { report, log: completeJobLog(report) });
  // 완료 기록은 수집 시점의 원격 CI 상태를 담는다. 원격 보고서와 같은 결과여야 영수증을 비교할 수 있다.
  const current = collectPluginResult({ output: s.job.result, stored: { job: { status: 'completed' }, storedJob: s.job }, target: s.target,
    session: 'session-1', startedAt: '2026-11-09T00:00:00Z', checks: (await s.f.collect()).packet.checks });
  let receipt = null;
  if (remote) { const published = await s.f.publish(current); s.f.finish(published); receipt = await s.f.confirm(); }
  const receiptFields = receipt && { commentUrl: receipt.commentUrl, evidenceHash: receipt.evidenceHash };
  const v2 = result => { const copy = { ...structuredClone(result), v: 2 }; delete copy.reviewerChecks; return copy; };
  // v2 복구 기록이 있는 대상은 원본도 v2 결과(이전 wrapper)다. 그 밖의 원본은 v3이고, oldParser면 parser 버전 기록이 없다(이전 wrapper).
  const originalLedger = { state: 'completed', target: structuredClone(s.target), session: 'session-1',
    result: legacy === 'absent' ? structuredClone(current) : v2(current), ...(legacy === 'absent' && !oldParser ? { parserVersion } : {}) };
  recordVariants[original](originalLedger, receiptFields);
  const originalText = JSON.stringify(originalLedger);
  writeFileSync(s.ledgerPath, originalText);
  let legacyText = null;
  if (legacy !== 'absent') {
    const legacyLedger = { state: 'completed', target: structuredClone(s.target), session: 'session-1', result: v2(current),
      recovery: { originalLedgerHash: sha256(originalText), parserVersion: 2 } };
    recordVariants[legacy](legacyLedger, receiptFields);
    legacyText = JSON.stringify(legacyLedger);
    writeFileSync(`${s.ledgerPath}.recovered.json`, legacyText);
  }
  if (recovered !== 'absent') {
    // v3 복구 기록은 실제 v2 복구 파일 hash를 기록한다(hash만으로는 v2 기록의 유효성·게시 이력 부재를 보장하지 못함).
    const recoveredLedger = { state: 'completed', target: structuredClone(s.target), session: 'session-1', result: structuredClone(current),
      recovery: { originalLedgerHash: sha256(originalText), legacyRecoveredHash: legacyText === null ? null : sha256(legacyText), parserVersion: 4 } };
    recordVariants[recovered](recoveredLedger, receiptFields);
    writeFileSync(`${s.ledgerPath}.recovered.v3.json`, JSON.stringify(recoveredLedger));
  }
  return s;
}

const recordFiles = { original: '', legacyRecovered: '.recovered.json', recovered: '.recovered.v3.json' };
const snapshot = s => Object.fromEntries(readdirSync(s.directory).map(name => [name, readFileSync(join(s.directory, name), 'utf8')]));
const attentionCodes = ['review-attention-busy', 'review-attention-no-ledger', 'review-attention-ledger-invalid', 'review-attention-publication-requested',
  'review-attention-not-blocked', 'review-recovery-manual', 'review-attention-comment-invalid', 'review-attention-not-admin', 'review-attention-bot-report',
  'review-attention-blocking-findings', 'review-attention-ci', 'review-attention-gate-mismatch', 'review-attention-draft-too-large', 'review-attention-file-conflict'];
const attentionCode = text => attentionCodes.find(code => attentionFailureMessage({ code }) === text) ?? 'other';

async function observeTransition(s, mode) {
  const before = snapshot(s);
  const base = ledgerFileName(s.target);
  let outcome;
  if (mode === 'confirm') {
    const draftExit = await s.attention();
    const draftOutcome = draftExit === 0 ? 'draft' : attentionCode(s.cliErr.at(-1));
    const body = draftExit === 0 ? readFileSync(s.cliOut.at(-1).draftPath, 'utf8') : '# 독립 리뷰 보고서\n\n(초안 아님)';
    const confirmExit = await s.attention('--confirm', s.post(body));
    outcome = `${draftOutcome}/${confirmExit === 0 ? 'confirm' : attentionCode(s.cliErr.at(-1))}`;
  } else {
    const run = mode === 'recover' ? s.publish({ options: { repository: 'owner/repo', number: 1, session: 'session-1', recover: true } }) : s.publish();
    try { outcome = `exit:${await run}`; } catch (error) { outcome = error.code ? `stop:${error.code}` : /완료를 확인하지 못함/.test(error.message) ? 'stop:receipt-pending' : `stop:${error.message}`; }
  }
  const after = snapshot(s);
  const changed = name => before[name] !== after[name];
  return {
    outcome, reviews: s.calls.reviews, dispatches: s.f.dispatches.length,
    ledgerWrites: Object.entries(recordFiles).filter(([, suffix]) => changed(base + suffix)).map(([record]) => record),
    draft: Object.keys(after).some(name => name.includes('.attention-') && !before[name]),
    confirmation: Object.keys(after).some(name => name.includes('.review-gate-') && !before[name]),
    receipt: s.outputs.some(item => item.state === 'published-awaiting-human') ? 'confirmed' : outcome === 'stop:receipt-pending' ? 'polled' : 'no',
  };
}

// 허용 동작 기준(4차 복구 정책). 공통 로더가 모든 기록을 같은 계약으로 검증하고, 판정 기록(v3 복구 > v2 복구 > 원본)의 게시 이력과
// 자동 게시 대상 여부(최신 형식·현재 parser 원본 기록 하나뿐)로 진행한다.
function expectedTransition({ original, legacy, recovered, judgement, mode, remote, oldParser = false }) {
  const none = { reviews: 0, dispatches: 0, ledgerWrites: [], draft: false, confirmation: false, receipt: 'no' };
  // --recover: 어떤 기록 상태에서도 안내만 한다.
  if (mode === 'recover') return { ...none, outcome: 'stop:review-recovery-retired' };
  const records = [original, legacy, recovered].map(variantState).filter(state => state !== 'absent');
  const recoveryFiles = records.length > 1;
  const decision = records.at(-1);
  const refuse = code => ({ ...none, outcome: mode === 'confirm' ? `${code}/${code}` : `stop:${code}` });
  // 무효 기록(세션·집계 형식·역할·리뷰어): 복구 기록이 있으면 수동 확인, 원본만 있으면 ledger 오류. 보정하거나 유효한 리뷰로 쓰지 않는다.
  if (records.includes('invalid')) return refuse(recoveryFiles ? 'review-recovery-manual' : 'review-attention-ledger-invalid');
  // 판정 기록 이전 기록(원본·v2 복구)에 게시 이력이 있거나 불명확하면 수동 확인.
  if (records.slice(0, -1).some(state => state !== 'none')) return refuse('review-recovery-manual');
  // 판정 기록이 v2 복구 기록이면 검사 기록이 없어 현재 해석과 다르다(parser-mismatch).
  const reportBlocked = judgement !== 'clean' || variantState(legacy) !== 'absent' && variantState(recovered) === 'absent';
  const autoPublish = !recoveryFiles && !oldParser;
  if (mode === 'confirm') {
    if (decision !== 'none') return refuse('review-attention-publication-requested');
    // 관리자 자료 경로에는 job 로그 사본이 없어(job-log-unverified) 판정이 깨끗해도 차단된 결과로 초안을 만든다. 유효한 구형 기록도 같은 자료를 만든다.
    return { ...none, outcome: remote ? 'draft/review-attention-bot-report' : 'draft/confirm', draft: true, confirmation: !remote };
  }
  if (decision === 'unclear') return refuse('review-publication-uncertain');
  if (decision === 'requested' || decision === 'confirmed') {
    if (reportBlocked) return refuse('review-parser-mismatch');
    // 이미 요청한 결과는 기록 종류와 관계없이 새 요청 없이 영수증만 확인한다. 영수증은 판정 기록인 원본 ledger에만 쓴다(복구 기록은 확인만).
    return remote ? { ...none, outcome: 'exit:0', receipt: 'confirmed', ledgerWrites: decision === 'requested' && !recoveryFiles ? ['original'] : [] }
      : { ...none, outcome: 'stop:receipt-pending', receipt: 'polled' };
  }
  if (reportBlocked || !autoPublish) return { ...none, outcome: 'exit:2', draft: true };
  if (remote) return { ...none, outcome: 'exit:0', receipt: 'confirmed', ledgerWrites: ['original'] };
  return { ...none, outcome: 'stop:receipt-pending', dispatches: 1, receipt: 'polled', ledgerWrites: ['original'] };
}

const transitionConfigs = [
  // A. 원본 ledger만 있음(현재 parser): 원본의 게시 이력 상태 전체와 형식·독립 리뷰 계약 위반
  ...[...publicationVariants, 'invalid:findings', 'invalid:role', 'invalid:reviewer'].map(original => ({ original, legacy: 'absent', recovered: 'absent' })),
  // A'. 원본 ledger만 있음(이전 parser, parser 버전 기록 없음): 구형 기록. 게시 이력이 있으면 영수증만 확인
  ...['none', 'requested', 'confirmed'].map(original => ({ original, legacy: 'absent', recovered: 'absent', oldParser: true })),
  // B. v2 복구 기록만 있음(v3 복구 전): 원본·v2 기록의 게시 이력·유효성
  ...['none', 'requested', 'unclear:false'].flatMap(original => ['none', 'requested', 'confirmed', 'unclear:false', 'unclear:unknown-field', 'invalid:session', 'invalid:role']
    .map(legacy => ({ original, legacy, recovered: 'absent' }))),
  // C. v3 복구 기록 + 원본: 두 기록의 게시 이력 상태와 독립 리뷰 계약 위반
  ...['none', 'requested', 'confirmed', 'unclear:false', 'unclear:publication-only'].flatMap(original => [...publicationVariants, 'invalid:role', 'invalid:reviewer']
    .map(recovered => ({ original, legacy: 'absent', recovered }))),
  ...['invalid:role', 'invalid:reviewer'].map(original => ({ original, legacy: 'absent', recovered: 'none' })),
  // D. v3 복구 기록 + v2 복구 기록 + 원본: v2 기록 검증(hash는 일치)
  ...['none', 'requested', 'confirmed', 'unclear:false', 'unclear:null', 'unclear:unknown-field', 'invalid:session', 'invalid:findings', 'invalid:role']
    .flatMap(legacy => ['none', 'requested', 'unclear:false'].map(recovered => ({ original: 'none', legacy, recovered }))),
];
const transitionRuns = transitionConfigs.flatMap(config => [
  ...['normal', 'recover'].flatMap(mode => [false, true].map(remote => ({ ...config, judgement: 'clean', mode, remote }))),
  { ...config, judgement: 'clean', mode: 'confirm', remote: false },
  ...['normal', 'recover', 'confirm'].map(mode => ({ ...config, judgement: 'unknown', mode, remote: false })),
]);
const transitionName = run => `${run.original}${run.oldParser ? ' (old parser)' : ''} | v2 ${run.legacy} | v3 ${run.recovered} | ${run.judgement} | ${run.mode} | remote ${run.remote ? 'yes' : 'no'}`;

test('상태 전이 검증표: 원본·v2·v3 기록의 게시 이력·유효성·parser 버전 × 실행 모드 × 원격 보고서별 허용 동작만 일어남', async t => {
  const rows = [];
  for (const run of transitionRuns) {
    await t.test(transitionName(run), async t => {
      const s = await transitionCase(t, run);
      const actual = await observeTransition(s, run.mode);
      const expected = expectedTransition(run);
      rows.push({ ...run, ...actual });
      assert.deepEqual(actual, expected);
      // 차단 대상의 dispatch는 0회, 허용 대상도 1회를 넘지 않는다. 기존 리뷰가 있으므로 모델은 호출하지 않는다.
      assert.ok(actual.dispatches <= 1); assert.equal(actual.reviews, 0);
      // 요청·영수증 기록은 원본 ledger만 있을 때 그 원본(판정 기록)에만 쓴다. 복구 기록이 있는 대상에서는 원본·복구 기록 어디에도 쓰지 않는다.
      if (run.legacy !== 'absent' || run.recovered !== 'absent' || run.mode !== 'normal') assert.deepEqual(actual.ledgerWrites, []);
      // --recover는 GitHub 조회도 하지 않는다.
      if (run.mode === 'recover') assert.deepEqual(s.ghCalls, []);
    });
  }
  // 조합 수와 dispatch가 일어난 조합(최신 원본 기록 하나·게시 이력 없음·지적 없음·원격 보고서 없음)만 따로 확인한다.
  assert.equal(rows.length, transitionRuns.length);
  assert.equal(transitionConfigs.length, 114);
  const dispatched = rows.filter(row => row.dispatches > 0).map(transitionName);
  assert.deepEqual(dispatched, ['none | v2 absent | v3 absent | clean | normal | remote no']);
});

test('정상 최초 게시부터 영수증 재조회·재실행까지 모델 호출과 dispatch는 각각 한 번', async t => {
  const report = judgements.clean;
  const s = await setup(t, { report, log: completeJobLog(report) });
  const recover = () => s.publish({ options: { repository: 'owner/repo', number: 1, session: 'session-1', recover: true } });
  await assert.rejects(s.publish(), /완료를 확인하지 못함/);
  assert.deepEqual([s.calls.reviews, s.f.dispatches.length], [1, 1]);
  assert.equal(JSON.parse(readFileSync(s.ledgerPath, 'utf8')).publicationRequested, true);
  // 응답 대기 중 재실행: 영수증만 재조회하고 다시 요청하지 않는다. --recover는 안내만 하고 복구 기록을 만들지 않는다.
  await assert.rejects(s.publish(), /완료를 확인하지 못함/);
  await assert.rejects(recover(), error => error.code === 'review-recovery-retired');
  assert.equal(await s.attention(), 1); assert.match(s.cliErr.at(-1), /이미 봇 게시를 요청/);
  const published = await s.f.publish(s.f.dispatches[0].result); s.f.finish(published);
  assert.equal(await s.publish(), 0);
  const confirmedText = readFileSync(s.ledgerPath, 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(confirmedText).publication).sort(), ['commentUrl', 'evidenceHash']);
  // 영수증 기록 뒤 재실행은 같은 영수증을 확인만 하고 ledger를 다시 쓰지 않는다.
  assert.equal(await s.publish(), 0); assert.equal(readFileSync(s.ledgerPath, 'utf8'), confirmedText);
  await assert.rejects(recover(), error => error.code === 'review-recovery-retired');
  assert.deepEqual(s.files().filter(name => name.includes('.recovered')), []);
  assert.deepEqual([s.calls.reviews, s.f.dispatches.length, s.f.comments.length], [1, 1, 1]);
});

test('로컬 기록 없음·실행 중·수집 직후 기록의 상태 전이', async t => {
  const report = judgements.clean;
  await t.test('원격 보고서가 이미 있으면 모델·dispatch 없이 영수증만 확인하고 기록을 만들지 않음', async t => {
    const s = await setup(t, { report, log: completeJobLog(report) });
    const current = collectPluginResult({ output: s.job.result, stored: { job: { status: 'completed' }, storedJob: s.job }, target: s.target,
      session: 'session-1', startedAt: '2026-11-09T00:00:00Z', checks: [] });
    const published = await s.f.publish(current); s.f.finish(published);
    assert.equal(await s.publish(), 0); assert.equal(s.outputs.at(-1).state, 'published-awaiting-human');
    assert.deepEqual([s.calls.reviews, s.f.dispatches.length], [0, 0]); assert.deepEqual(s.files(), ['job-1.log']);
  });
  await t.test('--recover는 기록이 없으면 모델을 호출하지 않음', async t => {
    const s = await setup(t, { report, log: completeJobLog(report) });
    await assert.rejects(s.publish({ options: { repository: 'owner/repo', number: 1, session: 'session-1', recover: true } }));
    assert.deepEqual([s.calls.reviews, s.f.dispatches.length], [0, 0]); assert.deepEqual(s.files(), ['job-1.log']);
  });
  await t.test('실행 중 기록은 재실행·게시하지 않음', async t => {
    const s = await setup(t, { report, log: completeJobLog(report) });
    const text = JSON.stringify({ state: 'running', target: s.target, session: 'session-1', startedAt: '2026-11-09T00:00:00Z' });
    writeFileSync(s.ledgerPath, text);
    await assert.rejects(s.publish(), /미완료/);
    assert.equal(readFileSync(s.ledgerPath, 'utf8'), text); assert.deepEqual([s.calls.reviews, s.f.dispatches.length], [0, 0]);
  });
  for (const [name, mutate] of [['requested', l => { l.publicationRequested = true; }], ['false', l => { l.publicationRequested = false; }],
    ['publication', l => { l.publication = { ...receiptStub }; }]]) {
    await t.test(`게시 이력이 있는 수집 직후 기록(${name})은 완료 기록으로 덮어쓰지 않고 중단`, async t => {
      const s = await setup(t, { report, log: completeJobLog(report) });
      const ledger = { state: 'captured', target: s.target, session: 'session-1', startedAt: '2026-11-09T00:00:00Z', output: s.job.result };
      mutate(ledger);
      const text = JSON.stringify(ledger);
      writeFileSync(s.ledgerPath, text);
      await assert.rejects(s.publish(), error => error.code === 'review-publication-uncertain');
      assert.equal(readFileSync(s.ledgerPath, 'utf8'), text); assert.deepEqual([s.calls.reviews, s.calls.reads, s.f.dispatches.length], [0, 0, 0]);
    });
  }
  await t.test('게시 이력 없는 수집 직후 기록은 모델 재호출 없이 완료 처리 후 한 번 요청', async t => {
    const s = await setup(t, { report, log: completeJobLog(report) });
    writeFileSync(s.ledgerPath, JSON.stringify({ state: 'captured', target: s.target, session: 'session-1', startedAt: '2026-11-09T00:00:00Z', output: s.job.result }));
    await assert.rejects(s.publish(), /완료를 확인하지 못함/);
    assert.deepEqual([s.calls.reviews, s.f.dispatches.length], [0, 1]);
  });
});

test('게시 이력 상태는 모든 기록에서 같은 기준 하나로 판정하고 불완전·모호한 기록은 요청한 것으로 봄', () => {
  const base = { state: 'completed', target: {}, session: 's', result: {} };
  const cases = [
    [{}, 'none'], [{ publicationRequested: true }, 'requested'], [{ publicationRequested: true, publication: receiptStub }, 'confirmed'],
    [{ publicationRequested: false }, 'unclear'], [{ publicationRequested: null }, 'unclear'], [{ publicationRequested: 'true' }, 'unclear'],
    [{ publicationRequested: 1 }, 'unclear'], [{ publicationRequested: undefined }, 'unclear'], [{ publication: receiptStub }, 'unclear'],
    [{ publicationRequested: true, publication: {} }, 'unclear'], [{ publicationRequested: true, publication: null }, 'unclear'],
    [{ publicationRequested: true, publication: { commentUrl: '', evidenceHash: 'b'.repeat(64) } }, 'unclear'],
    [{ publicationRequested: true, publication: { commentUrl: 'x', evidenceHash: 'zz' } }, 'unclear'],
    [{ publicationRequested: true, publication: { ...receiptStub, extra: 1 } }, 'unclear'],
    [{ published: true }, 'unclear'], [{ dispatched: false }, 'unclear'],
  ];
  for (const [fields, expected] of cases) {
    for (const kind of ['original', 'recovered', 'legacyRecovered']) {
      const record = { ...base, ...(kind === 'original' ? {} : { recovery: {} }), ...fields };
      assert.equal(publicationState(record, kind), expected, `${kind} ${JSON.stringify(fields)}`);
    }
  }
  // 기록 종류별 허용 필드: 원본의 recovery, 복구 기록의 parserVersion은 형식 밖이다.
  assert.equal(publicationState({ ...base, recovery: {} }, 'original'), 'unclear');
  assert.equal(publicationState({ ...base, recovery: {}, parserVersion: 4 }, 'recovered'), 'unclear');
  assert.equal(publicationState({ ...base, parserVersion: 4 }, 'original'), 'none');
  assert.equal(publicationState(null), 'unclear'); assert.equal(publicationState([]), 'unclear');
  assert.equal(publicationState({ state: 'captured', target: {}, session: 's', startedAt: 't', output: {}, stored: {} }, 'captured'), 'none');
  assert.equal(publicationState({ state: 'captured', target: {}, session: 's', startedAt: 't', output: {}, publicationRequested: true }, 'captured'), 'unclear');
});

test('새 게시 요청 판단 기준은 decidePublication 하나이며 필요한 자료만 읽음', async () => {
  const clean = interpretStoredResult({ report: judgements.clean, ...analyzeReviewText(judgements.clean) });
  const blockedInterpretation = interpretStoredResult({ report: pr40FinalReport, ...analyzeReviewText(pr40FinalReport) });
  const goodLog = { status: 'captured', commands: [], unfinished: [], ambiguous: [], completion: { reviewStarted: true, reviewOutput: true, finalOutput: true } };
  const badLog = { ...goodLog, completion: { ...goodLog.completion, finalOutput: false } };
  // 입력은 공통 로더가 돌려준 기록 하나다(게시 이력·자동 게시 대상 여부·판정). autoPublish가 true가 아니면 구형 기록으로 본다(fail-closed).
  const decide = async (publication, interpretation, remote, log, autoPublish = true) => {
    const reads = { remote: 0, log: 0 };
    const decision = await decidePublication({ ledger: { publication, result: {}, interpretation, ...(autoPublish === 'missing' ? {} : { autoPublish }) },
      remoteReports: async () => { reads.remote++; return remote; }, jobLog: async () => { reads.log++; return log; } });
    return { action: decision.action, code: decision.code ?? null, blockers: decision.blockers ?? [], reads };
  };
  const cases = [
    // 구형·복구 기록(autoPublish false·값 없음): 게시 이력이 없으면 원격 보고서와 관계없이 관리자 초안. 이미 요청한 결과는 영수증만 확인.
    [['none', clean, 0, goodLog, false], { action: 'blocked', code: null, blockers: ['legacy-record'], reads: { remote: 0, log: 1 } }],
    [['none', clean, 1, goodLog, 'missing'], { action: 'blocked', code: null, blockers: ['legacy-record'], reads: { remote: 0, log: 1 } }],
    [['none', clean, 0, goodLog, 'true'], { action: 'blocked', code: null, blockers: ['legacy-record'], reads: { remote: 0, log: 1 } }],
    [['none', blockedInterpretation, 0, badLog, false], { action: 'blocked', code: null, blockers: ['findings', 'legacy-record', 'job-log-not-completed'], reads: { remote: 0, log: 1 } }],
    [['requested', clean, 0, goodLog, false], { action: 'receipt', code: null, blockers: [], reads: { remote: 0, log: 0 } }],
    [['unclear', clean, 0, goodLog, false], { action: 'stop', code: 'review-publication-uncertain', blockers: [], reads: { remote: 0, log: 0 } }],
    [['unclear', clean, 0, goodLog], { action: 'stop', code: 'review-publication-uncertain', blockers: [], reads: { remote: 0, log: 0 } }],
    [['bogus', clean, 0, goodLog], { action: 'stop', code: 'review-publication-uncertain', blockers: [], reads: { remote: 0, log: 0 } }],
    [['requested', clean, 0, goodLog], { action: 'receipt', code: null, blockers: [], reads: { remote: 0, log: 0 } }],
    [['confirmed', clean, 1, goodLog], { action: 'receipt', code: null, blockers: [], reads: { remote: 0, log: 0 } }],
    [['requested', blockedInterpretation, 0, goodLog], { action: 'stop', code: 'review-parser-mismatch', blockers: ['findings'], reads: { remote: 0, log: 0 } }],
    [['none', blockedInterpretation, 0, goodLog], { action: 'blocked', code: null, blockers: ['findings'], reads: { remote: 0, log: 1 } }],
    [['none', blockedInterpretation, 1, badLog], { action: 'blocked', code: null, blockers: ['findings', 'job-log-not-completed'], reads: { remote: 0, log: 1 } }],
    [['none', clean, 1, badLog], { action: 'receipt', code: null, blockers: [], reads: { remote: 1, log: 0 } }],
    [['none', clean, 0, badLog], { action: 'blocked', code: null, blockers: ['job-log-not-completed'], reads: { remote: 1, log: 1 } }],
    [['none', clean, 0, goodLog], { action: 'dispatch', code: null, blockers: [], reads: { remote: 1, log: 1 } }],
  ];
  for (const [args, expected] of cases) assert.deepEqual(await decide(...args), expected, `${args[0]} autoPublish=${args[4]}`);
});

test('게시 직전 확인에서 판정 기록이 바뀌었거나 게시 이력이 생겼으면 요청하지 않음', async t => {
  const report = judgements.clean;
  for (const [name, mutate] of [['requested by another run', l => { l.publicationRequested = true; }], ['same state, different record', l => { l.parserVersion = 3; }]]) {
    await t.test(name, async t => {
      const s = await setup(t, { report, log: completeJobLog(report) });
      const current = collectPluginResult({ output: s.job.result, stored: { job: { status: 'completed' }, storedJob: s.job }, target: s.target,
        session: 'session-1', startedAt: '2026-11-09T00:00:00Z', checks: [] });
      writeFileSync(s.ledgerPath, JSON.stringify({ state: 'completed', target: s.target, session: 'session-1', result: current, parserVersion: 4 }));
      // 판정용 로딩(1회차) 뒤, 게시 직전 로딩(2회차) 전에 다른 실행이 기록을 바꾼 상황.
      let loads = 0; let changed = null;
      const files = { ...nodeFiles, read: path => {
        if (path === s.ledgerPath && ++loads === 2) {
          const ledger = JSON.parse(readFileSync(path, 'utf8')); mutate(ledger); changed = JSON.stringify(ledger); writeFileSync(path, changed);
        }
        return readFileSync(path, 'utf8');
      } };
      await assert.rejects(s.publish({ files }), error => error.code === 'review-publication-uncertain');
      assert.equal(readFileSync(s.ledgerPath, 'utf8'), changed); assert.equal(s.f.dispatches.length, 0);
    });
  }
});

test('기록한 영수증과 원격 영수증이 다르면 덮어쓰지 않고 충돌로 중단', async t => {
  const s = await transitionCase(t, { original: 'confirmed', legacy: 'absent', recovered: 'absent', judgement: 'clean', remote: true });
  const ledger = JSON.parse(readFileSync(s.ledgerPath, 'utf8'));
  ledger.publication.commentUrl = receiptStub.commentUrl;
  const text = JSON.stringify(ledger); writeFileSync(s.ledgerPath, text);
  await assert.rejects(s.publish(), error => error.code === 'review-publication-conflict');
  assert.equal(readFileSync(s.ledgerPath, 'utf8'), text); assert.equal(s.f.dispatches.length, 0);
});

// PR #42 3차 재검증 Medium 1: 이미 만든 v3 복구 기록을 다시 읽을 때도 v2 복구 기록을 처음 만들 때와 같은 기준으로 검증한다.
// v3 복구 기록에 v2 파일 hash가 맞게 기록돼 있어도 v2 기록의 내용(게시 이력·형식·연결·출처)을 확인한다.
// 4차: v2 복구 기록도 원본과 같은 독립 리뷰 계약(validateRecordResult)으로 검증한다. --recover는 안내만 하고, 유효한 기록도 관리자 검토 전용이다.
test('복구 기록이 있는 대상은 v2 복구 기록의 게시 이력·형식·연결·출처·독립 리뷰 계약을 원본과 같은 기준으로 검증', async t => {
  const cases = [
    ['requested', l => { l.publicationRequested = true; }],
    ['published', l => { l.publicationRequested = true; l.publication = { ...receiptStub }; }],
    ['requested false', l => { l.publicationRequested = false; }],
    ['requested null', l => { l.publicationRequested = null; }],
    ['empty publication', l => { l.publicationRequested = true; l.publication = {}; }],
    ['publication only', l => { l.publication = { ...receiptStub }; }],
    ['unknown field', l => { l.extra = 1; }],
    ['recovery extra', l => { l.recovery.publicationRequested = true; }],
    ['parser version', l => { l.recovery.parserVersion = 3; }],
    ['original hash', l => { l.recovery.originalLedgerHash = '0'.repeat(64); }],
    ['state', l => { l.state = 'captured'; }],
    ['session', l => { l.session = 'other-session'; }],
    ['target', l => { l.target.fingerprint = '0'.repeat(64); }],
    ['result version', l => { l.result.v = 3; }],
    ['result extra field', l => { l.result.reviewerChecks = []; }],
    ['findings format', l => { l.result.findings = { unknown: 0 }; }],
    ['report', l => { l.result.report += ' Hidden.'; l.result.source.outputHash = reportHash(l.result.report); }],
    ['job', l => { l.result.source.jobId = 'other-job'; }],
    ['source session', l => { l.result.source.sessionId = 'other-session'; }],
    ['source extra field', l => { l.result.source.extra = 1; }],
    ['role', l => { l.result.role = 'self'; }],
    ['reviewer', l => { l.result.reviewer = 'claude'; }],
    ['status', l => { l.result.status = 'failed'; }],
    ['not run missing', l => { l.result.notRun = []; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async t => {
    const s = await recoveryLedgers(t, { report: judgements.clean, log: completeJobLog(judgements.clean), legacyRecord: mutate });
    await assert.rejects(s.publish(), error => error.code === 'review-recovery-manual');
    await assert.rejects(s.recover(), error => error.code === 'review-recovery-retired');
    assert.equal(await s.attention(), 1); assert.match(s.cliErr.at(-1), /v2 복구 기록/);
    assert.equal(await s.attention('--confirm', s.post('# 독립 리뷰 보고서\n')), 1); assert.match(s.cliErr.at(-1), /v2 복구 기록/);
    s.unchanged();
    assert.deepEqual([s.calls.reviews, s.calls.reads, s.calls.jobReads, s.f.dispatches.length], [0, 0, 0, 0]);
  });
  await t.test('valid v2 record (control)', async t => {
    // 3차까지는 이 조합에서 dispatch 1회였다. 4차 복구 정책으로 복구 기록은 관리자 검토 전용이다.
    const s = await recoveryLedgers(t, { report: judgements.clean, log: completeJobLog(judgements.clean), legacyRecord: () => {} });
    assert.equal(await s.publish(), 2);
    assert.deepEqual(s.outputs[0].blockers, ['legacy-record']); assert.equal(s.outputs[0].adminDraft.state, 'ready');
    assert.deepEqual(s.outputs[0].interpretation.previous.map(item => item.record), ['original', 'legacyRecovered']);
    assert.equal(s.f.dispatches.length, 0); s.unchanged();
  });
});

// v2 복구 기록도 이전 판정 기록이다. v3 복구 기록이 v2 복구 기록보다 지적·unknown을 줄이면 원본과 마찬가지로 축소로 본다.
test('v3 복구 기록이 v2 복구 기록의 지적·unknown을 줄이면 일반 실행·초안·--confirm 모두 이전 판정을 유지하고 --recover는 안내만', async t => {
  for (const [name, raise, blockers] of [['medium', { medium: 1 }, ['findings', 'recovery-reduced']], ['unknown', { unknown: 1 }, ['findings', 'recovery-reduced']],
    ['low', { low: 1 }, ['recovery-reduced']]]) {
    await t.test(name, async t => {
      const s = await recoveryLedgers(t, { report: judgements.clean, log: completeJobLog(judgements.clean),
        legacyRecord: l => { Object.assign(l.result.findings, raise); } });
      const expected = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0, ...raise };
      assert.equal(await s.publish(), 2);
      const output = s.outputs.at(-1);
      assert.deepEqual(output.blockers, [...blockers, 'legacy-record']); assert.deepEqual(output.codeFindings, expected);
      assert.deepEqual(output.interpretation.previous.map(item => item.record), ['original', 'legacyRecovered']);
      assert.deepEqual(output.interpretation.previous[1].findings, expected);
      await assert.rejects(s.recover(), error => error.code === 'review-recovery-retired');
      assert.equal(await s.attention(), 0);
      assert.deepEqual(s.cliOut.at(-1).codeFindings, expected);
      const draft = readFileSync(s.cliOut.at(-1).draftPath, 'utf8');
      assert.match(draft, new RegExp(`\\| v2 복구 기록 저장 결과 \\(결과 v2, parser v2\\) \\| 0 \\| 0 \\| ${expected.medium} \\| ${expected.low} \\| ${expected.unknown} \\|`));
      const url = s.post(draft);
      if (expected.medium) { assert.equal(await s.attention('--confirm', url), 1); assert.match(s.cliErr.at(-1), /critical\/high\/medium/); }
      else { assert.equal(await s.attention('--confirm', url), 0); assert.deepEqual(s.cliOut.at(-1).confirmation.findings, expected); }
      s.unchanged(); assert.deepEqual([s.calls.reviews, s.f.dispatches.length], [0, 0]);
    });
  }
});

// PR #42 3차 재검증 Low: 출력·관리자 초안이 같은 유효 판정과 같은 실패 검사 집합을 쓰고, 출처(원본·v2 복구·복구 기록·현재 해석)를 구분한다.
test('원본에만 있는 unknown·검사 실패도 wrapper 출력·review:attention 출력·초안에 같은 값과 출처로 표시', async t => {
  await t.test('unknown: 원본 1, 복구 기록 0, 현재 0', async t => {
    const s = await recoveryLedgers(t, { original: l => { l.result.findings.unknown = 1; } });
    assert.equal(await s.publish(), 2);
    const output = s.outputs[0];
    assert.deepEqual(output.interpretation.recordedUnknown, [{ record: 'original', unknown: 1 }, { record: 'stored', unknown: 0 }]);
    assert.equal(output.interpretation.unexplainedStoredUnknown, 1); assert.equal(output.codeFindings.unknown, 1);
    const draft = readFileSync(output.adminDraft.draftPath, 'utf8');
    assert.doesNotMatch(draft, /저장된 unknown 0건 중/);
    assert.match(draft, /- 기록된 unknown은 원본 ledger 1건, 복구 기록 0건입니다\. 가장 큰 1건 중 1건은 현재 parser로 사유를 재현할 수 없습니다\./);
    assert.equal(await s.attention(), 0); assert.deepEqual(s.cliOut.at(-1).codeFindings, output.codeFindings);
    assert.deepEqual(s.cliOut.at(-1).interpretation, output.interpretation);
  });
  await t.test('검사 실패: 원본에만 있음', async t => {
    const failure = { name: 'privacyGuard', status: 'failed', count: null, cause: null };
    const s = await recoveryLedgers(t, { report: 'No findings. Lint passed. Build was not run.',
      original: l => { l.result.reviewerChecks = [...l.result.reviewerChecks, failure]; } });
    assert.equal(await s.publish(), 2);
    const output = s.outputs[0];
    assert.deepEqual(output.reviewerCheckFailures, [{ ...failure, sources: ['original'] }]);
    assert.deepEqual(output.interpretation.failedChecks, output.reviewerCheckFailures);
    const draft = readFileSync(output.adminDraft.draftPath, 'utf8');
    assert.match(draft, /- 판정에 쓰는 검사 실패\(모든 기록·해석의 합집합\): `privacyGuard`\(원본 ledger\)/);
    assert.match(draft, /`privacyGuard` 실패\(출처: 원본 ledger\)는 원인이 밝혀지지 않아/);
    assert.equal(await s.attention(), 0);
    assert.deepEqual(s.cliOut.at(-1).reviewerCheckFailures, output.reviewerCheckFailures);
    assert.deepEqual(s.cliOut.at(-1).codeFindings, output.codeFindings);
  });
  await t.test('같은 실패가 여러 기록·해석에 있으면 한 번만 쓰고 출처를 모두 남김', async t => {
    const s = await recoveryLedgers(t, { report: pr28Report });
    assert.equal(await s.publish(), 2);
    assert.deepEqual(s.outputs[0].reviewerCheckFailures.map(item => [item.name, item.sources]), [['privacyGuard', ['original', 'stored', 'current']]]);
  });
});

// PR #42 3차 재검증: 로그 완료 증거의 추가 경계 조건. 완료 표시가 충돌하거나 두 번 이상이면 fail-closed다.
test('완료 증거 경계: 다른 원문의 완료 블록·Final output 두 번·같은 완료 블록 중복·다른 job 로그 혼합은 인정하지 않음', async t => {
  const report = judgements.clean;
  const other = 'No actionable defects were found in a different review.';
  const end = jobLogEnd(report);
  const finalBlock = ['', `${at(58)} Final output`, '# Codex Review', '', report, ''];
  const cases = [
    // [이름, 로그 줄, 완료 증거, 기대 차단 사유]
    ['normal progress messages', [...jobLogStart, ...progress('Reasoning summary', ['- a']), ...progress('Assistant message', ['b'], 'Assistant message captured: b'), ...end],
      { reviewStarted: true, reviewOutput: true, finalOutput: true }, []],
    ['other report completion block before matching block', [...jobLogStart, ...fakeReviewOutput(other), ...end],
      { reviewStarted: true, reviewOutput: false, finalOutput: false }, ['job-log-not-completed']],
    ['other report completion block inside progress block', [...jobLogStart, ...progress('Assistant message', ['quote:', ...fakeReviewOutput(other)]), ...end],
      { reviewStarted: true, reviewOutput: false, finalOutput: false }, ['job-log-not-completed']],
    ['matching block then other report block', [...jobLogStart, ...end.slice(0, 5), ...fakeReviewOutput(other), ...end.slice(5)],
      { reviewStarted: true, reviewOutput: false, finalOutput: false }, ['job-log-not-completed']],
    ['final output twice', [...jobLogStart, ...end.slice(0, 5), ...finalBlock, ...end.slice(5)],
      { reviewStarted: true, reviewOutput: true, finalOutput: false }, ['job-log-not-completed']],
    ['final output twice (both after review)', [...jobLogStart, ...end, ...finalBlock],
      { reviewStarted: true, reviewOutput: true, finalOutput: false }, ['job-log-not-completed']],
    ['same completion block twice', [...jobLogStart, ...end.slice(0, 5), ...end.slice(0, 5), ...end.slice(5)],
      { reviewStarted: true, reviewOutput: false, finalOutput: false }, ['job-log-not-completed']],
    ['reviewer finished twice', [...jobLogStart, ...end.slice(0, 5), `${at(40)} Reviewer finished.`, ...end.slice(5)],
      { reviewStarted: true, reviewOutput: false, finalOutput: false }, ['job-log-not-completed']],
    ['another job log appended', [...jobLogStart, ...end, ...jobLogStart, ...end],
      { reviewStarted: false, reviewOutput: false, finalOutput: false }, ['job-log-not-completed']],
    ['truncated after review output', [...jobLogStart, ...end.slice(0, 4)],
      { reviewStarted: true, reviewOutput: false, finalOutput: false }, ['job-log-not-completed']],
    ['different job report', [...jobLogStart, ...jobLogEnd(other)],
      { reviewStarted: true, reviewOutput: false, finalOutput: false }, ['job-log-not-completed']],
  ];
  for (const [name, lines, completion, blockers] of cases) await t.test(name, async t => {
    assert.deepEqual(parseJobCommands(lines.join('\n'), report).completion, completion);
    const s = await setup(t, { report, log: lines.join('\n') });
    if (!blockers.length) {
      await assert.rejects(s.publish(), /완료를 확인하지 못함/); assert.equal(s.f.dispatches.length, 1);
    } else {
      assert.equal(await s.publish(), 2);
      assert.deepEqual(s.outputs[0].blockers, blockers); assert.equal(s.f.dispatches.length, 0);
    }
  });
});

// 원본 ledger 하나(최신 형식 v3·현재 parser)를 만들고 바꾼다.
async function originalOnly(t, { report = judgements.clean, mutate = () => {} } = {}) {
  const s = await setup(t, { report, log: completeJobLog(report) });
  const current = collectPluginResult({ output: s.job.result, stored: { job: { status: 'completed' }, storedJob: s.job }, target: s.target,
    session: 'session-1', startedAt: '2026-11-09T00:00:00Z', checks: [] });
  const ledger = { state: 'completed', target: structuredClone(s.target), session: 'session-1', result: current, parserVersion };
  mutate(ledger);
  const text = JSON.stringify(ledger);
  writeFileSync(s.ledgerPath, text);
  return { ...s, current, text, unchanged: () => assert.equal(readFileSync(s.ledgerPath, 'utf8'), text) };
}

// PR #42 4차 재검증 Medium: 복구 과정에서 독립성 정보(role·reviewer)가 새 값으로 대체되던 문제.
// 3차까지 --recover는 원본·v2 복구 기록의 role·reviewer를 확인하지 않았고, collectPluginResult가 independent/codex로 결과를 다시 만들어
// 복구본을 쓰고 dispatch했다. 이제 모든 기록을 validateRecordResult(수집 결과 검증과 같은 의미 검증)로 확인하고, 모순된 기록은 보정하지 않으며
// 일반 실행·관리자 초안·--confirm 모두 중단한다. --recover는 기록을 읽지도 않고 안내만 한다.
test('독립 리뷰 계약(역할·리뷰어)이 원본·v2 복구·v3 복구 기록 중 하나라도 다르면 보정하지 않고 일반 실행·--recover·초안·--confirm 모두 중단', async t => {
  const clean = { report: judgements.clean, log: completeJobLog(judgements.clean) };
  const role = l => { l.result.role = 'self'; };
  const reviewer = l => { l.result.reviewer = 'claude'; };
  const cases = [
    // [이름, 기록 만들기, 일반 실행 중단 코드]
    ['원본 role self(복구 기록 없음)', t => originalOnly(t, { mutate: role }), 'review-attention-ledger-invalid'],
    ['원본 reviewer claude(복구 기록 없음)', t => originalOnly(t, { mutate: reviewer }), 'review-attention-ledger-invalid'],
    ['원본 role self + v3 복구 기록', t => recoveryLedgers(t, { ...clean, original: role }), 'review-recovery-manual'],
    ['원본 reviewer claude + v3 복구 기록', t => recoveryLedgers(t, { ...clean, original: reviewer }), 'review-recovery-manual'],
    ['v2 원본 role self + v2 복구 기록(v3 복구 전)', t => recoveryLedgers(t, { ...clean, original: role, legacyRecord: () => {}, withRecovered: false }), 'review-recovery-manual'],
    ['v2 복구 기록만 role self(v3 복구 전)', t => recoveryLedgers(t, { ...clean, legacyRecord: role, withRecovered: false }), 'review-recovery-manual'],
    ['v2 복구 기록만 reviewer claude(v3 복구 전)', t => recoveryLedgers(t, { ...clean, legacyRecord: reviewer, withRecovered: false }), 'review-recovery-manual'],
    ['v2 복구 기록만 role self(v3 복구 후)', t => recoveryLedgers(t, { ...clean, legacyRecord: role }), 'review-recovery-manual'],
    ['v3 복구 기록만 role self', t => recoveryLedgers(t, { ...clean, recovered: role }), 'review-recovery-manual'],
    ['v3 복구 기록만 reviewer claude', t => recoveryLedgers(t, { ...clean, recovered: reviewer }), 'review-recovery-manual'],
  ];
  for (const [name, make, code] of cases) await t.test(name, async t => {
    const s = await make(t);
    const before = snapshot(s);
    await assert.rejects(s.publish(), error => error.code === code);
    await assert.rejects(s.publish({ options: { repository: 'owner/repo', number: 1, session: 'session-1', recover: true } }),
      error => error.code === 'review-recovery-retired');
    assert.equal(await s.attention(), 1); assert.match(s.cliErr.at(-1), /독립 리뷰 계약/);
    assert.equal(await s.attention('--confirm', s.post('# 독립 리뷰 보고서\n')), 1); assert.match(s.cliErr.at(-1), /독립 리뷰 계약/);
    // 복구본·초안·확인 문구·job 로그 사본 어느 것도 만들지 않고 기존 기록을 바꾸지 않는다.
    assert.deepEqual(snapshot(s), before); s.unchanged();
    assert.deepEqual([s.calls.reviews, s.calls.reads, s.calls.jobReads, s.f.dispatches.length], [0, 0, 0, 0]);
  });
});

// 4차 복구 정책: 유효한 구형 기록(v2 원본, v2 복구 기록, 이전 parser 원본)은 원문·기록별 판정·검사 실패와 출처를 보존한 관리자 자료로 쓴다.
// 자동 게시하지 않으며, 차단 지적이 남아 있으면 통과 확인 문구를 만들지 않는다.
test('유효한 구형 기록은 원문·기록별 판정·검사 실패와 출처를 보존한 관리자 초안을 만들고 차단 지적이 없을 때만 확인 문구를 준비', async t => {
  await t.test('v2 원본만(PR #28 형태: 원본 unknown 1, 검사 기록 없음)', async t => {
    const s = await setup(t, { report: pr28Report, log: completeJobLog(pr28Report) });
    const current = collectPluginResult({ output: s.job.result, stored: { job: { status: 'completed' }, storedJob: s.job }, target: s.target,
      session: 'session-1', startedAt: '2026-11-09T00:00:00Z', checks: [] });
    const result = { ...current, v: 2, findings: { ...current.findings, unknown: 1 } }; delete result.reviewerChecks;
    const text = JSON.stringify({ state: 'completed', target: s.target, session: 'session-1', result });
    writeFileSync(s.ledgerPath, text);
    assert.equal(await s.publish(), 2);
    const output = s.outputs[0];
    assert.deepEqual(output.blockers, ['findings', 'reviewer-check-failed', 'parser-mismatch', 'legacy-record']);
    assert.deepEqual(output.codeFindings, { critical: 0, high: 0, medium: 0, low: 0, unknown: 1 }); assert.equal(output.reviewerChecks, null);
    assert.deepEqual(output.reviewerCheckFailures.map(item => [item.name, item.sources]), [['privacyGuard', ['current']]]);
    const draft = readFileSync(output.adminDraft.draftPath, 'utf8');
    assert.ok(draft.includes(pr28Report));
    assert.match(draft, /\| 리뷰 당시 저장 결과 \(결과 v2, parser 버전 기록 없음[^|]*\| 0 \| 0 \| 0 \| 0 \| 1 \|/);
    assert.match(draft, /- 판정 기록의 결과\(v2\)에는 리뷰어 검사 기록이 없습니다\./);
    assert.match(draft, /`privacyGuard`\(현재 parser 재해석\)/);
    assert.match(draft, /- 기록 구분: 구형 기록, 관리자 검토 전용\(원본 결과 형식 v2, 원본 parser 버전 기록 없음\(현재 v4\)\)/);
    assert.equal(await s.attention(), 0); assert.deepEqual(s.cliOut.at(-1).blockers, output.blockers);
    assert.equal(s.cliOut.at(-1).draftPath, output.adminDraft.draftPath);
    // 차단 지적(critical/high/medium)이 없으므로 관리자 판단용 확인 문구는 준비한다(unknown·검사 실패는 관리자가 판단). 원본의 unknown 1을 그대로 넣는다.
    assert.equal(await s.attention('--confirm', s.post(draft)), 0);
    assert.deepEqual(s.cliOut.at(-1).confirmation.findings, { critical: 0, high: 0, medium: 0, low: 0, unknown: 1 });
    assert.equal(readFileSync(s.ledgerPath, 'utf8'), text);
    assert.deepEqual([s.calls.reviews, s.calls.reads, s.f.dispatches.length], [0, 0, 0]);
  });
  await t.test('v2 원본 + v2 복구 기록(v3 복구 전)', async t => {
    const s = await recoveryLedgers(t, { report: judgements.clean, log: completeJobLog(judgements.clean), legacyRecord: () => {}, withRecovered: false });
    assert.equal(await s.publish(), 2);
    const output = s.outputs[0];
    assert.deepEqual(output.blockers, ['parser-mismatch', 'legacy-record']);
    assert.deepEqual(output.interpretation.previous.map(item => item.record), ['original']); assert.equal(output.interpretation.stored.parserVersion, 2);
    const draft = readFileSync(output.adminDraft.draftPath, 'utf8');
    assert.match(draft, /\| 원본 ledger 저장 결과 \(결과 v2, parser 버전 기록 없음/);
    assert.match(draft, /\| 복구 기록 저장 결과 \(결과 v2, parser v2\)/);
    assert.match(draft, /복구 기록\(복구 시 parser v2\)/);
    assert.match(draft, /- 기록 구분: 구형 기록, 관리자 검토 전용\(복구 기록 있음[^)]*\), 원본 결과 형식 v2, /);
    assert.equal(await s.attention('--confirm', s.post(draft)), 0);
    assert.deepEqual(s.cliOut.at(-1).confirmation.findings, { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 });
    s.unchanged(); assert.deepEqual([s.calls.reviews, s.calls.reads, s.f.dispatches.length], [0, 0, 0]);
  });
  await t.test('차단 지적이 남은 이전 parser 원본은 초안만 만들고 확인 문구를 만들지 않음', async t => {
    const s = await originalOnly(t, { mutate: l => { delete l.parserVersion; l.result.findings.medium = 1; } });
    assert.equal(await s.publish(), 2);
    assert.deepEqual(s.outputs[0].blockers, ['findings', 'parser-mismatch', 'legacy-record']);
    const draft = readFileSync(s.outputs[0].adminDraft.draftPath, 'utf8');
    assert.match(draft, /차단 지적 1건이 있습니다/);
    assert.equal(await s.attention('--confirm', s.post(draft)), 1); assert.match(s.cliErr.at(-1), /critical\/high\/medium/);
    assert.ok(!s.files().some(name => name.includes('.review-gate-')));
    s.unchanged(); assert.equal(s.f.dispatches.length, 0);
  });
});

// 4차 복구 정책: --recover는 자동 게시용 복구본을 만들지 않는다. 기록 상태와 관계없이 GitHub 조회·lock·파일 쓰기·plugin 호출 없이 안내만 한다.
test('--recover는 기록 상태와 관계없이 조회·모델 호출·복구본 생성·dispatch 없이 관리자 검토 안내만 함', async t => {
  const clean = { report: judgements.clean, log: completeJobLog(judgements.clean) };
  const states = [
    ['기록 없음', t => setup(t, clean)],
    ['최신 원본(게시 이력 없음)', t => originalOnly(t)],
    ['최신 원본(게시 요청함)', t => originalOnly(t, { mutate: l => { l.publicationRequested = true; } })],
    ['v2 원본', t => recoveryLedgers(t, { ...clean, legacyRecord: () => {}, withRecovered: false }).then(s => { unlinkSync(`${s.ledgerPath}.recovered.json`); return s; })],
    ['원본 + v2 복구 기록', t => recoveryLedgers(t, { ...clean, legacyRecord: () => {}, withRecovered: false })],
    ['원본 + v3 복구 기록', t => recoveryLedgers(t, clean)],
    ['실행 중 기록', async t => { const s = await setup(t, clean); writeFileSync(s.ledgerPath, JSON.stringify({ state: 'running', target: s.target, session: 'session-1', startedAt: 'x' })); return s; }],
  ];
  for (const [name, make] of states) await t.test(name, async t => {
    const s = await make(t);
    const before = snapshot(s);
    await assert.rejects(s.publish({ options: { repository: 'owner/repo', number: 1, session: 'session-1', recover: true } }), error => {
      assert.equal(error.code, 'review-recovery-retired');
      const text = pluginPublicationFailureMessage(error);
      assert.match(text, /--recover 자동 복구는 중단됐습니다/); assert.match(text, /관리자 검토 전용/);
      assert.match(text, /npm run review:attention/); assert.match(text, /수정하지 않았고 GitHub 조회·리뷰 호출·게시 요청도 하지 않았습니다/);
      return true;
    });
    assert.deepEqual(snapshot(s), before); assert.deepEqual(s.ghCalls, []);
    assert.deepEqual(s.calls, { reviews: 0, reads: 0, jobReads: 0 }); assert.equal(s.f.dispatches.length, 0);
  });
});

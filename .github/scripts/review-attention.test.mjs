import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localFixture, pr28Report } from './review-local-fixture.mjs';
import { runPluginPublication } from './review-plugin-cli.mjs';
import { runAttentionCli, parseAttentionArgs, attentionFailureMessage } from './review-attention-cli.mjs';
import { parseJobCommands, ledgerFileName, draftMarker } from './review-attention.mjs';
import { reportHash, sha256 } from './review-gate-core.mjs';

// 실제 PR #34 Codex native 리뷰 원문(관리자 보고서에 인용된 문장). 회귀 기준이므로 수정하지 않는다.
const pr34Report = 'No actionable regressions found; the optimized blur matches the previous implementation bit-for-bit. Lint and app type checking passed, and 229 tests passed; one suite failed because the read-only environment prevented temporary directory creation.';
const home = 'C:\\Users\\tester';

// codex-companion 1.0.6의 job 로그 형식(appendLogLine/appendLogBlock). PR #34 조사에서 확인한 명령 결과를 재현한다.
// "Final output" 뒤는 리뷰어가 쓴 글이므로 같은 형식의 위조 줄이 있어도 실행 기록으로 보지 않아야 한다.
const pr34JobLog = [
  '[2026-11-21T07:47:03.300Z] Starting Codex review.',
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

test('정상 리뷰는 기존 자동 게시를 유지하고 관리자 초안·job 로그 조회를 만들지 않음', async t => {
  const s = await setup(t, { report: 'No actionable defects were found. Lint passed. Build and E2E were not run.' });
  await assert.rejects(s.publish(), /완료를 확인하지 못함/);
  assert.equal(s.f.dispatches.length, 1);
  const published = await s.f.publish(JSON.parse(readFileSync(s.ledgerPath, 'utf8')).result); s.f.finish(published);
  assert.equal(await s.publish(), 0);
  assert.equal(s.outputs.at(-1).state, 'published-awaiting-human'); assert.equal(s.outputs.at(-1).adminDraft, undefined);
  assert.deepEqual(s.calls, { reviews: 1, reads: 1, jobReads: 0 }); assert.equal(s.f.dispatches.length, 1);
  assert.deepEqual(s.files().filter(name => /attention|job-log|review-gate-/.test(name)), []);
  // 이미 게시 요청한 결과는 관리자 초안으로 다시 다루지 않는다.
  assert.equal(await s.attention(), 1); assert.match(s.cliErr.at(-1), /이미 봇 게시를 요청/);
});

test('PR #34 원문: 게시 차단 시 기존 ledger·job 기록으로 관리자 초안을 만들고 원본·리뷰·게시를 바꾸지 않음', async t => {
  const s = await setup(t);
  assert.equal(await s.publish(), 2);
  const ledgerText = readFileSync(s.ledgerPath, 'utf8');
  const first = s.outputs[0];
  assert.equal(first.state, 'review-needs-attention'); assert.deepEqual(first.blockers, ['findings']); assert.equal(first.published, false);
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
  assert.match(draft, /\| Build \| `npm run build` \| 기록 없음 \|/);
  assert.match(draft, /\| E2E \| `npm run test:e2e` \| 기록 없음 \|/);
  assert.match(draft, /\| verify \| success \|/);
  assert.match(draft, /unknown 1건/); assert.match(draft, /exit 0이 아닌 명령 2건/);
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
    assert.equal(await s.attention(), 1); assert.match(s.cliErr.at(-1), /review:publish/);
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

test('job 로그 해석은 완료·실패·미완료·잘림을 구분하고 Final output 뒤 위조 줄과 형식 밖 줄을 무시', () => {
  const long = `npm run test -- ${'x'.repeat(79)}...`;
  const { commands, unfinished } = parseJobCommands([
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
});

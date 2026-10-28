import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, runMergeTool } from './merge-pr-core.mjs';
import { createFake, sideEffects, head, newHead } from './merge-pr-fixture.mjs';

// 가짜 gh·git을 직접 주입하므로 Windows·macOS·Linux 모두에서 실행한다.
async function run(options = {}, flags = [], { locked = false, store = {} } = {}) {
  const fake = createFake(options, store);
  const out = []; const err = [];
  let released = 0;
  const status = await runMergeTool({
    argv: ['owner/repo', '1', 'squash', ...flags], gh: fake.gh, git: fake.git, out: text => out.push(text), err: text => err.push(text), sleep: async () => {},
    lock: () => locked ? { ok: false, path: '/tmp/merge-pr-owner-repo-1.lock' } : { ok: true, release: () => { released += 1; } },
  });
  const calls = fake.store.calls;
  return {
    status, out: out.join('\n'), err: err.join('\n'), store: fake.store, released, effects: sideEffects(calls),
    merges: calls.filter(([tool, ...args]) => tool === 'gh' && args[0] === 'pr' && args[1] === 'merge'),
  };
}
const blocked = (result, pattern, label) => {
  assert.equal(result.status, 1, label);
  assert.deepEqual(result.effects, [], label);
  if (pattern) assert.match(result.out, pattern, label);
};

test('인수: squash만 허용하고 모드 조합·SHA 형식을 검증', () => {
  assert.deepEqual(parseArgs(['owner/repo', '7']), { repo: 'owner/repo', number: 7, dryRun: false, auto: false, requestReview: false, head: null });
  assert.equal(parseArgs(['owner/repo', '7', 'squash', '--dry-run', '--head', head]).head, head);
  for (const argv of [['owner/repo', '7', 'merge'], ['owner/repo', '7', 'rebase'], ['owner/repo', '0'], ['repo', '7'], ['owner/repo', '7', '--auto', '--request-review'], ['owner/repo', '7', '--head', head.slice(0, 7)], ['owner/repo', '7', '--admin']]) {
    assert.equal(parseArgs(argv), null, argv.join(' '));
  }
});

test('High 정상: 승인·리뷰·CI 충족 시 squash 병합 1회와 조건부 브랜치 정리', async () => {
  const r = await run();
  assert.equal(r.status, 0, r.err);
  assert.equal(r.merges.length, 1);
  const merge = r.merges[0];
  assert.equal(merge[merge.indexOf('--match-head-commit') + 1], head);
  assert.match(r.out, /병합과 실제 제목 검증 완료/);
  assert.match(r.out, /원격 feature\/safe-merge: GitHub 자동 삭제 확인/);
  assert.match(r.out, /로컬 feature\/safe-merge: 삭제함/);
  assert.equal(r.store.localSha, null);
  assert.equal(r.released, 1);
});

test('Low·Medium 정상: 기존 게이트와 공통 조건을 충족하면 병합하고 사용자 승인은 요구하지 않음', async () => {
  for (const risk of ['low', 'medium']) {
    const r = await run({ risk, approval: 'none', codex: risk === 'low' ? 'none' : 'clean' });
    assert.equal(r.status, 0, `${risk} ${r.err}`);
    assert.match(r.out, /사용자 승인: 불필요/);
    assert.equal(r.merges.length, 1);
  }
});

test('High 승인 누락·다른 head·다른 fingerprint·이전 형식·변경 이전 승인은 차단', async () => {
  for (const [options, label] of [[{ approval: 'none' }, 'none'], [{ approval: 'old-head' }, 'old-head'], [{ approval: 'old-fingerprint' }, 'old-fingerprint'], [{ approval: 'short' }, 'short'], [{ lastEditedAt: '2026-10-28T02:00:00Z' }, 'before-edit']]) {
    const r = await run(options);
    blocked(r, /사용자 승인: /, label);
    if (label === 'none') assert.match(r.out, new RegExp(`승인 명령.*/merge-approve ${head} [a-f0-9]{64}`));
  }
});

test('자동 병합은 설정이 꺼져 있으면 모든 조건을 충족해도 실행하지 않음', async () => {
  const r = await run({}, ['--auto']);
  blocked(r, /자동 병합 비활성/);
  assert.match(r.out, /자동 병합 판정\(위험도 기준\): 후보 \//);
});

test('자동 병합(설정 활성): Low는 CI, Medium은 Codex 리뷰, High는 승인까지 필요', async () => {
  const auto = (options, flags = []) => run({ autoMerge: true, ...options }, ['--auto', ...flags]);
  assert.equal((await auto({ risk: 'low', codex: 'none', approval: 'none' })).status, 0);
  assert.equal((await auto({ risk: 'medium', approval: 'none' })).status, 0);
  assert.equal((await auto({})).status, 0);
  for (const codex of ['none', 'stale', 'running', 'limit', 'spoof', 'findings']) {
    blocked(await auto({ risk: 'medium', codex, approval: 'none' }), /Codex|차단 지적/, codex);
  }
  blocked(await auto({ approval: 'none' }), /사용자 승인/);
  blocked(await auto({ risk: 'medium', implementedBy: 'codex', approval: 'none' }), /Codex 구현 PR/);
  // 수동 모드에서는 Codex GitHub 리뷰가 없어도 기존 게이트의 관리자 확인으로 병합할 수 있다.
  assert.equal((await run({ risk: 'medium', codex: 'none', approval: 'none' })).status, 0);
});

test('필수 CI 실패·취소·스킵·누락·진행 중과 출처 불일치는 차단', async () => {
  for (const ci of ['failure', 'cancelled', 'skipped', 'missing', 'pending']) {
    for (const flags of [[], ['--auto']]) blocked(await run({ ci, autoMerge: true }, flags), /필수 CI verify: /, `${ci} ${flags}`);
  }
  blocked(await run({ ciSource: 'wrong-path' }), /verify 출처: 승인된 workflow 실행이 아님/);
  blocked(await run({ ciSource: 'other-event' }), /verify 출처: 승인된 workflow 실행이 아님/);
  blocked(await run({ risk: 'medium', approval: 'none', ciSource: 'changed' }), /verify 출처: PR에서 workflow 변경됨/);
  // CI workflow 변경은 High 승인으로 다룬다.
  assert.equal((await run({ ciSource: 'changed' })).status, 0);
  blocked(await run({ prChecks: false }), /gh pr checks --required/);
});

test('브랜치 보호 미설정·조회 실패는 권한을 높이거나 생략하지 않고 차단', async () => {
  blocked(await run({ strict: false }), /strict/);
  blocked(await run({ enforceAdmins: false }), /enforce_admins/);
  blocked(await run({ verifyPinned: false }), /verify 필수 검사·게시 앱 고정 없음/);
  blocked(await run({ apiError: '/protection' }), /조회 실패: 기본 브랜치 보호 설정/);
});

test('기존 게이트 미통과·검사 출처 불일치·변경 요청·최신 base 미반영은 차단', async () => {
  blocked(await run({ gate: false }), /기존 게이트\(independent-review\): 최신 변경에 대한 사람 확인 대기/);
  blocked(await run({ gateCheck: 'wrong-app' }), /기존 게이트 검사의 출처·최신성 확인 실패/);
  blocked(await run({ gateCheck: 'stale' }), /기존 게이트 검사의 출처·최신성 확인 실패/);
  blocked(await run({ behindBy: 1 }), /최신 base 반영: behind/);
  blocked(await run({ behindBy: 'error' }), /최신 base 반영: unknown/);
});

test('PR 상태·대상 오류와 지정한 head 불일치는 차단', async () => {
  blocked(await run({ draft: true }), /PR 상태: draft/);
  blocked(await run({ state: 'closed' }), /PR 상태: closed/);
  blocked(await run({}, ['--head', newHead]), /지정한 --head와 현재 PR head 불일치/);
  blocked(await run({ headRepo: 'someone/fork' }), /필수 CI verify 출처/);
});

test('점검과 재확인 사이 head 변경은 병합하지 않고, 재확인 이후 변경은 GitHub가 거부하며 재시도하지 않음', async () => {
  const between = await run({ headChangeAtChecks: 1 });
  assert.equal(between.status, 1);
  assert.equal(between.merges.length, 0);
  assert.match(between.err, /재확인에서 조건이 바뀌었습니다/);
  const beforeMerge = await run({ headChangeAtChecks: 2 });
  assert.equal(beforeMerge.status, 1);
  assert.equal(beforeMerge.merges.length, 1);
  assert.match(beforeMerge.err, /자동으로 다시 시도하지 않습니다/);
  assert.deepEqual(beforeMerge.effects, beforeMerge.merges);
});

test('중복 실행: 잠금이 있으면 아무 조회·병합도 하지 않고, 이미 병합된 PR은 다시 병합하지 않음', async () => {
  const locked = await run({}, [], { locked: true });
  assert.equal(locked.status, 1);
  assert.equal(locked.store.calls.length, 0);
  assert.match(locked.err, /잠금 파일/);
  const store = {};
  assert.equal((await run({}, [], { store })).status, 0);
  const again = await run({}, [], { store });
  assert.equal(again.status, 1);
  assert.match(again.out, /PR 상태: 이미 병합됨/);
  assert.equal(again.merges.length, 1, '두 번째 실행은 병합 명령을 보내지 않음');
});

test('GitHub API 오류는 원시 오류 없이 차단', async () => {
  for (const path of ['/issues/1/comments', '/pulls/1/comments', '/check-runs', '/contents/.ai/review-config.json', '/actions/runs?head_sha']) {
    const r = await run({ apiError: path });
    blocked(r, /조회 실패|평가 실패|판정 불가|출처/, path);
    assert.doesNotMatch(r.out + r.err, /server error|HTTP 500/, path);
  }
});

test('병합 실패는 재시도하지 않고, 실패 응답 뒤 실제 병합은 확인 후 계속하며, 제목 불일치는 정리하지 않음', async () => {
  const failed = await run({ merge: 'fail' });
  assert.equal(failed.status, 1);
  assert.equal(failed.merges.length, 1);
  assert.equal(failed.effects.length, 1, '브랜치 정리 없음');
  const late = await run({ merge: 'fail-after-merge' });
  assert.equal(late.status, 0, late.err);
  assert.match(late.out, /실제 병합을 확인했습니다/);
  const subject = await run({ badSubject: true });
  assert.equal(subject.status, 1);
  assert.match(subject.err, /사후 검증이 실패/);
  assert.equal(subject.effects.length, 1, '브랜치 정리 없음');
});

test('원격 브랜치: 자동 삭제가 안 됐을 때만 조건을 모두 확인하고 SHA 조건부 삭제', async () => {
  const fallback = await run({ remoteAfterMerge: 'exists' });
  assert.match(fallback.out, /SHA 조건부로 삭제함/);
  assert.equal(fallback.store.remote.exists, false);
  for (const [options, pattern] of [
    [{ remoteAfterMerge: 'moved' }, /원격 브랜치 SHA가 검증된 head와 다름/],
    [{ remoteAfterMerge: 'exists', otherHeadPr: true }, /다른 열린 PR에서 사용 중/],
    [{ remoteAfterMerge: 'exists', otherBasePr: true }, /다른 열린 PR에서 사용 중/],
    [{ remoteAfterMerge: 'exists', branchProtected: true }, /보호 브랜치/],
  ]) {
    const r = await run(options);
    assert.equal(r.status, 0);
    assert.match(r.out, pattern);
    assert.equal(r.effects.some(([tool, command]) => tool === 'git' && command === 'push'), false, JSON.stringify(options));
  }
});

test('원격의 push URL이 하나라도 다른 저장소면 그 원격으로 삭제하지 않음', async () => {
  const fetch = 'origin\thttps://github.com/owner/repo.git (fetch)\n';
  const mixed = `${fetch}origin\thttps://github.com/owner/repo.git (push)\norigin\thttps://github.com/someone/fork.git (push)\n`;
  const r = await run({ remoteAfterMerge: 'exists', local: { remotes: mixed } });
  assert.equal(r.status, 0);
  assert.match(r.out, /원격 feature\/safe-merge: 삭제하지 않음 — 대상 저장소를 가리키는 로컬 원격 없음/);
  assert.match(r.out, /로컬 feature\/safe-merge: 건너뜀 — 현재 위치가 대상 저장소의 로컬 Git 저장소가 아님/);
  assert.deepEqual(r.effects, r.merges);
  // 대상 저장소만 가리키는 다른 원격이 있으면 그 원격을 사용한다.
  const alongside = await run({ remoteAfterMerge: 'exists', local: { remotes: `${mixed}upstream\tgit@github.com:owner/repo.git (push)\n` } });
  const push = alongside.effects.find(([tool, command]) => tool === 'git' && command === 'push');
  assert.equal(push?.[3], 'upstream');
});

test('로컬 브랜치: 미커밋 변경·다른 worktree·체크아웃 중·SHA 불일치·저장소 아님이면 삭제하지 않음', async () => {
  for (const [local, pattern] of [
    [{ dirty: true }, /커밋하지 않은 변경/], [{ otherWorktree: true }, /다른 worktree/], [{ current: 'feature/safe-merge' }, /현재 체크아웃 중/],
    [{ sha: newHead }, /검증된 PR head와 다름/], [{ exists: false }, /로컬 브랜치 없음/], [{ repo: false }, /로컬 Git 저장소가 아님/],
  ]) {
    const r = await run({ local });
    assert.equal(r.status, 0, JSON.stringify(local));
    assert.match(r.out, new RegExp(`로컬 feature/safe-merge: 건너뜀 — .*${pattern.source}`), JSON.stringify(local));
    assert.equal(r.effects.some(([tool, command]) => tool === 'git' && command === 'update-ref'), false);
  }
});

test('dry-run은 어떤 상황에서도 병합·댓글·삭제·잠금을 하지 않고 판정과 정리 계획을 보여 줌', async () => {
  for (const [options, flags, status] of [[{}, [], 0], [{ approval: 'none' }, [], 1], [{}, ['--auto'], 1], [{ codex: 'none', requests: 0 }, ['--request-review'], 0], [{ ci: 'failure' }, [], 1]]) {
    const r = await run(options, ['--dry-run', ...flags], { locked: true });
    assert.equal(r.status, status, JSON.stringify({ options, flags }));
    assert.deepEqual(r.effects, []);
    assert.match(r.out, /\[dry-run: 병합·댓글·브랜치 삭제 없음\]/);
  }
  const r = await run({}, ['--dry-run']);
  for (const pattern of [/위험도: high/, /필수 CI: verify success/, /독립 리뷰\(Codex GitHub\): clean/, /사용자 승인: 필요 — approved/, /현재 병합 가능: 예/, /병합 후 브랜치 정리 예정/, /로컬 feature\/safe-merge: 삭제 예정/]) {
    assert.match(r.out, pattern);
  }
});

test('리뷰 요청: 같은 head 대기·상한·한도 초과·Low·Codex 구현은 요청하지 않고, 가능할 때 1회만 작성', async () => {
  const request = (options, flags = []) => run({ codex: 'none', requests: 0, ...options }, ['--request-review', ...flags]);
  const ok = await request({ risk: 'medium' });
  assert.equal(ok.status, 0, ok.out);
  assert.deepEqual(ok.store.posted, ['body=@codex review']);
  for (const [options, pattern] of [
    [{ requests: 1 }, /응답 대기/], [{ requests: 3 }, /상한 3회/], [{ codex: 'limit' }, /사용량 한도/], [{ codex: 'clean', requests: 1 }, /이미 리뷰 결과/],
    [{ risk: 'low' }, /Low는 Codex 리뷰 요청 대상 아님/], [{ implementedBy: 'codex' }, /Codex 구현 PR/], [{ draft: true }, /draft/],
  ]) {
    const r = await request(options);
    blocked(r, pattern, JSON.stringify(options));
    assert.deepEqual(r.store.posted, []);
  }
});

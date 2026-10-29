import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseArgs, runMergeTool, trustedModules } from './merge-pr-core.mjs';
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
  assert.deepEqual(result.store.posted, [], label);
  if (pattern) assert.match(result.out, pattern, label);
};

test('인수: squash만 허용하고 제거된 자동 병합·리뷰 요청 옵션과 잘못된 SHA는 거부', () => {
  assert.deepEqual(parseArgs(['owner/repo', '7']), { repo: 'owner/repo', number: 7, dryRun: false, head: null });
  assert.equal(parseArgs(['owner/repo', '7', 'squash', '--dry-run', '--head', head]).head, head);
  for (const argv of [['owner/repo', '7', 'merge'], ['owner/repo', '7', 'rebase'], ['owner/repo', '0'], ['repo', '7'], ['owner/repo', '7', '--auto'], ['owner/repo', '7', '--request-review'],
    ['owner/repo', '7', '--head', head.slice(0, 7)], ['owner/repo', '7', '--admin']]) {
    assert.equal(parseArgs(argv), null, argv.join(' '));
  }
});

test('High 정상: 승인·리뷰·CI 충족 시 squash 병합 1회, 병합 후 감사 통과, 조건부 브랜치 정리', async () => {
  const r = await run();
  assert.equal(r.status, 0, r.err);
  assert.equal(r.merges.length, 1);
  const merge = r.merges[0];
  assert.equal(merge[merge.indexOf('--match-head-commit') + 1], head);
  assert.match(r.out, /병합과 실제 제목 검증 완료/);
  assert.match(r.out, /병합 후 감사: 게이트 근거가 병합 직전 재확인과 같음/);
  assert.match(r.out, /원격 feature\/safe-merge: GitHub 자동 삭제 확인/);
  assert.match(r.out, /로컬 feature\/safe-merge: 삭제함/);
  assert.equal(r.store.localSha, null);
  assert.equal(r.released, 1);
  assert.deepEqual(r.store.posted, []);
});

test('Low·Medium 정상: 기존 게이트와 공통 조건을 충족하면 병합하고 사용자 승인은 요구하지 않음', async () => {
  for (const risk of ['low', 'medium']) {
    const r = await run({ risk, approval: 'none', codex: risk === 'low' ? 'none' : 'clean' });
    assert.equal(r.status, 0, `${risk} ${r.err}`);
    assert.match(r.out, /사용자 승인: 불필요/);
    assert.equal(r.merges.length, 1);
  }
  // 수동 병합은 Codex GitHub 리뷰가 없어도 기존 게이트의 관리자 확인으로 병합할 수 있다.
  assert.equal((await run({ risk: 'medium', codex: 'none', approval: 'none' })).status, 0);
});

test('High 승인 누락·다른 head·다른 fingerprint·이전 형식·변경 이전 승인은 차단', async () => {
  for (const [options, label] of [[{ approval: 'none' }, 'none'], [{ approval: 'old-head' }, 'old-head'], [{ approval: 'old-fingerprint' }, 'old-fingerprint'], [{ approval: 'short' }, 'short'], [{ lastEditedAt: '2026-10-28T02:00:00Z' }, 'before-edit']]) {
    const r = await run(options);
    blocked(r, /사용자 승인: /, label);
    if (label === 'none') assert.match(r.out, new RegExp(`승인 명령.*/merge-approve ${head} [a-f0-9]{64}`));
  }
});

test('필수 CI 실패·취소·스킵·누락·진행 중과 출처 불일치는 차단', async () => {
  for (const ci of ['failure', 'cancelled', 'skipped', 'missing', 'pending']) blocked(await run({ ci }), /필수 CI verify: /, ci);
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

test('게이트 proof v1은 v2로 신뢰하지 않고 재실행을 안내하며, v2 근거 digest가 다르면 차단', async () => {
  for (const risk of ['high', 'medium']) {
    const options = risk === 'high' ? {} : { risk, approval: 'none' };
    blocked(await run({ ...options, gateCheck: 'v1' }), /proof v1.*게이트를 다시 실행/, `${risk} v1`);
    blocked(await run({ ...options, gateCheck: 'stale-evidence' }), /기존 게이트 판정 이후 리뷰 근거.*바뀜/, `${risk} stale-evidence`);
  }
  // dry-run도 같은 이유를 보여 주고 부작용이 없다.
  blocked(await run({ gateCheck: 'v1' }, ['--dry-run']), /검사 출처: 확인 실패/);
});

test('판정 코드가 기본 브랜치와 다르거나 기본 브랜치에 없으면 실제 병합을 차단하고 dry-run은 참고용으로 표시', async () => {
  blocked(await run({ code: 'changed' }), /판정 코드가 기본 브랜치와 다름\(review-gate-core\.mjs\)/);
  blocked(await run({ code: 'missing' }), /판정 코드가 기본 브랜치와 다름\(merge-pr-core\.mjs\)/);
  blocked(await run({ apiError: '/contents/.github/scripts/' }), /조회 실패: 기본 브랜치의 판정 코드/);
  const dry = await run({ code: 'changed' }, ['--dry-run']);
  blocked(dry, /판정 코드: 기본 브랜치와 다름 — review-gate-core\.mjs \(참고용 결과, 실제 병합 불가\)/);
  // 코드 이외의 판정은 그대로 계산해 보여 준다.
  assert.match(dry.out, /기존 게이트\(independent-review, 현재 필수\): success/);
});

test('판정 코드 목록은 병합 도구 진입점에서 실제로 불러오는 모든 로컬 모듈과 같음', () => {
  const imports = name => [...readFileSync(new URL(`./${name}`, import.meta.url), 'utf8').matchAll(/from '\.\/([^']+)'/g)].map(match => match[1]);
  const seen = new Set();
  const visit = name => { if (seen.has(name)) return; seen.add(name); imports(name).forEach(visit); };
  visit('merge-pr.mjs');
  assert.deepEqual([...seen].sort(), [...trustedModules].sort());
});

test('PR 상태·대상 오류와 지정한 head 불일치는 차단', async () => {
  blocked(await run({ draft: true }), /PR 상태: draft/);
  blocked(await run({ state: 'closed' }), /PR 상태: closed/);
  blocked(await run({}, ['--head', newHead]), /지정한 --head와 현재 PR head 불일치/);
  blocked(await run({ headRepo: 'someone/fork' }), /다른 저장소\(fork\)의 PR/);
});

test('점검 중 head 변경은 병합하지 않고, 마지막 확인 이후 변경은 GitHub가 거부하며 재시도하지 않음', async () => {
  for (const nth of [1, 2]) {
    const between = await run({ headChangeAtChecks: nth });
    assert.equal(between.status, 1, String(nth));
    assert.equal(between.merges.length, 0, String(nth));
    assert.match(between.err, /재확인에서 조건이 바뀌었습니다/);
  }
  // 마지막 확인과 병합 API 호출 사이의 push는 도구가 감지할 수 없고 --match-head-commit이 막는다.
  const beforeMerge = await run({ headChangeAtMerge: true });
  assert.equal(beforeMerge.status, 1);
  assert.equal(beforeMerge.merges.length, 1);
  assert.match(beforeMerge.err, /자동으로 다시 시도하지 않습니다/);
  assert.deepEqual(beforeMerge.effects, beforeMerge.merges);
});

// Codex 리뷰 P1(PR #7 4회차): 두 번째 점검 도중 PR이 바뀌어도 첫 점검 결과로 병합하면 안 된다.
// Shadow 인라인 목록 조회 중(마지막 PR 재조회 전), check suite 조회 중(재조회 뒤), 브랜치 보호 조회 중 세 시점에서 바꾼다.
test('두 번째 점검 도중 base·head·제목·본문·draft·닫힘 변경은 병합하지 않음', async () => {
  const changes = {
    'base SHA': { baseSha: 'a'.repeat(40) }, 'base 브랜치': { baseRef: 'release' }, 'head SHA': { headSha: newHead },
    '제목': { title: 'fix: 바뀐 제목' }, '본문': { body: '<!-- ai-review\nimplemented-by: claude\nrisk: high\nsensitive-change: yes\n-->\n바뀐 본문' },
    'draft 전환': { draft: true }, 'closed 전환': { state: 'closed' },
  };
  for (const at of ['pulls/1/comments', '/check-suites', 'branches/main/protection']) {
    for (const [label, change] of Object.entries(changes)) {
      const r = await run({ prChangeAt: { at, nth: 2, change } });
      const name = `${at} ${label}`;
      assert.equal(r.status, 1, name);
      assert.equal(r.merges.length, 0, name);
      assert.deepEqual(r.effects, [], name);
    }
  }
});

// Codex 리뷰 P1(PR #7 6회차): 실행 직전 재확인이 High 승인만 다시 판정하고, Low·Medium 근거는 댓글 수만 비교했다.
// 두 번째 점검이 판정을 끝낸 뒤(브랜치 보호 조회 시점) 근거가 바뀐다. 수정 전 코드(e49fdd6)는 이 경우들에 병합했다.
const afterSecondApproval = change => ({ commentChangeAt: { at: '/protection', nth: 2, change } });
const evidenceChanges = ['edit-report', 'touch-report', 'delete-report', 'edit-confirmation', 'delete-confirmation', 'repost-confirmation', 'demote-approver', 'add-blocking'];

test('실행 직전 보고서·확인 댓글 수정·삭제, 같은 본문 재작성, 확인자 권한 강등, 변경 요청 추가는 모든 위험도에서 병합 차단', async () => {
  for (const [risk, options] of [['high', {}], ['medium', { risk: 'medium', approval: 'none' }], ['low', { risk: 'low', codex: 'none', approval: 'none' }]]) {
    for (const change of evidenceChanges) {
      // Low 확인 댓글에는 연결된 보고서가 없다.
      if (risk === 'low' && change.endsWith('report')) continue;
      const r = await run({ ...options, ...afterSecondApproval(change) });
      const label = `${risk} ${change}`;
      assert.equal(r.status, 1, label);
      assert.equal(r.merges.length, 0, label);
      assert.deepEqual(r.effects, [], label);
      assert.match(r.err, /재확인에서 조건이 바뀌었습니다/, label);
    }
  }
});

test('첫 점검과 두 번째 점검 사이 근거 변경도 게이트 proof와 달라 병합 차단', async () => {
  for (const change of ['edit-report', 'repost-confirmation', 'demote-approver']) {
    const r = await run({ risk: 'medium', approval: 'none', commentChangeAt: { at: '/protection', nth: 1, change } });
    assert.equal(r.status, 1, change);
    assert.equal(r.merges.length, 0, change);
    assert.deepEqual(r.effects, [], change);
  }
});

test('High 승인 댓글 삭제·본문 수정·수정 이력·작성자 권한 변경은 실행 직전 재확인에서 병합 차단', async () => {
  for (const change of ['delete-approval', 'edit-approval', 'touch-approval', 'demote-approver']) {
    const r = await run(afterSecondApproval(change));
    assert.equal(r.status, 1, change);
    assert.equal(r.merges.length, 0, change);
    assert.deepEqual(r.effects, [], change);
    assert.match(r.err, /재확인에서 조건이 바뀌었습니다/, change);
  }
});

test('실행 중 추가된 무관한 봇 댓글만으로는 근거가 바뀌지 않아 병합을 막지 않음', async () => {
  for (const at of ['/check-suites', '/protection']) {
    const r = await run({ commentChangeAt: { at, nth: 2, change: 'add-bot' } });
    assert.equal(r.status, 0, `${at} ${r.err}`);
    assert.equal(r.merges.length, 1);
  }
});

test('실행 직전 재조회 실패·불완전한 댓글 목록은 병합하지 않음', async () => {
  // 세 번째 조회가 실행 직전 재확인이다.
  for (const [options, label] of [
    [{ failAt: { at: '/issues/1/comments', nth: 3 } }, '댓글 재조회 실패'],
    [{ failAt: { at: '/pulls/1/reviews', nth: 3 } }, '리뷰 재조회 실패'],
    [{ failAt: { at: '/pulls/1/files', nth: 3 } }, '파일 재조회 실패'],
    [{ failAt: { at: '/check-runs', nth: 3 } }, 'check 재조회 실패'],
    // 댓글 목록을 받은 뒤 PR을 다시 받기 전에 새 댓글이 생기면 목록이 불완전하다(무관한 봇 댓글이라도).
    [{ commentChangeAt: { at: '/pulls/1/reviews', nth: 3, change: 'add-bot' } }, '재조회 중 새 댓글'],
  ]) {
    const r = await run(options);
    assert.equal(r.status, 1, label);
    assert.deepEqual(r.effects, [], label);
    assert.match(r.err, /재확인에서 조건이 바뀌었습니다/, label);
    assert.doesNotMatch(r.out + r.err, /server error|HTTP 5/, label);
  }
});

test('병합 후 감사: 병합 중 근거가 바뀌면 심각 경고를 내고 되돌리거나 정리하지 않으며, 무관한 댓글은 통과', async () => {
  for (const change of ['edit-report', 'delete-confirmation', 'demote-approver', 'add-blocking']) {
    const r = await run({ commentChangeAtMerge: change });
    assert.equal(r.status, 1, change);
    assert.equal(r.merges.length, 1, change);
    assert.match(r.err, /\[심각\] 병합 후 감사: 게이트 근거.*병합 직전 재확인과 다릅니다/, change);
    assert.match(r.err, /자동으로 되돌리지 않습니다/, change);
    assert.deepEqual(r.effects, r.merges, `${change}: 병합 외 부작용(브랜치 정리) 없음`);
  }
  // 감사 조회 실패는 같다고 보지 않는다. 병합 전 세 번 + 감사 한 번.
  const unknown = await run({ failAt: { at: '/issues/1/comments', nth: 4 } });
  assert.equal(unknown.status, 1);
  assert.match(unknown.err, /\[심각\] 병합 후 감사: 게이트 근거를 다시 조회하지 못해/);
  assert.deepEqual(unknown.effects, unknown.merges);
  const bot = await run({ commentChangeAtMerge: 'add-bot' });
  assert.equal(bot.status, 0, bot.err);
  assert.match(bot.out, /병합 후 감사: 게이트 근거가 병합 직전 재확인과 같음/);
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
  for (const path of ['/issues/1/comments', '/pulls/1/comments', '/pulls/1/reviews', '/check-runs', '/contents/.ai/review-config.json', '/actions/runs?head_sha', '/collaborators/']) {
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
  for (const [options, status] of [[{}, 0], [{ approval: 'none' }, 1], [{ ci: 'failure' }, 1], [{ gateCheck: 'v1' }, 1], [{ code: 'changed' }, 1]]) {
    const r = await run(options, ['--dry-run'], { locked: true });
    assert.equal(r.status, status, JSON.stringify(options));
    assert.deepEqual(r.effects, []);
    assert.deepEqual(r.store.posted, []);
    assert.equal(r.released, 0);
    assert.match(r.out, /\[dry-run: 병합·댓글·브랜치 삭제 없음\]/);
  }
  const r = await run({}, ['--dry-run']);
  for (const pattern of [/위험도: high/, /필수 CI: verify success/, /독립 리뷰\(Codex GitHub\): clean/, /사용자 승인: 필요 — approved/, /검사 출처: 확인됨\(proof v2, 근거 일치\)/,
    /판정 근거 digest: [a-f0-9]{64}/, /판정 코드: 기본 브랜치와 같음/, /Shadow 자동 판정 후보\(관찰용, 병합 조건 아님\)/, /현재 병합 가능: 예/, /병합 후 브랜치 정리 예정/, /로컬 feature\/safe-merge: 삭제 예정/]) {
    assert.match(r.out, pattern);
  }
  assert.doesNotMatch(r.out, /리뷰 요청|자동 병합 설정/);
});

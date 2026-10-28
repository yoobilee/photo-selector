import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sideEffects, head, title } from './merge-pr-fixture.mjs';

// 실제 CLI 진입점(merge-pr.mjs)을 가짜 gh·git 실행 파일로 실행해 인수 전달과 종료 코드를 확인한다.
// 판정 시나리오는 merge-pr-core.test.mjs가 모든 OS에서 검증한다.
function run(options = {}, flags = []) {
  // 가짜 CLI의 안전한 실행을 보장할 수 없는 플랫폼에서는 실제 gh를 탐색하지 않는다.
  if (process.platform !== 'linux') throw new Error('Linux 전용 가짜 CLI 테스트');
  const dir = mkdtempSync(join(tmpdir(), 'merge-pr-cli-test-'));
  try {
    const fixture = new URL('./merge-pr-fixture.mjs', import.meta.url).href;
    for (const tool of ['gh', 'git']) {
      writeFileSync(join(dir, tool), `#!/usr/bin/env node\nimport(${JSON.stringify(fixture)}).then(m=>{process.exitCode=m.cliMain(${JSON.stringify(tool)},process.argv.slice(2));}).catch(()=>{process.exitCode=9;});\n`, { mode: 0o755 });
    }
    const storeFile = join(dir, 'store.json');
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./merge-pr.mjs', import.meta.url)), 'owner/repo', '1', 'squash', ...flags], {
      encoding: 'utf8', env: { ...process.env, PATH: dir + delimiter + process.env.PATH, MERGE_FAKE_STORE: storeFile, MERGE_FAKE_OPTIONS: JSON.stringify(options) },
    });
    const store = existsSync(storeFile) ? JSON.parse(readFileSync(storeFile, 'utf8')) : { calls: [] };
    return { result, store, merges: store.calls.filter(([tool, ...args]) => tool === 'gh' && args[0] === 'pr' && args[1] === 'merge') };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const linuxTest = process.platform === 'linux' ? test : test.skip;

// 로컬 Windows·macOS에서는 건너뛰지만 CI에서 건너뛰면 병합 도구가 검증되지 않은 채 통과하므로 실패시킨다.
test('CI에서는 병합 도구 CLI 테스트를 Linux에서 실행', () => {
  if (process.env.CI) assert.equal(process.platform, 'linux', 'CI에서 병합 도구 테스트가 건너뛰어졌습니다.');
});

linuxTest('한글·셸 기호·Issue 본문과 예상 head를 squash 병합 인수로 보존', () => {
  const { result, merges } = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(merges.length, 1);
  const merge = merges[0];
  assert.equal(merge[merge.indexOf('--match-head-commit') + 1], head);
  assert.equal(merge[merge.indexOf('--subject') + 1], title);
  assert.ok(merge.includes('--squash'));
  assert.match(result.stdout, /병합과 실제 제목 검증 완료/);
});

linuxTest('차단·dry-run·잘못된 인수는 부작용 없이 실패 코드 또는 점검만 수행', () => {
  for (const [options, flags, status] of [[{ ci: 'failure' }, [], 1], [{ approval: 'none' }, [], 1], [{}, ['--auto'], 1], [{}, ['--dry-run'], 0], [{}, ['merge'], 1]]) {
    const { result, store } = run(options, flags);
    assert.equal(result.status, status, JSON.stringify({ options, flags, stderr: result.stderr }));
    assert.deepEqual(sideEffects(store.calls), [], JSON.stringify({ options, flags }));
    assert.doesNotMatch(result.stdout + result.stderr, /HTTP 5\d\d|server error/);
  }
});

linuxTest('병합 명령 실패 또는 저장 제목 오류 후 자동 재시도하지 않음', () => {
  for (const options of [{ merge: 'fail' }, { badSubject: true }]) {
    const { result, merges } = run(options);
    assert.equal(result.status, 1);
    assert.equal(merges.length, 1);
    if (options.badSubject) assert.match(result.stderr, /사후 검증이 실패/);
  }
});

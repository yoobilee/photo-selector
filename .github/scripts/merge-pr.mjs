import { execFileSync } from 'node:child_process';
import { runMergeTool } from './merge-pr-core.mjs';

// 사용자가 명시적으로 실행하는 병합 도구. workflow에서는 호출하지 않는다.
// 셸 문자열을 만들지 않고 Unicode 인수 배열로 gh·git을 실행한다.
const command = name => args => execFileSync(name, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
try {
  process.exitCode = await runMergeTool({ argv: process.argv.slice(2), gh: command('gh'), git: command('git') });
} catch {
  // 원시 오류에는 API 응답이 들어 있을 수 있어 출력하지 않는다.
  console.error('병합 도구 실행 중 예상하지 못한 오류가 발생했습니다. 병합 여부를 GitHub PR에서 직접 확인하세요. 원시 오류·인증값은 출력하지 않습니다.');
  process.exitCode = 1;
}

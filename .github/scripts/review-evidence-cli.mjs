import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGitHub } from './merge-pr-core.mjs';
import { collectReviewPacket, reportRequest, renderEvidenceReport, maxRequestBytes } from './review-evidence.mjs';

export const usage = '사용법: npm run review:prepare -- owner/repo PR번호 [--result 결과.json] [--output 자료.json] [--dispatch]';
export function parseEvidenceArgs(argv) {
  const [repository, rawNumber, ...rest] = argv;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') || !/^[1-9][0-9]*$/.test(rawNumber ?? '')
      || !Number.isSafeInteger(Number(rawNumber))) return null;
  const options = { repository, number: Number(rawNumber), resultPath: null, outputPath: null, dispatch: false };
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '--result' && !options.resultPath && rest[index + 1] && !rest[index + 1].startsWith('--')) options.resultPath = rest[++index];
    else if (rest[index] === '--output' && !options.outputPath && rest[index + 1] && !rest[index + 1].startsWith('--')) options.outputPath = rest[++index];
    else if (rest[index] === '--dispatch' && !options.dispatch) options.dispatch = true;
    else return null;
  }
  return options;
}

// 읽기 전용 gh adapter를 재사용한다. 사용자 인증으로 댓글·확인·승인을 쓰는 endpoint는 추가하지 않는다.
export function createEvidenceGitHub(gh, repository) {
  const github = createGitHub({ gh, repo: repository });
  github.rest.repos.get = async () => ({ data: github.api(`repos/${repository}`) });
  github.rest.repos.getContent = async ({ path, ref }) => ({ data: github.api(`repos/${repository}/contents/${path}?ref=${encodeURIComponent(ref)}`) });
  return github;
}

export async function runEvidenceCli({ argv, gh, readFile = readFileSync, out = console.log, err = console.error }) {
  const options = parseEvidenceArgs(argv);
  if (!options) { err(usage); return 1; }
  try {
    let result = null;
    if (options.resultPath) {
      const input = readFile(options.resultPath, 'utf8');
      if (Buffer.byteLength(input, 'utf8') > maxRequestBytes) throw new Error('결과 크기 초과');
      result = JSON.parse(input);
      if (result === null) throw new Error('결과 파일이 null임');
    }
    const github = createEvidenceGitHub(gh, options.repository);
    const { packet, state } = await collectReviewPacket({ github, repository: options.repository, number: options.number, result });
    const report = packet.result ? renderEvidenceReport(packet) : null;
    const text = JSON.stringify({ ...packet, report,
      localResultTemplate: { v: 1, target: packet.target, role: 'independent', reviewer: state.evaluation.description.reviewer,
        status: 'running', reviewComplete: false, findings: null, report: null, source: { kind: 'local-session', sessionId: null } },
    }, null, 2);
    if (options.outputPath) {
      writeFileSync(options.outputPath, `${text}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      out('리뷰 자료를 UTF-8 파일로 저장했습니다. 기존 파일은 덮어쓰지 않습니다.');
    } else out(text);
    if (options.dispatch) {
      if (result !== null) throw new Error('미인증 로컬 결과는 로컬 출력만 허용');
      if (!report) throw new Error('유효한 리뷰 결과 없음');
      // 기본 브랜치 도입 전에는 등록을 요청하지 않는다. 임의 ref·workflow·token을 지정하는 옵션이 없다.
      await github.rest.repos.getContent({ path: '.github/workflows/review-evidence.yml', ref: state.defaultBranch });
      const directory = mkdtempSync(join(tmpdir(), 'photo-selector-review-request-'));
      const path = join(directory, 'request.json');
      try {
        writeFileSync(path, JSON.stringify(reportRequest(packet, result)), { encoding: 'utf8', mode: 0o600 });
        gh(['workflow', 'run', 'review-evidence.yml', '--repo', options.repository, '--ref', state.defaultBranch,
          '--field', `pr_number=${options.number}`, '--field', `request=@${path}`]);
      } finally {
        rmSync(path, { force: true });
        rmdirSync(directory);
      }
      out('보고서 등록 workflow를 요청했습니다. 요청은 등록 완료·관리자 확인·게이트 통과가 아닙니다. 중복 요청 전 실제 실행 결과를 확인하세요.');
    }
    return 0;
  } catch {
    // 원시 오류·API 응답·결과 파일·인증값을 에러 로그에 쓰지 않는다.
    err('리뷰 자료 준비/등록 요청 실패: 입력·최신성·정책·전체 조회·출처를 확인하세요. 자동 재시도·승인·병합하지 않습니다.');
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const gh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
  process.exitCode = await runEvidenceCli({ argv: process.argv.slice(2), gh });
}

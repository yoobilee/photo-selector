import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createEvidenceGitHub } from './review-evidence-cli.mjs';
import { collectReviewPacket } from './review-evidence.mjs';
import { attentionPaths, ledgerFileName, readAttentionLedger, loadJobLog, requireBlocked, buildAttentionDraft, writeNewOrSame, adminNextSteps,
  prepareAttentionConfirmation, nodeFiles, jobLogSummary, interpretationSummary } from './review-attention.mjs';
import { sha256 } from './review-gate-core.mjs';

export const attentionUsage = '사용법: npm run review:attention -- owner/repo PR번호 [--confirm <관리자가 게시한 보고서 댓글 URL 또는 ID>]';

// 게시·승인·병합·토큰·ref 옵션은 없다. 이 명령은 GitHub에 쓰지 않는다.
export function parseAttentionArgs(argv) {
  const [repository, rawNumber, ...rest] = argv;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') || !/^[1-9][0-9]*$/.test(rawNumber ?? '') || !Number.isSafeInteger(Number(rawNumber))) return null;
  if (rest.length === 0) return { repository, number: Number(rawNumber), confirm: null };
  if (rest.length === 2 && rest[0] === '--confirm' && rest[1] && !rest[1].startsWith('--')) return { repository, number: Number(rawNumber), confirm: rest[1] };
  return null;
}

// CLI에는 원시 오류·API 응답 대신 고정 안내만 출력한다.
export function attentionFailureMessage(error) {
  const messages = {
    'review-attention-busy': '리뷰 wrapper가 실행 중입니다(lock 존재). 실행이 끝난 뒤 다시 시도하세요. lock을 지우지 마세요.',
    'review-attention-no-ledger': '이 PR의 현재 base/head에 대한 완료 ledger가 없습니다. 이 checkout에서 실행한 리뷰가 아니면 수동 리뷰 보고 절차를 사용하세요. 새 리뷰를 실행하지 않습니다.',
    'review-attention-ledger-invalid': '완료 ledger가 현재 PR 대상(base/head/fingerprint/정책)과 다르거나 형식·복구 연결이 맞지 않습니다. ledger를 수정하지 않았으며 이전 결과를 현재 대상에 연결하지 않습니다.',
    'review-attention-publication-requested': '이 결과는 이미 봇 게시를 요청했습니다. 관리자 초안 대신 실제 Actions·봇 댓글·영수증을 확인하세요.',
    'review-attention-not-blocked': '자동 게시가 차단되지 않은 결과입니다. 기존 npm run review:publish 흐름을 사용하세요.',
    'review-recovery-manual': '복구 기록을 사람이 먼저 확인해야 합니다. v2 복구 파일만 있거나, v3 복구 기록과 원본 ledger의 연결(대상·세션·job·원문·hash·게시 요청 기록·v2 복구 파일)이 맞지 않습니다. 기존 파일은 수정하지 않았습니다.',    'review-attention-comment-invalid': '지정한 댓글이 이 PR의 관리자 검토 초안이 아니거나 marker·대상 SHA·리뷰 원문이 현재 ledger와 맞지 않습니다. 초안을 다시 만들고 원문·marker를 유지해 게시하세요.',
    'review-attention-not-admin': '지정한 댓글은 관리자(admin/maintain) 사용자가 직접 게시한 것이 아닙니다. 봇·다른 사용자의 댓글로 확인 문구를 만들지 않습니다.',
    'review-attention-bot-report': '같은 대상의 봇 보고서가 이미 있습니다. 관리자 초안과 섞지 말고 기존 봇 보고서·영수증을 확인하세요.',
    'review-attention-blocking-findings': '미해결 critical/high/medium 지적 또는 변경 요청 리뷰가 있어 통과 확인 문구를 만들지 않습니다. 수정 후 새 HEAD를 리뷰하세요.',
    'review-attention-ci': '현재 HEAD의 필수 CI가 성공하지 않았거나 workflow 출처를 확인할 수 없어 확인 문구를 만들지 않습니다.',
    'review-attention-gate-mismatch': '준비한 확인 내용이 기존 게이트 조건을 만족하지 않아 출력하지 않습니다. 관리자가 직접 확인하세요.',
    'review-attention-draft-too-large': '명령 목록을 생략해도 초안이 GitHub 댓글 상한에 맞지 않습니다. 원본 ledger는 그대로이며 수동 리뷰 보고 절차를 사용하세요.',
    'review-attention-file-conflict': '같은 이름의 다른 자료 파일이 있어 덮어쓰지 않았습니다. 파일을 확인하세요.',
  };
  return Object.hasOwn(messages, error?.code) ? messages[error.code]
    : '관리자 검토 자료 준비 중단. 대상·ledger·댓글·CI를 확인하세요. 게시·승인·모델 호출·자동 재시도는 하지 않습니다. 원시 오류는 출력하지 않습니다.';
}

export async function runAttentionCli({ argv, gh, git, files = nodeFiles, out = console.log, err = console.error, homeDir = homedir() }) {
  const options = parseAttentionArgs(argv);
  if (!options) { err(attentionUsage); return 1; }
  try {
    const github = createEvidenceGitHub(gh, options.repository);
    const { packet, state } = await collectReviewPacket({ github, repository: options.repository, number: options.number });
    const { target } = packet;
    const { description } = state.evaluation;
    if (description.meta['implemented-by'] !== 'claude') throw Object.assign(new Error('Claude 구현 PR만'), { code: 'review-attention-ledger-invalid' });
    const paths = attentionPaths(resolve(git(['rev-parse', '--git-path', ledgerFileName(target)]).trim()));
    const ledger = readAttentionLedger({ paths, target, implementedBy: description.meta['implemented-by'], files });
    // 원문 해석과 저장한 job 로그 사본 기준으로 자동 게시가 차단된 결과만 다룬다. 확인 문구 준비도 같다.
    const jobLog = loadJobLog({ paths, result: ledger.result, files });
    const blockers = requireBlocked(ledger.result, jobLog, ledger.interpretation);
    if (options.confirm === null) {
      const draft = buildAttentionDraft({ target, risk: description.risk, implementedBy: description.meta['implemented-by'], result: ledger.result,
        blockers, ledger, jobLog, remoteChecks: packet.checks, homeDir });
      const draftPath = paths.draft(draft.sha256);
      writeNewOrSame(files, draftPath, draft.body);
      // codeFindings는 리뷰 당시 저장 결과, interpretation.current는 현재 parser 재해석이다.
      out(JSON.stringify({ state: 'admin-draft-ready', draftPath, draftSha256: draft.sha256, draftKey: draft.key, blockedState: draft.state,
        blockers, codeFindings: ledger.result.findings, interpretation: interpretationSummary(ledger.interpretation), jobLog: jobLogSummary(jobLog, homeDir),
        nextSteps: adminNextSteps({ target, draftPath }), published: false, approved: false }, null, 2));
      return 0;
    }
    const prepared = await prepareAttentionConfirmation({ github, packet, state, ledger, commentRef: options.confirm });
    const content = `${prepared.text}\n`;
    const confirmationPath = paths.confirmation(sha256(content));
    writeNewOrSame(files, confirmationPath, content);
    out(JSON.stringify({ ...prepared, confirmationPath,
      nextSteps: prepared.existingConfirmationId
        ? [`같은 내용의 관리자 확인 댓글(${prepared.existingConfirmationId})이 이미 있습니다. 다시 게시하지 마세요.`]
        : [`관리자가 내용을 확인한 뒤 직접 게시합니다: gh pr comment ${target.number} --repo ${target.repository} --body-file "${confirmationPath}"`,
          'High 위험도는 /merge-approve <head SHA> <fingerprint>도 관리자가 직접 작성합니다.'] }, null, 2));
    return 0;
  } catch (error) {
    err(attentionFailureMessage(error));
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const command = name => args => execFileSync(name, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  process.exitCode = await runAttentionCli({ argv: process.argv.slice(2), gh: command('gh'), git: command('git') });
}

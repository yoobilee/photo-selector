import { readFileSync } from 'node:fs';
import { describe, parseConfirmation, decide, validateConfig, blockingReviews, isReportBody, normalizeNewlines, reportHash, assertPullRequestUnchanged, gateEvidence, isApprovalComment } from './review-gate-core.mjs';
import { formatShadowSummary } from './review-shadow-core.mjs';
import { evaluateShadow } from './review-shadow.mjs';

// 저장소 권한 조회. 협업자가 아님(404)만 권한 없음으로 보고 그 밖의 실패는 그대로 던진다.
export function permissionReader({ github, repo }) {
  const permission = async user => {
    if (!user) return 'none';
    try {
      const {data} = await github.rest.repos.getCollaboratorPermissionLevel({...repo, username:user.login});
      return data.role_name === 'maintain' ? 'maintain' : data.permission;
    } catch (error) {
      if (error.status === 404) return 'none';
      throw error;
    }
  };
  const canConfirm = async user => user?.type === 'User' && ['admin','maintain'].includes(await permission(user));
  return { permission, canConfirm };
}

// 확인 댓글·연결된 보고서·변경 요청 리뷰·High 승인 댓글을 골라 판정 입력과 근거 digest를 만든다.
// 게이트 판정, 병합 도구의 실행 직전 재확인과 병합 후 감사가 같은 함수를 쓴다.
export async function collectReviewBasis({ repo, number, comments, reviews, permission, canConfirm }) {
  const withRole = async comment => ({ comment, role: await permission(comment.user) });
  let confirmation; let confirmationComment = null;
  for (const candidate of comments.filter(comment => /^\/review-gate(?:\s|$)/.test(comment.body ?? '')).sort((a,b)=>Number(b.id)-Number(a.id))) {
    if (await canConfirm(candidate.user)) { confirmationComment=candidate; confirmation=parseConfirmation(candidate.body); break; }
  }
  let evidence; let reportComment = null;
  if (confirmation?.evidence) {
    const prefix=`https://github.com/${repo.owner}/${repo.repo}/pull/${number}#issuecomment-`;
    const url=confirmation.evidence;
    if (typeof url!=='string' || !url.startsWith(prefix) || !/^\d+$/.test(url.slice(prefix.length))) throw new Error('다른 PR 또는 잘못된 근거 링크');
    const report=comments.find(comment=>String(comment.id)===url.slice(prefix.length));
    if (!report || !isReportBody(report.body) || !await canConfirm(report.user)) throw new Error('유효한 관리자 보고서 없음');
    const reportBody=normalizeNewlines(report.body);
    evidence={body:reportBody,hash:reportHash(reportBody)};
    reportComment=report;
  }
  let blocked=false;
  const blocking=[];
  for (const review of blockingReviews(reviews)) {
    const role=await permission(review.user);
    blocking.push({review,role});
    if (['admin','maintain','write'].includes(role)) blocked=true;
  }
  const approvals=[];
  for (const comment of comments) if (isApprovalComment(comment.body) && await canConfirm(comment.user)) approvals.push(await withRole(comment));
  const basis=gateEvidence({
    confirmation:confirmationComment && await withRole(confirmationComment), report:reportComment && await withRole(reportComment), approvals, blocking,
  });
  return {confirmation,evidence,blocked,gateEvidence:basis};
}

export async function evaluatePR({ github, repo, pr, config, summary }) {
  validateConfig(config);
  const { permission, canConfirm } = permissionReader({ github, repo });
  const allPrs = await github.paginate(github.rest.pulls.list, {...repo,state:'open',per_page:100});
  if (allPrs.filter(open => open.head.sha === pr.head.sha).length !== 1) throw new Error('같은 head를 공유하는 PR 또는 조회 불일치');
  const files = await github.paginate(github.rest.pulls.listFiles, {...repo,pull_number:pr.number,per_page:100});
  if (files.length !== pr.changed_files) throw new Error('파일 전체 조회 실패');
  const description = describe(pr,files,config);
  summary?.addHeading(`PR #${pr.number}: ${description.risk}`).addRaw(`\nHEAD: ${description.head}\n\nBASE: ${description.base}\n\n`).addCodeBlock(description.fingerprint,'text');
  const comments = await github.paginate(github.rest.issues.listComments,{...repo,issue_number:pr.number,per_page:100});
  for (const report of comments.filter(comment => isReportBody(comment.body))) {
    const reportBody = normalizeNewlines(report.body);
    if (reportBody.includes(description.head) && reportBody.includes(description.base) && await canConfirm(report.user)) {
      summary?.addRaw(`\n보고서 댓글 ID: ${report.id}\n\n보고서 SHA-256: ${reportHash(reportBody)}\n\n`);
    }
  }
  const reviews=await github.paginate(github.rest.pulls.listReviews,{...repo,pull_number:pr.number,per_page:100});
  const {confirmation,evidence,blocked,gateEvidence:basis}=await collectReviewBasis({repo,number:pr.number,comments,reviews,permission,canConfirm});
  let decision=decide(description,confirmation,evidence);
  if (blocked) decision={state:'failure',reason:'해제되지 않은 변경 요청 리뷰가 남아 있습니다.'};
  const now=(await github.rest.pulls.get({...repo,pull_number:pr.number})).data;
  // state·draft·head·base·제목·본문·파일 수를 공용 기준으로 비교한다. Shadow와 병합 도구도 같은 함수를 쓴다.
  assertPullRequestUnchanged(pr,now);
  // 판정 이외의 값은 Shadow 판정과 병합 도구가 같은 조회 결과를 재사용하기 위한 것이다.
  // current는 모든 목록을 조회한 뒤 다시 받은 PR이다. 병합 도구는 이 값의 댓글 수로 목록 완전성을 확인한다.
  return {description,decision,files,comments,reviews,blocked,canConfirm,current:now,evidence:basis};
}

// Shadow 판정은 Summary에만 기록한다. 오류가 나도 기존 check와 실행 결과에 영향을 주지 않는다.
async function writeShadowSummary({github,repo,pr,config,evaluation,summary}) {
  let text;
  try {
    const shadow=await evaluateShadow({github,repo,pr,config,evaluation,canConfirm:evaluation.canConfirm});
    if (!shadow) return;
    text=formatShadowSummary({number:pr.number,shadow});
  } catch {
    // 원시 오류에는 API 응답이 들어 있을 수 있어 출력하지 않는다.
    text=formatShadowSummary({number:pr.number,shadow:{error:'조회·형식·설정 오류'}});
  }
  try {summary.addRaw(text);} catch {/* Summary 기록 실패도 기존 판정에 영향을 주지 않는다. */}
}

export async function runGate({github,context,core}) {
  const repo=context.repo;
  // 남은 실행 하나도 모든 PR을 조회하므로 대기 이벤트 교체로 다른 PR을 놓치지 않는다.
  if (context.payload.issue && !context.payload.issue.pull_request) return;
  const prs=await github.paginate(github.rest.pulls.list,{...repo,state:'open',per_page:100});
  let config;
  try {config=JSON.parse(readFileSync(new URL('../../.ai/review-config.json',import.meta.url),'utf8'));} catch {config=null;}
  let failed=false;
  for (const item of prs) {
    let check;
    try {
      const pr=(await github.rest.pulls.get({...repo,pull_number:item.number})).data;
      if (pr.state!=='open') continue;
      const created=await github.rest.checks.create({...repo,name:'independent-review',head_sha:pr.head.sha,status:'in_progress',
        details_url:`https://github.com/${repo.owner}/${repo.repo}/actions/runs/${context.runId}`,
        output:{title:'독립 리뷰 확인 중',summary:`PR #${pr.number}의 현재 상태를 확인합니다.`}});
      check=created.data.id;
      const evaluation=await evaluatePR({github,repo,pr,config,summary:core.summary});
      const {description,decision}=evaluation;
      // proof v2: 판정한 PR 상태(fingerprint)와 판정 근거(evidenceDigest)를 함께 기록한다. 병합 도구는 v1 proof를 신뢰하지 않는다.
      const proof={v:2,pr:pr.number,fingerprint:description.fingerprint,evidenceDigest:evaluation.evidence.digest,runId:String(context.runId),attempt:String(context.runAttempt ?? process.env.GITHUB_RUN_ATTEMPT ?? '1')};
      await github.rest.checks.update({...repo,check_run_id:check,status:'completed',conclusion:decision.state,
        external_id:JSON.stringify(proof),output:{title:decision.reason,summary:`PR #${pr.number}: ${decision.state}`,text:JSON.stringify(proof)}});
      core.summary.addRaw(`\nPR #${pr.number}: ${decision.state} — ${decision.reason}\n`);
      await writeShadowSummary({github,repo,pr,config,evaluation,summary:core.summary});
      // 병합 여부는 PR head의 check가 결정한다. 다른 PR의 실패 때문에
      // 정상적으로 평가된 PR의 workflow 출처까지 실패로 만들지 않는다.
    } catch {
      // 실패 check를 정상 게시했으면 해당 PR만 차단한다. draft·제목·
      // metadata 오류가 다른 정상 PR의 workflow 출처까지 무효화하면 안 된다.
      // check 생성·실패 게시 자체가 불가능한 경우에만 실행 전체를 실패시킨다.
      if (!check) {
        failed=true;
      } else {
        try {
          await github.rest.checks.update({...repo,check_run_id:check,status:'completed',conclusion:'failure',output:{title:'사람 확인 필요',summary:'조회·형식·권한·최신성 오류가 발생했습니다.'}});
        } catch {
          failed=true;
          core.summary.addRaw(`\nPR #${item.number}: 실패 check 게시도 실패했습니다. 해당 검사는 통과가 아닙니다.\n`);
        }
      }
      core.summary.addRaw(`\nPR #${item.number}: 확인 실패.\n`);
    }
  }
  await core.summary.write();
  if (failed) core.setFailed('일부 PR의 check 생성 또는 실패 결과 게시에 실패했습니다.');
}

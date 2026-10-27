import {
  classifyRisk, compareWithGate, decideShadow, evaluateCodexReview, evaluateRequiredChecks, findApproval,
  isApprovalComment, planReviewRequest, validateShadowConfig,
} from './review-shadow-core.mjs';

const dependencyPattern = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/;
const changeQuery = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){
  lastEditedAt timelineItems(last:1,itemTypes:[RENAMED_TITLE_EVENT,BASE_REF_CHANGED_EVENT]){nodes{__typename ...on RenamedTitleEvent{createdAt} ...on BaseRefChangedEvent{createdAt}}}}}}`;

// 본문 수정·제목 변경·base 변경 중 가장 최근 시각. 없으면 null.
async function lastChangedAt({ github, repo, number }) {
  const data = await github.graphql(changeQuery, { owner: repo.owner, repo: repo.repo, number });
  const pr = data?.repository?.pullRequest;
  if (!pr) throw new Error('PR 변경 이력 조회 실패');
  const times = [pr.lastEditedAt, ...(pr.timelineItems?.nodes ?? []).map(node => node?.createdAt)].filter(Boolean);
  return times.length ? times.sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) : null;
}

// 기존 게이트 평가가 끝난 뒤 같은 PR 상태로 관찰용 판정을 계산한다. GitHub에 아무것도 쓰지 않는다.
export async function evaluateShadow({ github, repo, pr, config, evaluation, canConfirm }) {
  const shadow = config?.shadow;
  validateShadowConfig(shadow);
  if (!shadow.enabled) return null;
  const { description, decision, files, comments, reviews, blocked } = evaluation;
  const head = description.head;
  if (comments.length !== pr.comments) throw new Error('PR 댓글 전체 조회 실패');
  const reviewComments = await github.paginate(github.rest.pulls.listReviewComments, { ...repo, pull_number: pr.number, per_page: 100 });
  if (reviewComments.length !== pr.review_comments) throw new Error('인라인 리뷰 댓글 전체 조회 실패');
  const checkRuns = await github.paginate(github.rest.checks.listForRef, { ...repo, ref: head, filter: 'all', per_page: 100 });

  const paths = files.flatMap(file => [file.filename, file.previous_filename].filter(Boolean));
  const risk = classifyRisk({ meta: description.meta, files, gateConfig: config, shadow, dependency: paths.some(path => dependencyPattern.test(path)) });
  const bot = shadow.codexReviewer;
  const codex = evaluateCodexReview({ head, comments, reviews, reviewComments, bot });
  const checks = evaluateRequiredChecks({ head, checkRuns, requiredChecks: shadow.requiredChecks });
  const request = planReviewRequest({ comments, codex, bot, maxReviewRequests: shadow.maxReviewRequests });

  let approval = { state: 'none' };
  if (decision.state === 'success' && risk.risk === 'high') approval = { state: 'approved', reason: '기존 관리자 확인 통과' };
  else if (comments.some(comment => isApprovalComment(comment.body))) {
    const confirmers = new Set();
    for (const comment of comments) if (isApprovalComment(comment.body) && await canConfirm(comment.user)) confirmers.add(comment.id);
    let changedAt;
    try { changedAt = await lastChangedAt({ github, repo, number: pr.number }); } catch { changedAt = 'unknown'; }
    approval = findApproval({ head, comments, confirmers, lastChangedAt: changedAt });
  }

  const shadowDecision = decideShadow({ risk: risk.risk, meta: description.meta, checks, codex, approval, blocked, request, maxReviewRequests: shadow.maxReviewRequests });
  return { risk, checks, codex, approval, request, decision: shadowDecision, comparison: compareWithGate(shadowDecision, decision), fingerprint: description.fingerprint };
}

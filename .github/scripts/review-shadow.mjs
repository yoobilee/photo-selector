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

// PR head가 최신 base를 포함하는지 확인한다. 조회 실패는 알 수 없음으로 남긴다.
async function baseSyncState({ github, repo, base, head }) {
  try {
    const { data } = await github.rest.repos.compareCommitsWithBasehead({ ...repo, basehead: `${base}...${head}` });
    if (!Number.isSafeInteger(data?.behind_by)) return 'unknown';
    return data.behind_by === 0 ? 'current' : 'behind';
  } catch {
    return 'unknown';
  }
}

// 기존 게이트 평가가 끝난 뒤 같은 PR 상태로 관찰용 판정을 계산한다. GitHub에 아무것도 쓰지 않는다.
export async function evaluateShadow({ github, repo, pr, config, evaluation, canConfirm }) {
  const shadow = config?.shadow;
  validateShadowConfig(shadow);
  if (!shadow.enabled) return null;
  const { description, decision, files, comments, reviews, blocked } = evaluation;
  const head = description.head;
  // 목록 수는 목록 조회 **뒤에** 다시 받은 PR 정보의 수와 같아야 한다. 조회 전 PR 정보와 비교하면 실행 중 추가된 댓글
  // (예: PR 생성 직후 봇 안내)로 실패하고, 조회 후 수보다 적으면 목록이 새 댓글을 놓친 것이므로 둘 다 이 기준으로 판단한다.
  const complete = (count, after) => Number.isSafeInteger(after) && count === after;
  // evaluatePR의 current는 댓글 목록 조회 뒤에 다시 받은 PR 정보다.
  if (!complete(comments.length, evaluation.current?.comments)) throw new Error('PR 댓글 전체 조회 실패');
  const reviewComments = await github.paginate(github.rest.pulls.listReviewComments, { ...repo, pull_number: pr.number, per_page: 100 });
  const after = (await github.rest.pulls.get({ ...repo, pull_number: pr.number })).data;
  if (after.head?.sha !== head || !complete(reviewComments.length, after.review_comments)) throw new Error('인라인 리뷰 댓글 전체 조회 실패');
  const checkRuns = await github.paginate(github.rest.checks.listForRef, { ...repo, ref: head, filter: 'all', per_page: 100 });
  // head push로 생긴 check suite 중 가장 이른 생성 시각을 그 head가 처음 보인 시각으로 쓴다. 조회 실패는 알 수 없음이다.
  let headSeenAt = null;
  try {
    const suites = await github.paginate(github.rest.checks.listSuitesForRef, { ...repo, ref: head, per_page: 100 });
    headSeenAt = suites.filter(suite => suite.head_sha === head).map(suite => suite.created_at)
      .filter(time => !Number.isNaN(Date.parse(time))).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
  } catch { headSeenAt = null; }

  const paths = files.flatMap(file => [file.filename, file.previous_filename].filter(Boolean));
  const risk = classifyRisk({ meta: description.meta, files, gateConfig: config, shadow, dependency: paths.some(path => dependencyPattern.test(path)) });
  const bot = shadow.codexReviewer;
  const codex = evaluateCodexReview({ head, comments, reviews, reviewComments, bot });
  const checks = evaluateRequiredChecks({ head, checkRuns, requiredChecks: shadow.requiredChecks });
  const request = planReviewRequest({ comments, codex, maxReviewRequests: shadow.maxReviewRequests, headSeenAt });

  // High 병합 승인은 기존 `/review-gate` 리뷰 확인과 별개의 명시적 명령으로만 인정한다.
  let approval = { state: 'none' };
  if (comments.some(comment => isApprovalComment(comment.body))) {
    const confirmers = new Set();
    for (const comment of comments) if (isApprovalComment(comment.body) && await canConfirm(comment.user)) confirmers.add(comment.id);
    let changedAt;
    try { changedAt = await lastChangedAt({ github, repo, number: pr.number }); } catch { changedAt = 'unknown'; }
    approval = findApproval({ head, fingerprint: description.fingerprint, comments, confirmers, lastChangedAt: changedAt });
  }

  const baseSync = await baseSyncState({ github, repo, base: description.base, head });
  const shadowDecision = decideShadow({ risk: risk.risk, meta: description.meta, checks, codex, approval, blocked, request, maxReviewRequests: shadow.maxReviewRequests, baseSync });
  return { head, meta: description.meta, risk, checks, codex, approval, request, baseSync, decision: shadowDecision, comparison: compareWithGate(shadowDecision, decision), fingerprint: description.fingerprint };
}

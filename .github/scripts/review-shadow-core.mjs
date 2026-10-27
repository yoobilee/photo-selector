import { normalizeNewlines } from './review-gate-core.mjs';

// Shadow 판정은 관찰용이다. 기존 independent-review 판정과 check 게시를 바꾸지 않는다.
const shaPattern = /^[a-f0-9]{40}$/;
const severityLevels = { P0: 'critical', P1: 'high', P2: 'medium', P3: 'low' };
const summaryMarker = '<!-- codex-pull-request-review-summary -->';
const statePattern = /<!-- codex-review-state:v1 (\{.*\}) -->/;
const usageLimitPrefix = 'You have reached your Codex usage limits';
const reviewRequest = '@codex review';
const approvalPattern = /^\/review-gate approve ([a-f0-9]{7,40})$/;

const matchesPrefix = (path, prefixes) => prefixes.some(prefix => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`));
const byId = (a, b) => Number(a.id) - Number(b.id);
const isIsoTime = value => typeof value === 'string' && !Number.isNaN(Date.parse(value));

export function validateShadowConfig(shadow) {
  const strings = list => Array.isArray(list) && list.every(item => typeof item === 'string' && item.trim());
  const bot = shadow?.codexReviewer;
  if (!shadow || typeof shadow.enabled !== 'boolean' || !strings(shadow.lowRiskPaths) || !strings(shadow.highRiskPaths)
      || !Array.isArray(shadow.requiredChecks) || !shadow.requiredChecks.length
      || shadow.requiredChecks.some(check => typeof check?.name !== 'string' || !check.name || !Number.isSafeInteger(check.appId))
      || typeof bot?.login !== 'string' || !Number.isSafeInteger(bot.userId) || !Number.isSafeInteger(bot.appId)
      || !Number.isSafeInteger(shadow.maxReviewRequests) || shadow.maxReviewRequests < 1) throw new Error('shadow 설정 오류');
}

// metadata보다 낮게 내리지 않고, 경로·민감 변경·의존성 변경으로만 올린다.
export function classifyRisk({ meta, files, gateConfig, shadow, dependency }) {
  const paths = files.flatMap(file => [file.filename, file.previous_filename].filter(Boolean));
  const reasons = [];
  if (meta.risk === 'high') reasons.push('metadata high');
  if (meta['sensitive-change'] === 'yes') reasons.push('민감 변경 표시');
  const highRules = [...gateConfig.highRiskPaths, ...shadow.highRiskPaths].filter(prefix => paths.some(path => matchesPrefix(path, [prefix])));
  if (highRules.length) reasons.push(`고위험 경로 규칙: ${[...new Set(highRules)].join(', ')}`);
  if (dependency) reasons.push('의존성·잠금 파일 변경');
  if (reasons.length) return { risk: 'high', reasons };
  if (meta.risk === 'medium') return { risk: 'medium', reasons: ['metadata medium'] };
  const outside = paths.filter(path => !matchesPrefix(path, shadow.lowRiskPaths)).length;
  if (outside) return { risk: 'medium', reasons: [`저위험 허용 목록 밖 파일 ${outside}개`] };
  return { risk: 'low', reasons: ['모든 파일이 저위험 허용 목록에 있음'] };
}

export const isTrustedBotComment = (comment, bot) => comment?.user?.id === bot.userId && comment.user.type === 'Bot'
  && comment.user.login === bot.login && comment.performed_via_github_app?.id === bot.appId;
// REST 리뷰·인라인 댓글에는 앱 정보가 없으므로 봇 계정 ID와 유형으로 확인한다.
export const isTrustedBotUser = (user, bot) => user?.id === bot.userId && user.type === 'Bot' && user.login === bot.login;

export function parseReviewState(body) {
  const match = statePattern.exec(normalizeNewlines(body));
  if (!match) return null;
  let state;
  try { state = JSON.parse(match[1]); } catch { return { valid: false }; }
  const review = state?.code_review;
  const optionalBoolean = value => value === null || typeof value === 'boolean';
  if (!review || typeof review !== 'object' || !shaPattern.test(review.commit_sha ?? '') || typeof review.status !== 'string'
      || !optionalBoolean(review.has_any_findings) || !optionalBoolean(review.has_unresolved_findings)) return { valid: false };
  return { valid: true, commitSha: review.commit_sha, status: review.status, hasAnyFindings: review.has_any_findings, hasUnresolvedFindings: review.has_unresolved_findings };
}

// 실제 인라인 지적의 첫 줄 형식만 인정한다. 형식이 바뀌면 심각도 불명으로 남겨 자동 통과시키지 않는다.
export function parseSeverity(body) {
  const match = /^\*\*<sub><sub>!\[(P[0-3]) Badge\]\(https:\/\/img\.shields\.io\/badge\/(P[0-3])-[a-z]+\?style=flat\)<\/sub><\/sub>/.exec(normalizeNewlines(body));
  return match && match[1] === match[2] ? severityLevels[match[1]] : null;
}

export const isReviewRequest = body => normalizeNewlines(body).trim() === reviewRequest;

const result = (status, reason, extra = {}) => ({ status, reason, findings: null, ...extra });

// 리뷰 상태 댓글·리뷰·인라인 댓글을 모두 보고 판단한다. 확인할 수 없으면 통과 후보가 아니다.
export function evaluateCodexReview({ head, comments, reviews, reviewComments, bot }) {
  const trustedComments = comments.filter(comment => isTrustedBotComment(comment, bot)).sort(byId);
  const ignoredUntrusted = comments.filter(comment => !isTrustedBotComment(comment, bot)
    && (normalizeNewlines(comment.body).includes(summaryMarker) || statePattern.test(normalizeNewlines(comment.body)))).length;
  const base = { ignoredUntrusted };
  const states = trustedComments.filter(comment => normalizeNewlines(comment.body).includes(summaryMarker)).map(comment => ({ comment, state: parseReviewState(comment.body) }));
  if (states.some(item => !item.state?.valid)) return result('indeterminate', '알 수 없는 리뷰 상태 형식', base);
  const headStates = states.filter(item => item.state.commitSha === head);
  if (!headStates.length) {
    if (trustedComments.some(comment => normalizeNewlines(comment.body).startsWith(usageLimitPrefix))) return result('limit', 'Codex 리뷰 사용량 한도 초과', base);
    return result('missing', '최신 head에 대한 Codex 리뷰 결과 없음', base);
  }
  if (headStates.some(item => item.state.status === 'running')) return result('pending', 'Codex 리뷰 진행 중', base);
  if (headStates.some(item => item.state.status !== 'completed')) return result('indeterminate', '알 수 없는 리뷰 진행 상태', base);
  const flags = new Set(headStates.map(item => `${item.state.hasAnyFindings}/${item.state.hasUnresolvedFindings}`));
  if (flags.size !== 1) return result('indeterminate', '같은 head의 리뷰 상태가 서로 다름', base);
  const { hasAnyFindings, hasUnresolvedFindings } = headStates[0].state;
  if (typeof hasAnyFindings !== 'boolean') return result('indeterminate', '지적 여부 값 누락', base);

  const headReviews = reviews.filter(review => isTrustedBotUser(review.user, bot) && review.commit_id === head);
  const reviewIds = new Set(headReviews.map(review => review.id));
  const findingComments = reviewComments.filter(comment => isTrustedBotUser(comment.user, bot) && reviewIds.has(comment.pull_request_review_id));
  const evidence = { stateCommentId: headStates[0].comment.id, reviewIds: [...reviewIds].sort() };
  if (!hasAnyFindings) {
    if (findingComments.length) return result('indeterminate', '지적 없음 상태와 인라인 지적이 함께 있음', { ...base, evidence });
    return result('clean', '지적 없음', { ...base, evidence, hasUnresolvedFindings, findings: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 } });
  }
  if (!findingComments.length) return result('indeterminate', '지적 있음이지만 세부 지적을 찾지 못함', { ...base, evidence });
  const findings = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  for (const comment of findingComments) findings[parseSeverity(comment.body) ?? 'unknown'] += 1;
  // 해결 처리(resolve)는 같은 계정으로 누구나 할 수 있으므로 집계를 줄이는 근거로 쓰지 않는다.
  return result('findings', '지적 있음', { ...base, evidence, hasUnresolvedFindings, findings });
}

export function evaluateRequiredChecks({ head, checkRuns, requiredChecks }) {
  return requiredChecks.map(({ name, appId }) => {
    const latest = checkRuns.filter(run => run.name === name && run.app?.id === appId && run.head_sha === head).sort(byId).at(-1);
    if (!latest) return { name, state: 'missing' };
    if (latest.status !== 'completed') return { name, state: 'pending' };
    return { name, state: latest.conclusion === 'success' ? 'success' : (latest.conclusion ?? 'unknown') };
  });
}

// 승인 댓글은 head SHA를 명시해야 하고, 본문·제목·base 변경 뒤에 작성된 것만 유효하다.
export function findApproval({ head, comments, confirmers, lastChangedAt }) {
  const candidates = comments.filter(comment => approvalPattern.test(normalizeNewlines(comment.body).trim()));
  if (!candidates.length) return { state: 'none' };
  if (lastChangedAt !== null && !isIsoTime(lastChangedAt)) return { state: 'indeterminate', reason: 'PR 변경 시각 조회 실패' };
  const valid = candidates.filter(comment => {
    const sha = approvalPattern.exec(normalizeNewlines(comment.body).trim())[1];
    return head.startsWith(sha) && confirmers.has(comment.id) && isIsoTime(comment.created_at)
      && (lastChangedAt === null || Date.parse(comment.created_at) > Date.parse(lastChangedAt));
  });
  return valid.length ? { state: 'approved', commentId: valid.sort(byId).at(-1).id } : { state: 'invalid', reason: '최신 head·변경 이후의 관리자 승인 없음' };
}

export function planReviewRequest({ comments, codex, bot, maxReviewRequests }) {
  const requests = comments.filter(comment => isReviewRequest(comment.body)).sort(byId);
  const latestState = comments.filter(comment => isTrustedBotComment(comment, bot) && normalizeNewlines(comment.body).includes(summaryMarker))
    .map(comment => Date.parse(comment.updated_at)).filter(Number.isFinite).sort((a, b) => a - b).at(-1) ?? 0;
  const unanswered = requests.some(request => Date.parse(request.created_at) > latestState);
  let allowed = true, reason = '요청 가능';
  if (requests.length >= maxReviewRequests) [allowed, reason] = [false, `PR당 요청 상한 ${maxReviewRequests}회 도달`];
  else if (['clean', 'findings', 'pending', 'indeterminate'].includes(codex.status)) [allowed, reason] = [false, '같은 head에 이미 리뷰 결과·진행 기록 있음'];
  else if (unanswered) [allowed, reason] = [false, '응답 대기 중인 요청 있음'];
  else if (codex.status === 'limit') [allowed, reason] = [false, '사용량 한도 초과'];
  return { requestCount: requests.length, allowed, reason };
}

// 기존 게이트와 별개로 자동 판정 후보인지 계산한다. 후보가 아니면 사유를 모두 남긴다.
export function decideShadow({ risk, meta, checks, codex, approval, blocked, request, maxReviewRequests }) {
  const blockers = [];
  for (const check of checks) if (check.state !== 'success') blockers.push(`필수 CI ${check.name}: ${check.state}`);
  if (blocked) blockers.push('해제되지 않은 변경 요청 리뷰');
  if (risk !== 'low') {
    if (meta['implemented-by'] === 'unknown') blockers.push('구현 Agent 불명확');
    if (request.requestCount > maxReviewRequests) blockers.push('리뷰 요청 상한 초과');
    if (codex.status === 'findings') {
      const { critical, high, medium, unknown } = codex.findings;
      if (critical || high || medium) blockers.push(`차단 지적 critical ${critical}·high ${high}·medium ${medium}`);
      if (unknown) blockers.push(`심각도를 알 수 없는 지적 ${unknown}개`);
    } else if (codex.status !== 'clean') blockers.push(`Codex 리뷰: ${codex.reason}`);
  }
  if (risk === 'high' && approval.state !== 'approved') blockers.push(`사용자 승인: ${approval.reason ?? '없음'}`);
  return { candidate: blockers.length === 0, blockers };
}

export function compareWithGate(shadowDecision, gateDecision) {
  const gatePassed = gateDecision.state === 'success';
  if (gatePassed === shadowDecision.candidate) return '일치';
  return gatePassed ? '차이: 기존 게이트 통과, Shadow 후보 아님' : '차이: 기존 게이트 실패, Shadow 후보';
}

export function formatShadowSummary({ number, shadow }) {
  if (shadow.error) return `\n#### Shadow 판정 PR #${number} (관찰용, 병합에 영향 없음)\n\n- 판단 불가: ${shadow.error}\n`;
  const { risk, checks, codex, approval, request, decision, comparison, fingerprint } = shadow;
  const findings = codex.findings ? ` (critical ${codex.findings.critical}·high ${codex.findings.high}·medium ${codex.findings.medium}·low ${codex.findings.low}·unknown ${codex.findings.unknown})` : '';
  return [
    `\n#### Shadow 판정 PR #${number} (관찰용, 병합에 영향 없음)\n`,
    `- 위험도: ${risk.risk} — ${risk.reasons.join('; ')}`,
    `- 필수 CI: ${checks.map(check => `${check.name} ${check.state}`).join(', ')}`,
    `- Codex GitHub 리뷰: ${codex.status} — ${codex.reason}${findings}${codex.ignoredUntrusted ? ` / 신뢰하지 않는 리뷰 형식 댓글 ${codex.ignoredUntrusted}개 무시` : ''}`,
    `- 리뷰 요청: ${request.requestCount}회, 새 요청 ${request.allowed ? '가능' : `불가(${request.reason})`}`,
    `- 사용자 승인: ${approval.state}${approval.reason ? ` — ${approval.reason}` : ''}`,
    `- 자동 판정 후보(${risk.risk}): ${decision.candidate ? '예' : '아니오'}${decision.blockers.length ? ` — ${decision.blockers.join('; ')}` : ''}`,
    `- 기존 게이트 비교: ${comparison}`,
    `- 기준 fingerprint: ${fingerprint}\n`,
  ].join('\n');
}

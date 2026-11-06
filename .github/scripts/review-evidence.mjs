import { describe, normalizeNewlines, parseConfirmation, reportHash, sha256, validateConfig, assertPullRequestUnchanged } from './review-gate-core.mjs';
import { evaluatePR } from './review-gate.mjs';
import { evaluateCodexReview, evaluateRequiredChecks } from './review-shadow-core.mjs';

export const evidenceWorkflow = '.github/workflows/review-evidence.yml';
export const maxRequestBytes = 60_000;
const publisher = { login: 'github-actions[bot]', userId: 41898282, appId: 15368 };
const levels = ['critical', 'high', 'medium', 'low', 'unknown'];
const shaPattern = /^[a-f0-9]{40}$/;
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const markerPattern = /^# (?:(?:독립|자체) 리뷰 보고서|미인증 로컬 (?:독립|자체) 리뷰 자료)\n\n<!-- photo-selector-review-evidence:v1 ([a-f0-9]{64}) -->\n/;
const fail = message => { throw new Error(message); };
const exactKeys = (object, keys) => object && !Array.isArray(object) && typeof object === 'object'
  && Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));
const canonical = value => JSON.stringify(value, (_, item) => item && !Array.isArray(item) && typeof item === 'object'
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const same = (left, right) => canonical(left) === canonical(right);
const validAuthor = user => positiveId(user?.id) && ['User', 'Bot'].includes(user.type) && typeof user.login === 'string' && user.login.length > 0;
export const isEvidencePublisher = comment => comment?.user?.type === 'Bot' && comment.user.id === publisher.userId
  && comment.user.login === publisher.login && comment.performed_via_github_app?.id === publisher.appId;

function records(items) {
  if (!Array.isArray(items) || items.length > 10_000 || items.some(item => !positiveId(item?.id))
      || new Set(items.map(item => item.id)).size !== items.length) fail('불완전한 목록 또는 중복 ID');
  return [...items].sort((left, right) => left.id - right.id);
}

function commentRecords(items) {
  const sorted = records(items);
  if (sorted.some(item => typeof item.body !== 'string' || !validAuthor(item.user))) fail('댓글 응답 형식 오류');
  return sorted;
}

async function readState({ github, repository, number }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') || !positiveId(number)) fail('저장소 또는 PR 번호 오류');
  const [owner, name] = repository.split('/');
  const repo = { owner, repo: name };
  const info = (await github.rest.repos.get(repo)).data;
  if (info.full_name !== repository || typeof info.default_branch !== 'string') fail('저장소 조회 불일치');
  const pr = (await github.rest.pulls.get({ ...repo, pull_number: number })).data;
  if (pr.base?.ref !== info.default_branch || pr.base?.repo?.full_name !== repository
      || pr.head?.repo?.full_name !== repository) fail('기본 브랜치 대상의 동일 저장소 PR만 지원');
  const file = (await github.rest.repos.getContent({ ...repo, path: '.ai/review-config.json', ref: info.default_branch })).data;
  if (file.encoding !== 'base64' || typeof file.content !== 'string' || !shaPattern.test(file.sha ?? '')) fail('기본 브랜치 정책 조회 오류');
  const config = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  validateConfig(config);
  const evaluation = await evaluatePR({ github, repo, pr, config });
  const reviewComments = commentRecords(await github.paginate(github.rest.pulls.listReviewComments, { ...repo, pull_number: number, per_page: 100 }));
  const checkRuns = records(await github.paginate(github.rest.checks.listForRef, { ...repo, ref: pr.head.sha, filter: 'all', per_page: 100 }));
  if (reviewComments.some(comment => !shaPattern.test(comment.commit_id ?? ''))
      || checkRuns.some(check => !shaPattern.test(check.head_sha ?? '') || typeof check.name !== 'string'
        || !positiveId(check.app?.id) || !['queued', 'in_progress', 'completed', 'requested', 'waiting', 'pending'].includes(check.status))) fail('인라인 또는 검사 응답 형식 오류');
  const current = (await github.rest.pulls.get({ ...repo, pull_number: number })).data;
  assertPullRequestUnchanged(pr, current);
  if (evaluation.comments.length !== current.comments || reviewComments.length !== current.review_comments) fail('댓글 전체 조회 실패');
  const comments = commentRecords(evaluation.comments);
  const reviews = records(evaluation.reviews);
  if (reviews.some(review => !validAuthor(review.user) || !shaPattern.test(review.commit_id ?? '')
      || (review.body !== null && typeof review.body !== 'string')
      || !['PENDING', 'COMMENTED', 'APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state))) fail('리뷰 응답 형식 오류');
  if (new Set(evaluation.files.map(file => file.filename)).size !== evaluation.files.length
      || evaluation.files.some(file => typeof file.filename !== 'string' || !file.filename || typeof file.status !== 'string')) fail('변경 파일 응답 형식 오류');
  const description = describe(pr, evaluation.files, config);
  const target = { repository, number, head: description.head, base: description.base, fingerprint: description.fingerprint, policySha: file.sha };
  const state = { repo, defaultBranch: info.default_branch, current, target, config, evaluation, comments, reviews, reviewComments, checkRuns };
  const result = legacyReview(state) ?? githubReview(state);
  // 현재 대상·검증된 원본 근거로 전체 본문과 key를 재구성할 수 있는 댓글만 제외한다.
  // 같은 Actions 앱의 다른 workflow는 작성자 정보만으로 구별할 수 없다. 승인에는 쓰지 않는다.
  const basisComments = comments.filter(comment => {
    if (!result || !isEvidencePublisher(comment)) return true;
    const body = normalizeNewlines(comment.body);
    const key = markerPattern.exec(body)?.[1];
    const recordedHash = /\n수집 digest: ([a-f0-9]{64})\n/.exec(body)?.[1];
    if (!key || !recordedHash) return true;
    const expected = renderEvidenceReport({ target, collectionHash: recordedHash, result });
    return key !== expected.key || body !== expected.body;
  });
  const collectionHash = sha256(canonical({ comments: basisComments, reviews, reviewComments, checkRuns, gateEvidence: evaluation.evidence }));
  return { ...state, collectionHash };
}

// 로컬 세션 파일은 실행 증명이 아니라 제출자의 주장이다. 기존 관리자 확인을 대체하지 않는다.
export function validateLocalResult(input, target, description) {
  if (!exactKeys(input, ['v', 'target', 'role', 'reviewer', 'status', 'reviewComplete', 'findings', 'report', 'source'])
      || input.v !== 1 || !same(input.target, target)) fail('리뷰 결과 형식 오류 또는 오래된 대상');
  if (!['self', 'independent'].includes(input.role) || !['claude', 'codex'].includes(input.reviewer)
      || !['completed', 'running', 'skipped', 'limit', 'failed'].includes(input.status)
      || typeof input.reviewComplete !== 'boolean' || input.reviewComplete !== (input.status === 'completed')) fail('리뷰 완료 상태 오류');
  if (input.role === 'self' ? input.reviewer !== description.meta['implemented-by']
    : description.meta['implemented-by'] === 'unknown' || input.reviewer !== description.reviewer) fail('자체 리뷰와 독립 검증의 역할 불일치');
  if (!exactKeys(input.findings, levels) || levels.some(level => !Number.isSafeInteger(input.findings[level]) || input.findings[level] < 0)) fail('지적 집계 누락 또는 형식 오류');
  if (typeof input.report !== 'string' || !input.report.trim() || Buffer.byteLength(input.report, 'utf8') > 20_000) fail('리뷰 본문 누락 또는 크기 초과');
  if (!exactKeys(input.source, ['kind', 'sessionId']) || input.source.kind !== 'local-session'
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.source.sessionId ?? '')) fail('로컬 리뷰 출처 형식 오류');
  return { role: input.role, reviewer: input.reviewer, status: input.status, reviewComplete: input.reviewComplete,
    findings: input.findings, report: normalizeNewlines(input.report), source: input.source, authentication: 'unverified-local-session' };
}

function githubReview(state) {
  const { description } = state.evaluation;
  const result = evaluateCodexReview({ head: state.target.head, comments: state.comments, reviews: state.reviews,
    reviewComments: state.reviewComments, bot: state.config.shadow.codexReviewer });
  if (description.reviewer !== 'codex' || description.meta['implemented-by'] === 'unknown') return null;
  if (!['clean', 'findings'].includes(result.status)) return null;
  const prefix = `https://github.com/${state.target.repository}/pull/${state.target.number}`;
  const links = [`${prefix}#issuecomment-${result.evidence.stateCommentId}`, ...result.evidence.reviewIds.map(id => `${prefix}#pullrequestreview-${id}`)];
  return { role: 'independent', reviewer: 'codex', status: 'completed', reviewComplete: true, findings: result.findings,
    report: `GitHub API에서 기존 신뢰할 Codex 봇의 완료 상태와 전체 리뷰·인라인 지적을 수집했습니다.\n\n${links.join('\n')}`,
    source: { kind: 'github', ...result.evidence }, authentication: 'trusted-bot-api' };
}

function legacyReview(state) {
  // 이미 기존 게이트가 원문·hash·관리자 권한을 검증한 결과만 재사용한다. 새 확인을 생성하지 않는다.
  if (state.evaluation.decision.state !== 'success' || !state.evaluation.description.needsReview) return null;
  const basis = state.evaluation.evidence.record;
  const confirmationComment = state.comments.find(comment => comment.id === basis.confirmation?.id);
  const report = state.comments.find(comment => comment.id === basis.report?.id);
  const confirmation = parseConfirmation(confirmationComment?.body);
  if (!confirmation || !report || reportHash(report.body) !== confirmation.evidenceHash) fail('기존 관리자 확인 근거 불일치');
  return { role: 'independent', reviewer: confirmation.reviewer, status: 'completed', reviewComplete: true,
    findings: { ...confirmation.findings, unknown: confirmation.findings.unknown ?? 0 }, report: normalizeNewlines(report.body),
    source: { kind: 'legacy-admin-confirmed', reportCommentId: report.id, confirmationCommentId: confirmationComment.id }, authentication: 'legacy-gate-verified' };
}

export function assessReview(result, blocked, needsIndependentReview = true) {
  const verdict = (state, reason) => ({ state, reason, provenance: result?.authentication ?? 'missing' });
  if (blocked) return verdict('blocked', '해제되지 않은 변경 요청 리뷰');
  if (!result) return verdict('missing', '유효한 독립 리뷰 결과 없음');
  if (result.role !== 'independent' && needsIndependentReview) return verdict('self-only', '자체 리뷰는 필요한 독립 검증을 대체하지 않음');
  if (result.status !== 'completed' || result.reviewComplete !== true) return verdict('incomplete', '리뷰 미완료·스킵·실패·한도 초과');
  if (['critical', 'high', 'medium', 'unknown'].some(level => result.findings[level] !== 0)) return verdict('blocked', '차단 또는 판단 불가 지적 있음');
  if (result.authentication === 'unverified-local-session') return verdict('unverified-local-result', '미인증 로컬 주장. 실제 실행과 독립성 확인이 별도로 필요');
  return verdict('awaiting-human-confirmation', '자료 수집 완료. 실제 관리자 확인은 별도 필요');
}

export async function collectReviewPacket({ github, repository, number, result = null }) {
  // 자동 재시도 없이 두 번 전체 조회한다. 수집 중 같은 수의 댓글 수정·권한·CI 변경도 감지한다.
  const first = await readState({ github, repository, number });
  const state = await readState({ github, repository, number });
  if (!same(first.target, state.target) || first.collectionHash !== state.collectionHash) fail('수집 중 PR·정책·리뷰·검사 근거 변경');
  const selected = result === null ? legacyReview(state) ?? githubReview(state) : validateLocalResult(result, state.target, state.evaluation.description);
  const packet = { v: 1, target: state.target, collectionHash: state.collectionHash, result: selected,
    review: assessReview(selected, state.evaluation.blocked, state.evaluation.description.needsReview),
    gate: { ...state.evaluation.decision, kind: 'policy-reevaluation', publishedSourceVerified: false },
    independentReviewRequired: state.evaluation.description.needsReview,
    gateEvidenceDigest: state.evaluation.evidence.digest,
    checks: evaluateRequiredChecks({ head: state.target.head, checkRuns: state.checkRuns, requiredChecks: state.config.shadow.requiredChecks }),
    humanConfirmationRequired: state.evaluation.decision.state !== 'success', mergeAuthorized: false };
  return { packet, state };
}

export function reportRequest(packet, localResult = null) {
  const request = { v: 1, target: packet.target, collectionHash: packet.collectionHash, result: localResult };
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > maxRequestBytes) fail('등록 요청 크기 초과');
  return request;
}

export function renderEvidenceReport(packet) {
  if (!packet.result) fail('등록할 리뷰 결과 없음');
  const key = sha256(canonical({ v: 1, target: packet.target, collectionHash: packet.collectionHash, result: packet.result }));
  const role = packet.result.role === 'independent' ? '독립' : '자체';
  const heading = packet.result.authentication === 'unverified-local-session' ? `미인증 로컬 ${role} 리뷰 자료` : `${role} 리뷰 보고서`;
  const body = `# ${heading}\n\n<!-- photo-selector-review-evidence:v1 ${key} -->\n`
    + `\n자동 수집 자료입니다. 관리자 확인·병합 승인이 아닙니다.\n\n`
    + `HEAD: ${packet.target.head}\nBASE: ${packet.target.base}\nFingerprint: ${packet.target.fingerprint}\n`
    + `수집 digest: ${packet.collectionHash}\n출처 검증: ${packet.result.authentication}\n`
    + `리뷰 상태: ${packet.result.status}\n역할: ${packet.result.role} (${packet.result.reviewer})\n`
    + `지적: ${JSON.stringify(packet.result.findings)}\n원래 출처: ${JSON.stringify(packet.result.source)}\n\n`
    + `${packet.result.report}\n`;
  if (Buffer.byteLength(body, 'utf8') > maxRequestBytes) fail('보고서 크기 초과');
  return { key, body, evidenceHash: reportHash(body) };
}

async function assertPublisherWorkflow({ github, context }) {
  const repo = context.repo;
  const repository = `${repo.owner}/${repo.repo}`;
  const info = (await github.rest.repos.get(repo)).data;
  if (info.full_name !== repository || context.eventName !== 'workflow_dispatch' || context.ref !== `refs/heads/${info.default_branch}`
      || !positiveId(context.runId) || context.runAttempt !== 1 || !shaPattern.test(context.sha ?? '')) fail('기본 브랜치의 최초 수동 보고서 workflow만 허용');
  const run = (await github.rest.actions.getWorkflowRun({ ...repo, run_id: context.runId })).data;
  const workflow = (await github.rest.actions.getWorkflow({ ...repo, workflow_id: 'review-evidence.yml' })).data;
  if (run.id !== context.runId || run.run_attempt !== 1 || run.event !== 'workflow_dispatch'
      || run.head_sha !== context.sha || run.head_branch !== info.default_branch || run.repository?.full_name !== repository
      || run.head_repository?.full_name !== repository || !positiveId(workflow.id) || workflow.path !== evidenceWorkflow
      || run.workflow_id !== workflow.id || ![evidenceWorkflow, `${evidenceWorkflow}@refs/heads/${info.default_branch}`].includes(run.path)
      || run.status !== 'in_progress' || run.conclusion !== null) fail('보고서 workflow 실행 출처 불일치');
  const actor = run.triggering_actor ?? run.actor;
  if (!validAuthor(actor)) fail('등록 요청자 확인 실패');
  const permission = (await github.rest.repos.getCollaboratorPermissionLevel({ ...repo, username: actor.login })).data;
  if (!['write', 'maintain', 'admin'].includes(permission.role_name === 'maintain' ? 'maintain' : permission.permission)) fail('등록 요청자 쓰기 권한 없음');
  const approved = (await github.rest.repos.getContent({ ...repo, path: evidenceWorkflow, ref: info.default_branch })).data;
  const executed = (await github.rest.repos.getContent({ ...repo, path: evidenceWorkflow, ref: context.sha })).data;
  if (!shaPattern.test(approved.sha ?? '') || approved.sha !== executed.sha) fail('승인된 보고서 workflow와 실행 버전 불일치');
  return repository;
}

// 전용 workflow는 기본 GITHUB_TOKEN만 사용한다. CLI에는 직접 댓글 작성/승인 API 경로가 없다.
export async function publishEvidence({ github, context, request }) {
  if (!exactKeys(request, ['v', 'target', 'collectionHash', 'result']) || request.v !== 1
      || (request.result !== null && (typeof request.result !== 'object' || Array.isArray(request.result)))
      || Buffer.byteLength(JSON.stringify(request), 'utf8') > maxRequestBytes) fail('등록 요청 형식 또는 크기 오류');
  if (request.result !== null) fail('미인증 로컬 결과는 게시할 수 없음');
  if (typeof context.requestedNumber !== 'string' || !/^[1-9][0-9]*$/.test(context.requestedNumber)
      || context.requestedNumber !== String(request.target?.number)) fail('workflow PR 번호와 자료 대상 불일치');
  const repository = await assertPublisherWorkflow({ github, context });
  if (request.target?.repository !== repository) fail('다른 저장소 등록 요청');
  const { packet, state } = await collectReviewPacket({ github, repository, number: request.target.number, result: request.result });
  if (!same(packet.target, request.target) || packet.collectionHash !== request.collectionHash) fail('등록 전 대상·근거 변경');
  if (!['trusted-bot-api', 'legacy-gate-verified'].includes(packet.result?.authentication)) fail('게시 가능한 검증된 리뷰 근거 없음');
  const report = renderEvidenceReport(packet);
  const matches = state.comments.filter(comment => isEvidencePublisher(comment)
    && markerPattern.exec(normalizeNewlines(comment.body))?.[1] === report.key);
  if (matches.length > 1 || matches.some(comment => normalizeNewlines(comment.body) !== report.body)) fail('기존 등록 자료 불일치');
  if (matches.length === 1) return { ...report, commentId: matches[0].id, reused: true, approved: false };
  // 성공 여부가 불명확한 쓰기는 재시도하지 않는다. 다음 명시적 실행에서 실제 댓글을 다시 확인한다.
  const created = (await github.rest.issues.createComment({ ...state.repo, issue_number: packet.target.number, body: report.body })).data;
  if (!positiveId(created?.id) || !isEvidencePublisher(created) || normalizeNewlines(created.body) !== report.body) fail('보고서 게시 결과 확인 실패. 재시도 전 실제 PR 댓글 확인 필요');
  return { ...report, commentId: created.id, reused: false, approved: false };
}

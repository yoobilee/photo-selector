import { normalizeNewlines, parseMetadata, reportHash, sha256 } from './review-gate-core.mjs';

export const evidenceWorkflow = '.github/workflows/review-evidence.yml';
export const publicationModules = ['review-evidence.mjs', 'review-evidence-source.mjs', 'review-gate.mjs', 'review-gate-core.mjs', 'review-shadow.mjs', 'review-shadow-core.mjs'];
export const localHeading = '# 미인증 로컬 독립 리뷰 자료';
export const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const same = (a, b) => canonical(a) === canonical(b);
const id = value => Number.isSafeInteger(value) && value > 0;
const sha = value => /^[a-f0-9]{40}$/.test(value ?? '');
const digest = value => /^[a-f0-9]{64}$/.test(value ?? '');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && same(Object.keys(value).sort(), [...keys].sort());
const fail = message => { throw new Error(message); };
export const isEvidencePublisher = comment => comment?.user?.type === 'Bot' && comment.user.id === 41898282
  && comment.user.login === 'github-actions[bot]' && comment.performed_via_github_app?.id === 15368;
export const receiptName = (commentId, hash) => {
  if (!id(commentId) || !digest(hash)) fail('게시 영수증 값 오류');
  return `review-evidence-v2-${commentId}-${hash}`;
};

// 로컬 플러그인 결과는 제출자의 주장이다. 구조·대상·완료 상태만 검사하며 실행 인증으로 승격하지 않는다.
export function validatePluginResult(input, target, implementedBy) {
  if (!exact(input, ['v', 'target', 'role', 'reviewer', 'status', 'reviewComplete', 'findings', 'report', 'source', 'checks', 'notRun'])
      || input.v !== 2 || !same(input.target, target) || implementedBy !== 'claude'
      || input.role !== 'independent' || input.reviewer !== 'codex'
      || input.status !== 'completed' || input.reviewComplete !== true) fail('로컬 독립 리뷰 대상·완료 상태 오류');
  if (!exact(input.findings, ['critical', 'high', 'medium', 'low', 'unknown'])
      || Object.values(input.findings).some(n => !Number.isSafeInteger(n) || n < 0)) fail('로컬 지적 집계 오류');
  if (typeof input.report !== 'string' || !input.report.trim()) fail('로컬 리뷰 원문 오류');
  if (Buffer.byteLength(input.report) > 16_000) throw Object.assign(new Error('로컬 리뷰 원문 16000바이트 초과. 원문은 수집 ledger에 보존하며 자동 게시하지 않음'), { code: 'review-report-too-large' });
  if (!exact(input.source, ['kind', 'sessionId', 'jobId', 'threadId', 'turnId', 'startedAt', 'completedAt', 'outputHash'])
      || input.source.kind !== 'codex-plugin' || !['sessionId', 'jobId', 'threadId', 'turnId'].every(k => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.source[k] ?? ''))
      || !Number.isFinite(Date.parse(input.source.startedAt)) || !Number.isFinite(Date.parse(input.source.completedAt))
      || Date.parse(input.source.startedAt) > Date.parse(input.source.completedAt)
      || input.source.outputHash !== reportHash(input.report)) fail('로컬 실행 기록 오류');
  if (!Array.isArray(input.checks) || input.checks.length > 30 || input.checks.some(c => !exact(c, ['name', 'status', 'evidence'])
      || typeof c.name !== 'string' || !c.name || !['passed', 'failed', 'not-run', 'unknown'].includes(c.status)
      || typeof c.evidence !== 'string' || c.evidence.length > 2000)
      || !Array.isArray(input.notRun) || !input.notRun.length || input.notRun.length > 30
      || input.notRun.some(s => typeof s !== 'string' || !s.trim() || s.length > 2000)) fail('검사 결과·미실행 항목 누락');
  return { ...input, report: normalizeNewlines(input.report) };
}

export const localReviewKey = result => sha256(canonical(result));
export function renderLocalReport(result, runId) {
  if (!id(runId)) fail('게시 실행 ID 오류');
  const key = localReviewKey(result);
  const metadata = { v: 2, key, runId, result: { ...result, report: undefined } };
  const body = `${localHeading}\n\n<!-- photo-selector-review-evidence:v2 ${key} -->\n\n`
    + 'AI가 자동 등록한 미인증 로컬 결과입니다. 봇 게시·영수증은 리뷰 실행/독립성의 증명이 아니며 관리자 확인·병합 승인이 아닙니다.\n\n'
    + `\`\`\`json\n${JSON.stringify(metadata, null, 2)}\n\`\`\`\n\n## 리뷰 원문\n\n${result.report}\n`;
  if (Buffer.byteLength(body) > 60_000) fail('게시 본문 크기 초과');
  return { key, body, evidenceHash: reportHash(body) };
}

export function parseLocalReport(body) {
  const text = normalizeNewlines(body);
  const match = /^# 미인증 로컬 독립 리뷰 자료\n\n<!-- photo-selector-review-evidence:v2 ([a-f0-9]{64}) -->\n\n[^\n]+\n\n```json\n([\s\S]*?)\n```\n\n## 리뷰 원문\n\n([\s\S]*)\n$/.exec(text);
  if (!match || Buffer.byteLength(text) > 60_000) fail('로컬 봇 보고서 형식 오류');
  const metadata = JSON.parse(match[2]);
  if (!exact(metadata, ['v', 'key', 'runId', 'result']) || metadata.v !== 2 || metadata.key !== match[1]) fail('로컬 보고서 metadata 오류');
  const result = { ...metadata.result, report: match[3] };
  if (renderLocalReport(result, metadata.runId).body !== text || localReviewKey(result) !== metadata.key) fail('로컬 보고서 본문 변조');
  return { result, runId: metadata.runId, key: metadata.key };
}

// 영수증의 이름은 승인된 workflow가 댓글을 읽어 검증한 뒤 만든다. API가 실행에 연결하는 metadata만 사용한다.
// ZIP을 실행/추출하지 않으며, 영수증은 댓글 게시 경로만 증명한다. 로컬 리뷰 실행은 여전히 미인증이다.
export async function verifyLocalReport({ github, repo, pr, comment, fingerprint, approvedRef }) {
  if (!isEvidencePublisher(comment) || !id(comment.id) || comment.created_at !== comment.updated_at
      || !Number.isFinite(Date.parse(comment.created_at))) fail('로컬 보고서 작성자·수정 이력 오류');
  const { result, runId, key } = parseLocalReport(comment.body);
  const repository = `${repo.owner}/${repo.repo}`;
  const info = (await github.rest.repos.get(repo)).data;
  if (approvedRef !== undefined && !sha(approvedRef)) fail('게시 정책 snapshot SHA 오류');
  const ref = approvedRef ?? info.default_branch;
  const policy = (await github.rest.repos.getContent({ ...repo, path: '.ai/review-config.json', ref })).data;
  const target = { repository, number: pr.number, head: pr.head.sha, base: pr.base.sha, fingerprint, policySha: policy.sha };
  if (info.full_name !== repository || pr.base.ref !== info.default_branch || pr.base.repo?.full_name !== repository
      || pr.head.repo?.full_name !== repository || !sha(policy.sha) || !sha(pr.head.sha) || !sha(pr.base.sha) || !digest(fingerprint)) fail('보고서 대상 조회 오류');
  validatePluginResult(result, target, parseMetadata(pr.body)['implemented-by']);
  const run = (await github.rest.actions.getWorkflowRun({ ...repo, run_id: runId })).data;
  const workflow = (await github.rest.actions.getWorkflow({ ...repo, workflow_id: 'review-evidence.yml' })).data;
  if (run.id !== runId || !id(workflow.id) || workflow.path !== evidenceWorkflow || run.workflow_id !== workflow.id
      || ![evidenceWorkflow, `${evidenceWorkflow}@refs/heads/${info.default_branch}`].includes(run.path)
      || run.event !== 'workflow_dispatch' || run.run_attempt !== 1 || run.status !== 'completed' || run.conclusion !== 'success'
      || !sha(run.head_sha) || run.head_branch !== info.default_branch || run.repository?.full_name !== repository
      || run.head_repository?.full_name !== repository || !id(run.repository?.id) || run.head_repository.id !== run.repository.id
      || Date.parse(comment.created_at) < Date.parse(run.run_started_at) || Date.parse(comment.created_at) > Date.parse(run.updated_at)
      || !Number.isFinite(Date.parse(run.run_started_at)) || !Number.isFinite(Date.parse(run.updated_at))) fail('로컬 게시 workflow 실행 출처 오류');
  for (const path of [evidenceWorkflow, ...publicationModules.map(name => `.github/scripts/${name}`)]) {
    const approved = (await github.rest.repos.getContent({ ...repo, path, ref })).data;
    const executed = (await github.rest.repos.getContent({ ...repo, path, ref: run.head_sha })).data;
    if (!sha(approved.sha) || approved.sha !== executed.sha) fail('게시 코드 승인 버전 불일치');
  }
  const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, { ...repo, run_id: runId, per_page: 100 });
  const name = receiptName(comment.id, reportHash(comment.body));
  const matches = artifacts.filter(a => a.name === name);
  if (matches.length !== 1) fail('게시 영수증 누락·중복');
  const artifact = matches[0];
  if (!id(artifact.id) || artifact.expired !== false || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? '')
      || artifact.workflow_run?.id !== runId || artifact.workflow_run.head_sha !== run.head_sha
      || artifact.workflow_run.repository_id !== run.repository.id || artifact.workflow_run.head_repository_id !== run.repository.id
      || artifact.workflow_run.head_branch !== info.default_branch) fail('게시 영수증 출처 오류');
  return { result, key, runId, artifactId: artifact.id, artifactDigest: artifact.digest, workflowSha: run.head_sha };
}

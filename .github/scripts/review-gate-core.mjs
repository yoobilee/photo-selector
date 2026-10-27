import { createHash } from 'node:crypto';

export const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
const shaPattern = /^[a-f0-9]{40}$/;
const reportHeading = '# 독립 리뷰 보고서\n';

// 댓글 작성 환경에 따라 CRLF·CR로 저장될 수 있다. 줄바꿈만 LF로 통일하고 다른 내용은 바꾸지 않는다.
export const normalizeNewlines = value => String(value ?? '').replace(/\r\n?/g, '\n');
export const isReportBody = body => normalizeNewlines(body).startsWith(reportHeading);
// LF 보고서는 정규화 전후가 같으므로 기존 확인 댓글의 해시가 그대로 유효하다.
export const reportHash = body => sha256(normalizeNewlines(body));
const titlePattern = /^(feat|fix|chore|refactor|test|docs)(\([a-zA-Z0-9_/-]+\))?!?: [^\r\n]+$/;

export function validTitle(title) {
  return typeof title === 'string' && titlePattern.test(title)
    && /[가-힣]/u.test(title) && !title.includes('\uFFFD');
}

export function parseMetadata(body) {
  const blocks = [...(body ?? '').matchAll(/<!-- ai-review\s*\n([\s\S]*?)\n-->/g)];
  if (blocks.length !== 1) throw new Error('ai-review metadata는 정확히 한 개여야 합니다.');
  const values = {};
  for (const line of blocks[0][1].trim().split('\n')) {
    const match = /^([a-z-]+):\s*(\S+)\s*$/.exec(line.trim());
    if (!match || Object.hasOwn(values, match[1])) throw new Error('metadata 형식 또는 중복 필드 오류');
    values[match[1]] = match[2];
  }
  const allowed = ['implemented-by', 'risk', 'sensitive-change'];
  if (Object.keys(values).length !== allowed.length || Object.keys(values).some(key => !allowed.includes(key))) {
    throw new Error('metadata 필드 누락 또는 알 수 없는 필드');
  }
  if (!['claude', 'codex', 'human', 'unknown'].includes(values['implemented-by'])
      || !['low', 'medium', 'high'].includes(values.risk)
      || !['yes', 'no'].includes(values['sensitive-change'])) throw new Error('metadata 값 오류');
  return values;
}

export function describe(pr, files, config) {
  if (!validTitle(pr.title)) throw new Error('PR 제목은 허용 접두사와 한국어 설명을 사용해야 합니다.');
  if (!shaPattern.test(pr.head.sha) || !shaPattern.test(pr.base.sha)) throw new Error('PR SHA 오류');
  const meta = parseMetadata(pr.body);
  if (!files.length) throw new Error('변경 파일 조회 결과가 비어 있습니다.');
  const paths = files.flatMap(file => [file.filename, file.previous_filename].filter(Boolean));
  const high = paths.some(path => config.highRiskPaths.some(prefix => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)));
  const dependency = paths.some(path => /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|requirements[^/]*\.txt|poetry\.lock|uv\.lock|Pipfile\.lock|pyproject\.toml|Cargo\.(toml|lock)|go\.(mod|sum)|Gemfile(\.lock)?|composer\.(json|lock))$/.test(path));
  const risk = high || meta.risk === 'high' ? 'high' : meta.risk;
  const required = risk !== 'low' && (risk === 'high' || meta['sensitive-change'] === 'yes' || dependency || config.reviewAllMedium);
  // 보안 관련 변경을 low로 입력해 리뷰를 우회하지 않는다.
  const needsReview = required || meta['sensitive-change'] === 'yes' || dependency;
  const reviewer = meta['implemented-by'] === 'codex' ? 'claude'
    : meta['implemented-by'] === 'claude' ? 'codex' : config.defaultReviewer;
  if (!['claude', 'codex'].includes(reviewer) || reviewer === meta['implemented-by']) throw new Error('독립 reviewer 선택 오류');
  const fingerprint = sha256(JSON.stringify({
    head: pr.head.sha, base: pr.base.sha, title: pr.title, body: pr.body ?? '', meta, risk, config,
    files: files.map(file => [file.filename, file.previous_filename ?? null, file.status]).sort(),
  }));
  return { meta, risk, needsReview, reviewer, fingerprint, head: pr.head.sha, base: pr.base.sha };
}

export function parseConfirmation(body) {
  const match = /^\/review-gate\s*\n```json\s*\n([\s\S]*?)\n```\s*$/.exec(normalizeNewlines(body));
  if (!match) return null;
  try {
    const data = JSON.parse(match[1]);
    if (!data || Array.isArray(data) || typeof data !== 'object') return null;
    return data;
  } catch { return null; }
}

export function decide(description, confirmation, evidence) {
  if (!confirmation || confirmation.fingerprint !== description.fingerprint) return { state: 'failure', reason: '최신 변경에 대한 사람 확인 대기' };
  if (!description.needsReview) {
    if (confirmation.decision !== 'skip' || typeof confirmation.reason !== 'string' || !confirmation.reason.trim()) {
      return { state: 'failure', reason: '리뷰 생략 근거와 사람 확인 필요' };
    }
    return { state: 'success', reason: '사람이 위험도와 독립 리뷰 생략 근거를 확인함' };
  }
  if (description.meta['implemented-by'] === 'unknown') return { state: 'failure', reason: '구현 Agent 확인 필요' };
  if (confirmation.decision !== 'pass' || confirmation.reviewer !== description.reviewer || confirmation.reviewComplete !== true) {
    return { state: 'failure', reason: '필수 독립 리뷰 미완료 또는 reviewer 불일치' };
  }
  const counts = confirmation.findings;
  if (!counts || ['critical', 'high', 'medium', 'low'].some(key => !Number.isSafeInteger(counts[key]) || counts[key] < 0)) {
    return { state: 'failure', reason: '지적사항 집계 오류' };
  }
  if (counts.critical || counts.high || counts.medium) return { state: 'failure', reason: '미해결 차단 지적 또는 medium 사람 판단 필요' };
  const evidenceBody = evidence && normalizeNewlines(evidence.body);
  if (!evidence || !isReportBody(evidenceBody) || evidence.hash !== reportHash(evidenceBody) || evidence.hash !== confirmation.evidenceHash
      || !evidenceBody.includes(description.head) || !evidenceBody.includes(description.base)) {
    return { state: 'failure', reason: '리뷰 근거 누락·변경 또는 대상 SHA 불일치' };
  }
  return { state: 'success', reason: '최신 변경의 독립 리뷰 결과를 사람이 확인함' };
}

export function validateConfig(config) {
  if (!config || config.checkName !== 'independent-review'
      || !['claude', 'codex'].includes(config.defaultReviewer)
      || typeof config.reviewAllMedium !== 'boolean'
      || !Array.isArray(config.highRiskPaths) || !config.highRiskPaths.length
      || config.highRiskPaths.some(path => typeof path !== 'string' || !path.trim())) throw new Error('리뷰 설정 오류');
}

// 댓글과 새 커밋은 변경 요청을 해제하지 않는다. 기각된 리뷰 자체만 제외한다.
export function blockingReviews(reviews) {
  const opinions = new Map();
  for (const review of [...reviews].sort((a,b) => Number(a.id)-Number(b.id))) {
    if (['APPROVED','CHANGES_REQUESTED'].includes(review.state)) opinions.set(review.user.id,review);
  }
  return [...opinions.values()].filter(review => review.state === 'CHANGES_REQUESTED');
}

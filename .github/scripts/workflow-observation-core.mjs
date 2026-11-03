import { sha256, validateConfig } from './review-gate-core.mjs';
import { classifyRisk } from './review-shadow-core.mjs';

const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = value => Number.isSafeInteger(value) && value > 0;
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const keys = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
export function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  requireValue(value && Object.getPrototypeOf(value) === Object.prototype, 'JSON 값 누락/오류');
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
function target(value) {
  requireValue(keys(value, ['repository','number','head','base','fingerprint'])
    && typeof value.repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository) && id(value.number)
    && sha(value.head) && sha(value.base) && digest(value.fingerprint), '대상 오류');
}
const pathValid = path => typeof path === 'string' && path.length > 0 && !path.startsWith('/')
  && !path.includes('\\') && !path.split('/').some(part => !part || part === '.' || part === '..');
export function classifyWork({ meta, files, config }) {
  validateConfig(config);
  requireValue(Array.isArray(files) && files.length > 0 && files.every(file => pathValid(file.filename)
    && ['added','modified','removed','renamed','copied','changed','unchanged'].includes(file.status)
    && (file.status !== 'renamed' || pathValid(file.previous_filename))), '파일 목록 오류');
  requireValue(new Set(files.map(file => file.filename)).size === files.length, '중복 파일');
  requireValue(['codex','claude'].includes(meta?.['implemented-by']) && ['low','medium','high'].includes(meta.risk)
    && ['yes','no'].includes(meta['sensitive-change']), '구현자/위험도 불명');
  const paths = files.flatMap(file => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])]);
  requireValue(paths.every(pathValid), '이전 경로 오류');
  const dependency = paths.some(path => ['package.json','package-lock.json'].includes(path));
  const risk = classifyRisk({ meta, files: paths.map(filename => ({ filename })), gateConfig: config, shadow: config.shadow, dependency });
  const kind = paths.some(path => path.startsWith('src/') || path.startsWith('public/') || path === 'index.html') ? 'product' : 'general';
  requireValue(kind !== 'product' || meta['implemented-by'] === 'claude', '제품 구현자는 Claude 필요');
  requireValue(kind !== 'general' || risk.risk === 'high' || meta['implemented-by'] === 'codex', '일반 자동 경로는 Codex 구현 필요');
  return { kind, risk: risk.risk, role: risk.risk === 'high' || kind === 'product' ? 'independent' : 'self',
    reviewer: risk.risk === 'high' ? (meta['implemented-by'] === 'codex' ? 'claude' : 'codex') : kind === 'product' ? 'codex' : meta['implemented-by'] };
}
// apiEvidence는 향후 신뢰된 API adapter가 전달할 관찰값이다. 파일 입력의 신뢰를 승격하지 않는다.
export function validateReceipt(receipt, { currentTarget, policyHash, requirement, trust, apiEvidence }) {
  target(currentTarget);
  requireValue(keys(receipt, ['v','target','policyHash','role','reviewer','status','findings','report','reportHash','source']) && receipt.v === 1, 'receipt 형식 오류');
  target(receipt.target);
  requireValue(canonical(receipt.target) === canonical(currentTarget) && digest(policyHash) && receipt.policyHash === policyHash, '오래된 대상/정책');
  requireValue(receipt.role === requirement.role && receipt.reviewer === requirement.reviewer && receipt.status === 'completed', '역할/완료 오류');
  requireValue(keys(receipt.findings, ['critical','high','medium','low','unknown'])
    && Object.values(receipt.findings).every(value => Number.isSafeInteger(value) && value >= 0), '집계 누락/오류');
  requireValue(['critical','high','medium','unknown'].every(level => receipt.findings[level] === 0), '차단 지적');
  requireValue(typeof receipt.report === 'string' && receipt.report.trim() && Buffer.byteLength(receipt.report) <= 20000
    && receipt.reportHash === sha256(receipt.report), '본문 hash 오류');
  const source = receipt.source;
  requireValue(keys(source, ['appId','installationId','runId','attempt','workflow','executorSha','resultId'])
    && [source.appId,source.installationId,source.runId,source.attempt,source.resultId].every(id) && source.attempt === 1
    && sha(source.executorSha), '실행 출처 오류');
  requireValue(id(trust?.appId) && id(trust?.installationId) && pathValid(trust?.workflow)
    && sha(trust?.executorSha) && ['appId','installationId','workflow','executorSha'].every(key => source[key] === trust[key]), '미설정/위조 신원');
  requireValue(apiEvidence?.status === 'completed' && apiEvidence.conclusion === 'success'
    && canonical(apiEvidence.target) === canonical(currentTarget) && apiEvidence.reportHash === receipt.reportHash
    && apiEvidence.role === receipt.role && apiEvidence.reviewer === receipt.reviewer && apiEvidence.policyHash === receipt.policyHash
    && canonical(apiEvidence.findings) === canonical(receipt.findings)
    && canonical(apiEvidence.source) === canonical(source), 'API 원본 불일치');
  return { reportHash: receipt.reportHash, source: { ...source } };
}
export function stateDigest(snapshot) {
  requireValue(keys(snapshot, ['target','policyHash','title','body','summary','files','checks','reviews','permissions']), '상태 필드 누락');
  target(snapshot.target);
  requireValue(digest(snapshot.policyHash) && ['title','body','summary'].every(key => typeof snapshot[key] === 'string'), '상태 형식 오류');
  for (const key of ['files','checks','reviews','permissions']) requireValue(Array.isArray(snapshot[key]), '상태 목록 누락');
  return sha256(canonical(snapshot));
}
export function observe({ before, after, receipt, meta, config, trust, apiEvidence }) {
  const result = { mode: 'observation-only', mergeAuthorized: false, approvalVerified: false, sourceAuthenticated: false };
  try {
    const value = stateDigest(before);
    requireValue(value === stateDigest(after), '동시 변경');
    const requirement = classifyWork({ meta, files: after.files, config });
    validateReceipt(receipt, { currentTarget: after.target, policyHash: after.policyHash, requirement, trust, apiEvidence });
    requireValue(after.reviews.length === 1 && canonical(after.reviews[0]) === canonical(receipt), '현재 리뷰 digest 근거 불일치');
    requireValue(after.checks.length > 0 && after.checks.every(check => id(check.id) && check.head === after.target.head
      && check.status === 'completed' && check.conclusion === 'success' && id(check.appId) && id(check.runId)), 'CI 누락/실패');
    requireValue(config.shadow.requiredChecks.every(required => after.checks.filter(check => check.name === required.name
      && check.appId === required.appId && check.workflow === required.workflow).length === 1), '필수 CI 출처/중복 오류');
    // 이 단계는 CI workflow 출처·전체 리뷰 수집·사용자 승인을 인증하지 않는다.
    return { ...result, state: 'candidate', stateDigest: value, humanApprovalRequired: requirement.risk === 'high' };
  } catch (error) { return { ...result, state: 'blocked', reason: error.message }; }
}

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// 주입 API는 GET뿐이다. 공개 App 권한은 installation token의 실효 권한 증명이 아니다.
export async function preflight({ repository, settings, get }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) throw new Error('repository');
  const issues = [];
  const read = async path => { try { return await get(path); } catch { issues.push(`조회 불가: ${path}`); return null; } };
  const repo = await read(`repos/${repository}`);
  if (repo?.permissions?.admin !== false || repo?.permissions?.maintain !== false) issues.push('Agent 관리자 인증 격리 미확인');
  const user = await read('user');
  const protection = await read(`repos/${repository}/branches/${encodeURIComponent(repo?.default_branch ?? 'main')}/protection`);
  if (protection?.required_status_checks?.strict !== true || protection?.enforce_admins?.enabled !== true
      || !['verify','independent-review'].every(name => protection?.required_status_checks?.checks?.some(c => c.context === name && c.app_id === 15368))) issues.push('기존 보호 불일치');
  const roles = { evidence: ['contents','pull_requests','actions','issues','checks'], merger: ['contents','pull_requests','issues','actions','checks','administration'] };
  for (const [role, allowed] of Object.entries(roles)) {
    const expected = settings?.[role];
    if (!Number.isSafeInteger(expected?.appId) || expected.appId <= 0 || !/^[a-z0-9-]+$/.test(expected.slug ?? '')) { issues.push(`${role} App 미설정`); continue; }
    const app = await read(`apps/${expected.slug}`);
    const needed = role === 'evidence' ? { contents:'read',pull_requests:'read',actions:'read',issues:'write',checks:'write' }
      : { contents:'write',pull_requests:'write',issues:'read',actions:'read',checks:'read',administration:'read' };
    if (!Object.entries(needed).every(([key,value]) => app?.permissions?.[key] === value)) issues.push(`${role} 필수 권한 누락/불일치`);
    if (app?.id !== expected.appId || !app.permissions || Object.entries(app.permissions).some(([key,value]) => key !== 'metadata'
      && (!allowed.includes(key) || !['read','write'].includes(value)
        || (value === 'write' && !(role === 'evidence' ? ['issues','checks'] : ['contents','pull_requests']).includes(key))))) issues.push(`${role} App 신원/권한 불일치`);
  }
  if (!settings?.evidence?.appId || settings.evidence.appId === settings?.merger?.appId) issues.push('게시/병합 App 분리 미확인');
  const env = await read(`repos/${repository}/environments/photo-selector-high-risk-merge`);
  const rule = env?.protection_rules?.find(rule => rule.type === 'required_reviewers');
  if (rule?.prevent_self_review !== true || !rule.reviewers?.some(r => r.type === 'User' && r.reviewer?.id === settings?.approverId)
      || env?.can_admins_bypass !== false) issues.push('Required reviewers / Prevent self-review / 우회 금지 미확인');
  if (!Number.isSafeInteger(settings?.executorUserId) || !Number.isSafeInteger(settings?.approverId)
      || settings.executorUserId === settings.approverId || user?.id === settings.approverId) issues.push('실행자/승인자 분리 미확인');
  // API로 로컬 OS/credential manager 격리 또는 App private key 접근 통제는 입증할 수 없다.
  return { mode: 'read-only', mergeAuthorized: false, ready: false, issues,
    limitations: ['OS 인증 격리·installation 유효 권한·실제 workflow 실행자·환경 branch 제한·승인 API 연계는 후속 통합 검증 필요'] };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [repository, path, ...extra] = process.argv.slice(2);
    if (extra.length) throw new Error('args');
    const settings = path ? JSON.parse(readFileSync(path, 'utf8')) : {};
    const result = await preflight({ repository, settings, get: path => JSON.parse(execFileSync('gh', ['api', '--method', 'GET', path], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] })) });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.issues.length ? 1 : 0;
  } catch { console.error('읽기 전용 진단 실패. 설정·조회 권한을 확인하세요.'); process.exitCode = 1; }
}

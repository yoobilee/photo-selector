import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validTitle } from './review-gate-core.mjs';
import { evaluatePR } from './review-gate.mjs';
import { verifyGateSource } from './review-gate-source.mjs';

// 사용자가 명시적으로 실행하는 병합 도구. workflow에서는 호출하지 않는다.
const [repo, number, method = 'squash'] = process.argv.slice(2);
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '') || !/^[1-9][0-9]*$/.test(number ?? '') || !['squash', 'merge'].includes(method)) {
  console.error('사용법: node .github/scripts/merge-pr.mjs owner/repo PR번호 squash|merge');
  process.exit(1);
}
const gh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 });
const api = path => JSON.parse(gh(['api',path]));
const [owner, repoName] = repo.split('/');
const route = (pattern, paged=false) => async args => {
  const path=pattern.replace(/:([a-z_]+)/g,(_,key)=>encodeURIComponent(args[key]));
  if (!paged) {
    try { return {data:api(path)}; }
    catch (error) {
      // 외부 리뷰어의 명시적인 404와 통신·인증 실패를 구분한다.
      if (/\(HTTP 404\)/.test(String(error.stderr ?? ''))) error.status=404;
      throw error;
    }
  }
  const pages=JSON.parse(gh(['api',`${path}${path.includes('?')?'&':'?'}per_page=100`,'--paginate','--slurp']));
  return {data:pages.flat()};
};
const github={rest:{
  pulls:{list:route(`repos/${repo}/pulls?state=open`,true),get:route(`repos/${repo}/pulls/:pull_number`),listFiles:route(`repos/${repo}/pulls/:pull_number/files`,true),listReviews:route(`repos/${repo}/pulls/:pull_number/reviews`,true)},
  issues:{listComments:route(`repos/${repo}/issues/:issue_number/comments`,true)},
  repos:{getCollaboratorPermissionLevel:route(`repos/${repo}/collaborators/:username/permission`)},
},paginate:async(fn,args)=>(await fn(args)).data};
let merged = false;
let messageDirectory;
try {
  const pr = api(`repos/${repo}/pulls/${number}`);
  const defaultBranch=api(`repos/${repo}`).default_branch;
  if (pr.state !== 'open' || pr.draft || !validTitle(pr.title)) throw new Error('PR 상태 또는 제목 규칙 오류');
  if (pr.base.ref !== defaultBranch || pr.base.repo.full_name !== repo) throw new Error('기본 브랜치 대상 PR이 아님');
  const configFile=api(`repos/${repo}/contents/.ai/review-config.json?ref=${encodeURIComponent(defaultBranch)}`);
  if (configFile.encoding!=='base64') throw new Error('승인된 정책 조회 실패');
  const config=JSON.parse(Buffer.from(configFile.content,'base64').toString('utf8'));
  gh(['pr', 'checks', number, '--repo', repo, '--required']);
  const current=await evaluatePR({github,repo:{owner,repo:repoName},pr,config});
  if (current.decision.state!=='success') throw new Error('현재 독립 리뷰 근거 미충족');
  const pages=JSON.parse(gh(['api',`repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`,'--paginate','--slurp']));
  const check=pages.flatMap(page=>page.check_runs).filter(item=>item.name==='independent-review').sort((a,b)=>b.id-a.id)[0];
  await verifyGateSource({check,pr,fingerprint:current.description.fingerprint,repository:repo,defaultBranch,api});
  // base의 확인·병합 사이 경쟁은 GitHub의 strict required checks가 최종 강제한다.
  const protectedChecks=api(`repos/${repo}/branches/${encodeURIComponent(defaultBranch)}/protection/required_status_checks`);
  if (protectedChecks.strict!==true || !protectedChecks.checks?.some(item=>item.context==='independent-review' && item.app_id===check.app.id)) throw new Error('최신 base 및 게이트 앱 고정 보호 설정 필요');
  const again=await evaluatePR({github,repo:{owner,repo:repoName},pr,config});
  if (again.decision.state!=='success' || again.description.fingerprint!==current.description.fingerprint) throw new Error('병합 직전 리뷰 조건 변경');
  // 셸 문자열을 생성하지 않고 Unicode 인수 배열을 사용한다.
  // UTF-8 파일로 PR 본문과 Issue 자동 종료 키워드를 그대로 보존한다.
  messageDirectory = mkdtempSync(join(tmpdir(), 'starter-merge-'));
  const bodyFile = join(messageDirectory, 'body.txt');
  writeFileSync(bodyFile, pr.body ?? '', { encoding: 'utf8', mode: 0o600 });
  gh(['pr', 'merge', number, '--repo', repo, `--${method}`, '--match-head-commit', pr.head.sha, '--subject', pr.title, '--body-file', bodyFile]);
  merged = true;
  const after = JSON.parse(gh(['api', `repos/${repo}/pulls/${number}`]));
  if (!after.merged || !after.merge_commit_sha) throw new Error('병합 결과 조회 실패');
  const commit = JSON.parse(gh(['api', `repos/${repo}/commits/${after.merge_commit_sha}`]));
  const subject = commit.commit.message.split('\n')[0];
  if (subject !== pr.title || !validTitle(subject)) throw new Error('저장된 병합 제목 불일치');
  console.log(`병합과 실제 제목 검증 완료: ${after.merge_commit_sha}`);
  console.log(subject);
} catch {
  console.error(merged
    ? '병합 명령은 완료됐지만 사후 검증이 실패했습니다. PR과 실제 병합 커밋을 사람이 확인하세요. 재병합·이력 재작성은 하지 않습니다.'
    : '병합 조건 확인 또는 병합 명령이 실패했습니다. GitHub PR 상태를 확인하세요. 원시 오류·인증값은 출력하지 않습니다.');
  process.exitCode = 1;
} finally {
  if (messageDirectory) rmSync(messageDirectory, { recursive: true, force: true });
}

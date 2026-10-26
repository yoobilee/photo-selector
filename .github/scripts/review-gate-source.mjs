// check의 앱뿐 아니라 실제 승인된 workflow 실행 출처를 확인한다.
export async function verifyGateSource({ check, pr, fingerprint, repository, defaultBranch, api }) {
  if (!check || check.name !== 'independent-review' || check.app?.slug !== 'github-actions'
      || check.status !== 'completed' || check.conclusion !== 'success' || check.head_sha !== pr.head.sha) throw new Error('게이트 앱·상태 오류');
  const proof = JSON.parse(check.external_id);
  if (proof.pr !== pr.number || proof.fingerprint !== fingerprint || !/^[1-9][0-9]*$/.test(proof.runId)
      || !/^[1-9][0-9]*$/.test(proof.attempt)) throw new Error('게이트 대상·최신성 오류');
  if (check.details_url !== `https://github.com/${repository}/actions/runs/${proof.runId}`) throw new Error('검사 출처 링크 오류');
  const path = '.github/workflows/independent-review.yml';
  const workflow = api(`repos/${repository}/actions/workflows/independent-review.yml`);
  const run = api(`repos/${repository}/actions/runs/${proof.runId}`);
  if (run.workflow_id !== workflow.id || run.path !== path || run.status !== 'completed'
      || run.conclusion !== 'success' || String(run.run_attempt) !== proof.attempt
      || run.repository?.full_name !== repository || run.head_repository?.full_name !== repository
      || !['pull_request_target','pull_request_review','pull_request_review_comment','issue_comment','push'].includes(run.event)) throw new Error('승인된 workflow 실행이 아님');
  // 같은 경로의 PR workflow를 변조해 성공을 게시하는 경우도 거부한다.
  const approved = api(`repos/${repository}/contents/${path}?ref=${encodeURIComponent(defaultBranch)}`);
  const executed = api(`repos/${repository}/contents/${path}?ref=${encodeURIComponent(run.head_sha)}`);
  if (!approved.sha || executed.sha !== approved.sha) throw new Error('실행 workflow와 승인된 workflow 불일치');
  return proof;
}

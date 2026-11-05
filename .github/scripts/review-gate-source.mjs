const digestPattern = /^[a-f0-9]{64}$/;
const shaPattern = /^[a-f0-9]{40}$/;
const validId = value => Number.isSafeInteger(value) && value > 0;
// 실패 사유 code는 병합 도구가 사람에게 필요한 조치(게이트 재실행 등)를 안내하는 데 쓴다.
const fail = (message, code = 'source') => Object.assign(new Error(message), { code });

// check의 앱뿐 아니라 실제 승인된 workflow 실행 출처와 판정 근거(proof v2)를 확인한다.
// evidenceDigest는 호출자가 지금 다시 계산한 근거다. 게이트가 판정할 때의 근거와 다르면 그 성공은 오래된 결과다.
export async function verifyGateSource({ check, pr, fingerprint, evidenceDigest, repository, defaultBranch, api }) {
  if (!check || !validId(check.id) || check.name !== 'independent-review' || check.app?.id !== 15368 || check.app?.slug !== 'github-actions'
      || check.status !== 'completed' || check.conclusion !== 'success' || check.head_sha !== pr.head.sha) throw fail('게이트 앱·상태 오류');
  const proof = JSON.parse(check.external_id);
  // v1 proof에는 판정 근거가 없어 지금 근거와 같은지 알 수 없다. 자동으로 v2로 신뢰하지 않는다.
  if (proof?.v === undefined) throw fail('게이트 proof v1', 'proof-v1');
  if (proof.v !== 2 || !digestPattern.test(proof.evidenceDigest ?? '')) throw fail('게이트 proof 형식 오류');
  if (proof.pr !== pr.number || proof.fingerprint !== fingerprint || !/^[1-9][0-9]*$/.test(proof.runId)
      || !/^[1-9][0-9]*$/.test(proof.attempt)) throw fail('게이트 대상·최신성 오류');
  if (!digestPattern.test(evidenceDigest ?? '') || proof.evidenceDigest !== evidenceDigest) throw fail('게이트 판정 이후 근거 변경', 'evidence-changed');
  // GitHub는 API로 만든 custom check의 details_url을 /runs/<check ID>로 돌려줄 수도 있다.
  // check ID와 workflow run ID를 혼동하거나 임의 링크를 허용하지 않는다. URL 다음에도 실제 실행을 검증한다.
  const prefix = `https://github.com/${repository}`;
  if (check.details_url !== `${prefix}/actions/runs/${proof.runId}`
      && check.details_url !== `${prefix}/runs/${check.id}`) throw fail('검사 출처 링크 오류');
  const path = '.github/workflows/independent-review.yml';
  const workflow = api(`repos/${repository}/actions/workflows/independent-review.yml`);
  const run = api(`repos/${repository}/actions/runs/${proof.runId}`);
  if (!validId(run.id) || String(run.id) !== proof.runId || !validId(workflow.id) || workflow.path !== path
      || run.workflow_id !== workflow.id || run.path !== path || !shaPattern.test(run.head_sha ?? '') || run.status !== 'completed'
      || run.conclusion !== 'success' || String(run.run_attempt) !== proof.attempt
      || run.repository?.full_name !== repository || run.head_repository?.full_name !== repository
      || !['pull_request_target','pull_request_review','pull_request_review_comment','issue_comment','push'].includes(run.event)) throw fail('승인된 workflow 실행이 아님');
  // 실행 HEAD는 기본 브랜치일 수 있어 PR HEAD와 같다고 요구하지 않는다. 그 HEAD의 YAML을 승인된 버전과 비교한다.
  const approved = api(`repos/${repository}/contents/${path}?ref=${encodeURIComponent(defaultBranch)}`);
  const executed = api(`repos/${repository}/contents/${path}?ref=${encodeURIComponent(run.head_sha)}`);
  if (!approved.sha || executed.sha !== approved.sha) throw fail('실행 workflow와 승인된 workflow 불일치');
  return proof;
}

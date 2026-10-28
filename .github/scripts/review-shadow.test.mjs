import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe as describePR, sha256 } from './review-gate-core.mjs';
import { runGate } from './review-gate.mjs';
import {
  approvalText, classifyRisk, compareWithGate, decideShadow, evaluateCodexReview, evaluateRequiredChecks, findApproval,
  parseReviewState, parseSeverity, planReviewRequest, validateShadowConfig,
} from './review-shadow-core.mjs';

const config = JSON.parse(readFileSync(new URL('../../.ai/review-config.json', import.meta.url)));
const shadow = config.shadow;
const bot = shadow.codexReviewer;
// 실제 Codex GitHub 응답 원문. photo-selector #5와 공개 저장소 worky의 응답이다.
const real = JSON.parse(readFileSync(new URL('./fixtures/codex-github-responses.json', import.meta.url)));
const head = real.photoSelectorPr5.head;
const otherHead = 'c'.repeat(40);
const meta = (risk = 'medium', sensitive = 'no', agent = 'claude') => ({ 'implemented-by': agent, risk, 'sensitive-change': sensitive });
const clone = value => JSON.parse(JSON.stringify(value));

// 실제 상태 댓글에서 상태 값만 바꾼 변형. 지적 있음·진행 중 상태 댓글은 아직 실측하지 못해 실제 형식에서 파생한다.
function stateComment(change = {}, sha = head) {
  const comment = clone(real.photoSelectorPr5.reviewSummaryCompleted);
  comment.body = comment.body.replace(/<!-- codex-review-state:v1 (\{.*\}) -->/, (_, json) => {
    const state = JSON.parse(json);
    Object.assign(state.code_review, { commit_sha: sha }, change);
    return `<!-- codex-review-state:v1 ${JSON.stringify(state)} -->`;
  });
  return comment;
}
// worky #50의 실제 지적 리뷰를 현재 head 기준으로 옮긴다.
function findingReview(sha = head) {
  const { review, comments } = clone(real.workyFindings);
  review.body = review.body.replace(`\`${review.commit_id.slice(0, 10)}\``, `\`${sha.slice(0, 10)}\``);
  review.commit_id = sha;
  for (const comment of comments) comment.commit_id = sha;
  return { reviews: [review], reviewComments: comments };
}
// 실제 인라인 지적 66건의 첫 줄은 모두 `**<sub><sub>![Pn Badge](…)</sub></sub>  제목**` 형식이다.
const badge = level => `**<sub><sub>![${level} Badge](https://img.shields.io/badge/${level}-red?style=flat)</sub></sub>  제목**\n\n본문`;
const codexFor = input => evaluateCodexReview({ head, comments: [], reviews: [], reviewComments: [], bot, ...input });

test('현재 shadow 설정이 유효하고 잘못된 설정은 거부', () => {
  validateShadowConfig(shadow);
  for (const change of [{ enabled: 'yes' }, { lowRiskPaths: [''] }, { requiredChecks: [] }, { codexReviewer: { ...bot, userId: '199175422' } }, { maxReviewRequests: 0 }, { requiredChecks: [{ name: 'verify', appId: 15368, workflow: 'ci.yml' }] }]) {
    assert.throws(() => validateShadowConfig({ ...shadow, ...change }), JSON.stringify(change));
  }
});

test('Low는 허용 목록 파일만, 문서라도 목록 밖이면 Medium', () => {
  const classify = (files, m = meta('low'), dependency = false) => classifyRisk({ meta: m, files, gateConfig: config, shadow, dependency }).risk;
  assert.equal(classify([{ filename: 'README.md' }]), 'low');
  assert.equal(classify([{ filename: 'README.md' }, { filename: 'CHANGELOG.md' }]), 'low');
  assert.equal(classify([{ filename: 'docs/guide.md' }]), 'medium');
  assert.equal(classify([{ filename: 'README.md' }, { filename: 'src/App.tsx' }]), 'medium');
  assert.equal(classify([{ filename: 'README.md' }], meta('medium')), 'medium');
});

test('High는 metadata를 낮게 적어도 경로·민감 변경·의존성으로 올림', () => {
  const classify = (files, m = meta('low'), dependency = false) => classifyRisk({ meta: m, files, gateConfig: config, shadow, dependency });
  for (const filename of ['.github/workflows/ci.yml', '.github/scripts/merge-pr.mjs', '.ai/policies/verification.md', 'AGENTS.md', 'src/photos/importPhotos.ts', 'vite.config.ts', '.codex/config.toml']) {
    assert.equal(classify([{ filename }]).risk, 'high', filename);
  }
  assert.equal(classify([{ filename: 'README.md', previous_filename: '.github/workflows/ci.yml' }]).risk, 'high');
  assert.equal(classify([{ filename: 'README.md' }], meta('low', 'yes')).risk, 'high');
  assert.equal(classify([{ filename: 'package.json' }], meta('low'), true).risk, 'high');
  assert.equal(classify([{ filename: 'README.md' }], meta('high')).risk, 'high');
  // 경로 규칙은 접두사 경계를 지킨다.
  assert.equal(classify([{ filename: 'src/photos-old.ts' }], meta('medium')).risk, 'medium');
  assert.match(classify([{ filename: 'src/photos/a.ts' }]).reasons.join(), /src\/photos/);
});

test('실제 PR #5 상태 댓글을 완료·지적 없음으로 해석', () => {
  const state = parseReviewState(real.photoSelectorPr5.reviewSummaryCompleted.body);
  assert.deepEqual(state, { valid: true, commitSha: head, status: 'completed', hasAnyFindings: false, hasUnresolvedFindings: false });
  const codex = codexFor({ comments: [real.photoSelectorPr5.environmentNotice, real.photoSelectorPr5.reviewSummaryCompleted, real.photoSelectorPr5.reviewReceipt] });
  assert.equal(codex.status, 'clean');
  assert.deepEqual(codex.findings, { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 });
});

test('실제 worky 지적 리뷰의 P1·P2 배지를 high·medium으로 집계', () => {
  assert.deepEqual(real.workyFindings.comments.map(comment => parseSeverity(comment.body)), ['high', 'high', 'medium']);
  const codex = codexFor({ comments: [stateComment({ has_any_findings: true, has_unresolved_findings: true })], ...findingReview() });
  assert.equal(codex.status, 'findings');
  assert.deepEqual(codex.findings, { critical: 0, high: 2, medium: 1, low: 0, unknown: 0 });
});

test('P0·P3와 심각도 없는 지적을 구분', () => {
  const { reviews, reviewComments } = findingReview();
  const make = bodies => bodies.map((body, index) => ({ ...reviewComments[0], id: 900 + index, body }));
  const codex = codexFor({ comments: [stateComment({ has_any_findings: true, has_unresolved_findings: true })], reviews, reviewComments: make([badge('P0'), badge('P3'), '배지 없는 지적', '본문 중간의 ![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)']) });
  assert.deepEqual(codex.findings, { critical: 1, high: 0, medium: 0, low: 1, unknown: 2 });
});

// 실제 리뷰 본문 안내문 앞에 지적 줄을 넣는다. 본문 지적은 실측하지 못해 인라인 지적 형식에서 파생한다.
const bodyWith = (review, lines) => ({ ...review, body: review.body.replace('<details>', `${lines.join('\n\n')}\n\n<details>`) });
const titledBadge = (level, title) => `**<sub><sub>![${level} Badge](https://img.shields.io/badge/${level}-orange?style=flat)</sub></sub>  ${title}**`;

test('리뷰 본문의 P0~P3 지적도 집계하고 인라인과 같은 지적은 한 번만 셈', () => {
  const { reviews: [review], reviewComments } = findingReview();
  const inline = { ...reviewComments[0], id: 950, body: `${titledBadge('P3', '사소한 이름 정리')}\n\n설명` };
  const state = [stateComment({ has_any_findings: true, has_unresolved_findings: true })];
  const withBodyP1 = codexFor({ comments: state, reviews: [bodyWith(review, [titledBadge('P1', '권한 확인 누락')])], reviewComments: [inline] });
  assert.equal(withBodyP1.status, 'findings');
  assert.deepEqual(withBodyP1.findings, { critical: 0, high: 1, medium: 0, low: 1, unknown: 0 });
  const decision = decideShadow({ risk: 'medium', meta: meta(), checks: [{ name: 'verify', state: 'success' }], codex: withBodyP1, approval: { state: 'none' }, blocked: false, request: { requestCount: 1 }, maxReviewRequests: 3, baseSync: 'current' });
  assert.equal(decision.candidate, false);
  const duplicate = codexFor({ comments: state, reviews: [bodyWith(review, [titledBadge('P3', '사소한 이름 정리')])], reviewComments: [inline] });
  assert.deepEqual(duplicate.findings, { critical: 0, high: 0, medium: 0, low: 1, unknown: 0 });
  // 본문만으로 지적이 전달된 경우도 집계한다.
  const bodyOnly = codexFor({ comments: state, reviews: [bodyWith(review, [titledBadge('P2', '경계 조건')])], reviewComments: [] });
  assert.equal(bodyOnly.status, 'findings');
  assert.equal(bodyOnly.findings.medium, 1);
});

test('리뷰 본문 형식이 불명확하거나 지적 수가 상태와 맞지 않으면 판단 불가', () => {
  const { reviews: [review], reviewComments } = findingReview();
  const state = change => [stateComment({ has_any_findings: true, has_unresolved_findings: true, ...change })];
  const cases = [
    [{ comments: state(), reviews: [bodyWith(review, ['추가로 확인이 필요한 부분이 있습니다.'])], reviewComments }, '알 수 없는 본문'],
    [{ comments: state(), reviews: [{ ...review, body: review.body.replace(/`[0-9a-f]{10}`/, '`0000000000`') }], reviewComments }, '다른 커밋 본문'],
    [{ comments: state({ has_any_findings: false, has_unresolved_findings: false }), reviews: [bodyWith(review, [titledBadge('P1', '본문 지적')])], reviewComments: [] }, '지적 없음인데 본문 지적'],
  ];
  for (const [input, label] of cases) assert.equal(codexFor(input).status, 'indeterminate', label);
  // 실제 안내문만 있는 리뷰 본문은 지적 0건으로 본다.
  assert.equal(codexFor({ comments: state(), ...findingReview() }).status, 'findings');
});

test('리뷰 요청은 head가 처음 보인 시각 이후 요청만 그 head에 연결', () => {
  const H1 = 'a'.repeat(40);
  const request = (id, created_at) => ({ id, body: '@codex review', created_at, user: { id: 102342597, type: 'User' } });
  // H1 리뷰 요청 → H2 push → H2 요청 → 늦게 끝난 H1 요약 갱신. H2 결과는 아직 없다.
  const lateOldHead = { ...stateComment({}, H1), updated_at: '2026-10-27T14:50:00Z' };
  const comments = [request(1, '2026-10-27T14:00:00Z'), request(2, '2026-10-27T14:40:00Z'), lateOldHead];
  const codex = codexFor({ comments });
  assert.equal(codex.status, 'missing');
  const plan = (input, headSeenAt = '2026-10-27T14:30:00Z') => planReviewRequest({ comments: input, codex: codexFor({ comments: input }), maxReviewRequests: 3, headSeenAt });
  assert.equal(plan(comments).allowed, false);
  assert.match(plan(comments).reason, /같은 head.*응답 대기/);
  // 이전 head에 대한 요청만 있으면 새 head 요청은 가능하다.
  assert.equal(plan([request(1, '2026-10-27T14:00:00Z'), lateOldHead]).allowed, true);
  // head가 처음 보인 시각을 모르면 연결 근거가 없으므로 요청하지 않는다.
  assert.equal(plan(comments, null).allowed, false);
  assert.equal(plan([], 'not-a-time').allowed, false);
});

test('미완료·형식 오류·값 누락·세부 결과 누락은 통과로 보지 않음', () => {
  const cases = [
    [{ comments: [stateComment({ status: 'running', has_any_findings: null, has_unresolved_findings: null })] }, 'pending'],
    [{ comments: [stateComment({ status: 'failed' })] }, 'indeterminate'],
    [{ comments: [stateComment({ has_any_findings: null })] }, 'indeterminate'],
    [{ comments: [stateComment({ has_any_findings: 'false' })] }, 'indeterminate'],
    [{ comments: [{ ...real.photoSelectorPr5.reviewSummaryCompleted, body: real.photoSelectorPr5.reviewSummaryCompleted.body.replace('"status":"completed"', '"status":') }] }, 'indeterminate'],
    [{ comments: [stateComment({ has_any_findings: true, has_unresolved_findings: true })] }, 'indeterminate'],
    [{ comments: [stateComment()], ...findingReview() }, 'indeterminate'],
    [{ comments: [real.workyUsageLimit] }, 'limit'],
    [{ comments: [real.photoSelectorPr5.environmentNotice] }, 'missing'],
    [{ comments: [real.photoSelectorPr5.reviewReceipt] }, 'missing'],
    [{ comments: [] }, 'missing'],
  ];
  for (const [input, status] of cases) assert.equal(codexFor(input).status, status, JSON.stringify(input).slice(0, 120));
});

test('봇 위장·잘못된 앱·이전 SHA 결과는 인정하지 않음', () => {
  const genuine = real.photoSelectorPr5.reviewSummaryCompleted;
  const spoofs = [
    { ...genuine, user: { ...genuine.user, type: 'User' } },
    { ...genuine, user: { ...genuine.user, id: 1 } },
    { ...genuine, user: { ...genuine.user, login: 'chatgpt-codex-connector' } },
    { ...genuine, performed_via_github_app: { id: 15368, slug: 'github-actions' } },
    { ...genuine, performed_via_github_app: null },
  ];
  for (const comment of spoofs) {
    const codex = codexFor({ comments: [comment] });
    assert.equal(codex.status, 'missing');
    assert.equal(codex.ignoredUntrusted, 1);
  }
  assert.equal(codexFor({ comments: [stateComment({}, otherHead)] }).status, 'missing');
  // 다른 사람이 쓴 인라인 지적은 봇 리뷰로 집계하지 않는다.
  const { reviews, reviewComments } = findingReview();
  const fake = reviewComments.map(comment => ({ ...comment, user: { ...comment.user, type: 'User', id: 1 } }));
  assert.equal(codexFor({ comments: [stateComment({ has_any_findings: true })], reviews, reviewComments: fake }).status, 'indeterminate');
  // PASS 선언 댓글은 리뷰 결과가 아니다.
  assert.equal(codexFor({ comments: [{ id: 5, user: { id: 102342597, login: 'yoobilee', type: 'User' }, body: 'PASS — Codex 리뷰 지적 없음' }] }).status, 'missing');
});

test('필수 CI 실패·취소·스킵·누락·진행 중·다른 앱은 성공이 아님', () => {
  const run = (id, change) => ({ id, name: 'verify', head_sha: head, status: 'completed', conclusion: 'success', app: { id: 15368 }, ...change });
  const state = runs => evaluateRequiredChecks({ head, checkRuns: runs, requiredChecks: shadow.requiredChecks })[0].state;
  assert.equal(state([run(1)]), 'success');
  for (const conclusion of ['failure', 'cancelled', 'skipped', 'neutral', 'timed_out']) assert.equal(state([run(1, { conclusion })]), conclusion);
  assert.equal(state([]), 'missing');
  assert.equal(state([run(1, { status: 'in_progress', conclusion: null })]), 'pending');
  assert.equal(state([run(1, { app: { id: 999 } })]), 'missing');
  assert.equal(state([run(1, { head_sha: otherHead })]), 'missing');
  assert.equal(state([run(1), run(2, { conclusion: 'failure' })]), 'failure');
  assert.equal(state([run(2, { conclusion: 'failure' }), run(1)]), 'failure');
});

test('관리자 승인은 최신 head 전체 SHA와 fingerprint를 명시하고 변경 이후에 작성돼야 함', () => {
  const fingerprint = 'f'.repeat(64);
  const approval = (body, id = 30, created_at = '2026-10-28T01:00:00Z') => ({ id, body, created_at, user: { id: 102342597, type: 'User' } });
  const find = (comments, confirmers = new Set([30]), lastChangedAt = '2026-10-28T00:00:00Z') => findApproval({ head, fingerprint, comments, confirmers, lastChangedAt }).state;
  const valid = approvalText(head, fingerprint);
  assert.equal(valid, `/merge-approve ${head} ${fingerprint}`);
  assert.equal(find([]), 'none');
  assert.equal(find([approval(valid)]), 'approved');
  assert.equal(find([approval(`${valid}\r\n`)]), 'approved');
  assert.equal(find([approval(approvalText(otherHead, fingerprint))]), 'invalid');
  // 본문·제목·base·파일·정책이 바뀌면 fingerprint가 달라져 이전 승인이 무효다.
  assert.equal(find([approval(approvalText(head, '0'.repeat(64)))]), 'invalid');
  // 이전 Shadow 형식(짧은 SHA만)과 SHA만 있는 승인은 더 이상 인정하지 않는다.
  assert.equal(find([approval(`/merge-approve ${head.slice(0, 7)}`)]), 'invalid');
  assert.equal(find([approval(`/merge-approve ${head}`)]), 'invalid');
  assert.equal(find([approval(valid)], new Set()), 'invalid');
  assert.equal(find([approval(valid, 30, '2026-10-27T23:59:59Z')]), 'invalid');
  assert.equal(find([approval(valid)], new Set([30]), 'unknown'), 'indeterminate');
  assert.equal(find([approval(valid)], new Set([30]), null), 'approved');
  assert.equal(find([approval('PASS 승인합니다')]), 'none');
  assert.equal(find([approval(`/review-gate\n${valid}`)]), 'none');
});

test('같은 head 중복 요청·대기 중 요청·상한 초과·한도 초과면 새 요청 불가', () => {
  const request = (id, created_at) => ({ id, body: '@codex review', created_at, user: { id: 102342597, type: 'User' } });
  const plan = (comments, codexStatus) => planReviewRequest({ comments, codex: { status: codexStatus }, maxReviewRequests: 3, headSeenAt: '2026-10-27T13:00:00Z' });
  assert.equal(plan([], 'missing').allowed, true);
  assert.equal(plan([request(1, '2026-10-27T14:00:00Z'), real.photoSelectorPr5.reviewSummaryCompleted], 'clean').allowed, false);
  assert.equal(plan([request(1, '2026-10-27T14:00:00Z'), request(2, '2026-10-27T14:10:00Z'), request(3, '2026-10-27T14:20:00Z')], 'missing').reason, 'PR당 요청 상한 3회 도달');
  assert.equal(plan([real.photoSelectorPr5.reviewSummaryCompleted, request(99, '2026-10-27T15:00:00Z')], 'missing').reason, '같은 head에 대한 요청이 응답 대기 중');
  assert.equal(plan([real.workyUsageLimit], 'limit').allowed, false);
  assert.equal(plan([{ ...request(1, '2026-10-27T14:00:00Z'), body: '@codex review this please' }], 'missing').requestCount, 0);
});

test('위험도별 자동 판정 후보 조건', () => {
  const pass = [{ name: 'verify', state: 'success' }];
  const clean = { status: 'clean', findings: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 } };
  const withFindings = findings => ({ status: 'findings', findings: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0, ...findings } });
  const decide = (change = {}) => decideShadow({ risk: 'medium', meta: meta(), checks: pass, codex: clean, approval: { state: 'none' }, blocked: false, request: { requestCount: 1 }, maxReviewRequests: 3, baseSync: 'current', ...change });
  // main이 앞서 나가면 head가 같아도 이전 검증·승인을 최신 base 기준으로 볼 수 없다.
  for (const baseSync of ['behind', 'unknown']) {
    for (const risk of ['low', 'medium']) assert.equal(decide({ risk, baseSync }).candidate, false, `${risk} ${baseSync}`);
    assert.equal(decide({ risk: 'high', approval: { state: 'approved' }, baseSync }).candidate, false, baseSync);
    assert.match(decide({ baseSync }).blockers.join(), /최신 base/);
  }
  assert.equal(decide({ risk: 'low', codex: { status: 'missing', reason: '없음' } }).candidate, true);
  assert.equal(decide({ risk: 'low', checks: [{ name: 'verify', state: 'failure' }] }).candidate, false);
  assert.equal(decide().candidate, true);
  assert.equal(decide({ codex: withFindings({ low: 2 }) }).candidate, true);
  for (const findings of [{ critical: 1 }, { high: 1 }, { medium: 1 }, { unknown: 1 }]) assert.equal(decide({ codex: withFindings(findings) }).candidate, false, JSON.stringify(findings));
  for (const status of ['pending', 'missing', 'limit', 'indeterminate']) assert.equal(decide({ codex: { status, reason: status } }).candidate, false, status);
  for (const state of ['missing', 'pending', 'cancelled', 'skipped']) assert.equal(decide({ checks: [{ name: 'verify', state }] }).candidate, false, state);
  assert.equal(decide({ blocked: true }).candidate, false);
  assert.equal(decide({ meta: meta('medium', 'no', 'unknown') }).candidate, false);
  assert.equal(decide({ request: { requestCount: 4 } }).candidate, false);
  assert.equal(decide({ risk: 'high' }).candidate, false);
  assert.match(decide({ risk: 'high' }).blockers.join(), /사용자 승인/);
  assert.equal(decide({ risk: 'high', approval: { state: 'approved' } }).candidate, true);
  assert.equal(compareWithGate({ candidate: true }, { state: 'failure' }), '차이: 기존 게이트 실패, Shadow 후보');
  assert.equal(compareWithGate({ candidate: false }, { state: 'failure' }), '일치');
});

// GitHub API를 호출하지 않는 runGate 통합 실행. 기존 게이트 확인 댓글과 Codex 응답을 함께 둔다.
const admin = { id: 102342597, login: 'yoobilee', type: 'User' };
const gateMetadata = '<!-- ai-review\nimplemented-by: claude\nrisk: high\nsensitive-change: yes\n-->';
// 해당 본문의 PR 상태(fingerprint)에 대한 High 병합 승인 댓글.
const approveFor = (body = gateMetadata, created_at = '2026-10-27T16:00:00Z') => {
  const files = [{ filename: '.github/scripts/review-gate.mjs', status: 'modified' }];
  const { fingerprint } = describePR({ title: 'fix: 권한 확인 누락 수정', body, head: { sha: head }, base: { sha: 'b'.repeat(40) } }, files, config);
  return { id: 50, user: admin, body: approvalText(head, fingerprint), created_at };
};
async function runWithShadow({ lineEnding = '\n', reverse = false, failReviewComments = false, extraComments = [], body, lastEditedAt = null, checkRuns, behindBy = 0 } = {}) {
  const metadata = '<!-- ai-review\nimplemented-by: claude\nrisk: high\nsensitive-change: yes\n-->';
  const pr = { number: 7, title: 'fix: 권한 확인 누락 수정', body: body ?? metadata, state: 'open', changed_files: 1, head: { sha: head }, base: { sha: 'b'.repeat(40) } };
  const files = [{ filename: '.github/scripts/review-gate.mjs', status: 'modified' }];
  // 관리자 확인은 항상 원래 본문 기준으로 작성된 것으로 둔다. 본문이 바뀌면 fingerprint가 달라져야 한다.
  const d = describePR({ ...pr, body: metadata }, files, config);
  const report = `# 독립 리뷰 보고서\nHEAD: ${d.head}\nBASE: ${d.base}\n완료`.replace(/\n/g, lineEnding);
  const confirmation = { fingerprint: d.fingerprint, decision: 'pass', reviewer: 'codex', reviewComplete: true, evidence: 'https://github.com/owner/repo/pull/7#issuecomment-10', evidenceHash: sha256(report.replace(/\r\n?/g, '\n')), findings: { critical: 0, high: 0, medium: 0, low: 0 } };
  let comments = [
    { id: 10, user: admin, body: report, created_at: '2026-10-27T15:00:00Z' },
    { id: 11, user: admin, body: `/review-gate\n\`\`\`json\n${JSON.stringify(confirmation)}\n\`\`\``.replace(/\n/g, lineEnding), created_at: '2026-10-27T15:01:00Z' },
    { id: 6444483731, user: admin, body: '@codex review', created_at: '2026-10-27T14:21:52Z' },
    real.photoSelectorPr5.reviewSummaryCompleted, real.photoSelectorPr5.reviewReceipt, ...extraComments,
  ];
  if (reverse) comments = [...comments].reverse();
  const current = { ...pr, comments: comments.length, review_comments: 0 };
  const calls = [];
  const summary = [];
  let failed = false;
  const github = {
    rest: {
      pulls: {
        list: async () => ({ data: [current] }), get: async () => ({ data: current }),
        listFiles: async () => ({ data: files }), listReviews: async () => ({ data: [] }),
        listReviewComments: async () => { if (failReviewComments) throw new Error('sensitive raw response'); return { data: [] }; },
      },
      issues: { listComments: async () => ({ data: comments }) },
      repos: {
        getCollaboratorPermissionLevel: async () => ({ data: { permission: 'admin' } }),
        compareCommitsWithBasehead: async ({ basehead }) => {
          if (behindBy === 'error') throw new Error('sensitive raw response');
          assert.equal(basehead, `${'b'.repeat(40)}...${head}`);
          return { data: { behind_by: behindBy } };
        },
      },
      checks: {
        create: async value => { calls.push(['create', value.name]); return { data: { id: 99 } }; },
        update: async value => { calls.push(['update', value.conclusion]); },
        listForRef: async () => ({ data: checkRuns ?? [{ id: 1, name: 'verify', head_sha: head, status: 'completed', conclusion: 'success', app: { id: 15368 } }] }),
        // PR #5 head가 push된 직후 생긴 check suite 시각(요청 14:21:52Z보다 이전).
        listSuitesForRef: async () => ({ data: [{ id: 2, head_sha: head, created_at: '2026-10-27T14:19:40Z' }, { id: 3, head_sha: head, created_at: '2026-10-27T14:20:00Z' }] }),
      },
    },
    graphql: async () => ({ repository: { pullRequest: { lastEditedAt, timelineItems: { nodes: [] } } } }),
    paginate: async (fn, args) => (await fn(args)).data,
  };
  const core = { summary: { addHeading() { return this; }, addRaw(text) { summary.push(text); return this; }, addCodeBlock() { return this; }, async write() {} }, setFailed() { failed = true; } };
  // 기존 게이트는 저장소의 실제 설정 파일을 읽으므로 shadow 설정 변형은 별도 평가로 확인한다.
  await runGate({ github, context: { repo: { owner: 'owner', repo: 'repo' }, payload: { pull_request: { number: 7 } }, eventName: 'pull_request_target', runId: 42 }, core });
  return { calls, failed, summary: summary.join('') };
}

test('Shadow 판정은 Summary에만 기록되고 기존 check 호출과 결론을 바꾸지 않음', async () => {
  const r = await runWithShadow({ extraComments: [approveFor()] });
  assert.deepEqual(r.calls, [['create', 'independent-review'], ['update', 'success']]);
  assert.equal(r.failed, false);
  assert.match(r.summary, /Shadow 판정 PR #7 \(관찰용, 병합에 영향 없음\)/);
  assert.match(r.summary, /위험도: high/);
  assert.match(r.summary, /Codex GitHub 리뷰: clean/);
  assert.match(r.summary, /사용자 승인: approved/);
  assert.match(r.summary, /자동 판정 후보\(high\): 예/);
  assert.match(r.summary, /기존 게이트 비교: 일치/);
});

test('High는 기존 /review-gate 확인만으로 병합 승인되지 않고 Summary에 승인 명령을 보여 줌', async () => {
  const r = await runWithShadow();
  assert.deepEqual(r.calls, [['create', 'independent-review'], ['update', 'success']]);
  assert.match(r.summary, /사용자 승인: none/);
  assert.match(r.summary, /자동 판정 후보\(high\): 아니오 — .*사용자 승인/);
  assert.match(r.summary, /차이: 기존 게이트 통과, Shadow 후보 아님/);
  assert.ok(r.summary.includes(`승인 명령(High, 변경을 확인한 관리자가 직접 작성): \`${approveFor().body}\``));
});

test('Shadow 조회 오류는 판단 불가로 기록하고 기존 성공 check를 유지', async () => {
  const r = await runWithShadow({ failReviewComments: true });
  assert.deepEqual(r.calls, [['create', 'independent-review'], ['update', 'success']]);
  assert.equal(r.failed, false);
  assert.match(r.summary, /판단 불가: 조회·형식·설정 오류/);
  assert.doesNotMatch(r.summary, /sensitive raw response/);
});

test('필수 CI 실패는 Shadow 후보에서 제외하지만 기존 게이트 판정은 그대로', async () => {
  const r = await runWithShadow({ checkRuns: [{ id: 1, name: 'verify', head_sha: head, status: 'completed', conclusion: 'failure', app: { id: 15368 } }] });
  assert.deepEqual(r.calls, [['create', 'independent-review'], ['update', 'success']]);
  assert.match(r.summary, /자동 판정 후보\(high\): 아니오 — 필수 CI verify: failure/);
  assert.match(r.summary, /차이: 기존 게이트 통과, Shadow 후보 아님/);
});

test('중복·역순 이벤트에도 같은 상태면 같은 Shadow 결과', async () => {
  const first = await runWithShadow();
  const again = await runWithShadow();
  const reversed = await runWithShadow({ reverse: true });
  assert.equal(again.summary, first.summary);
  assert.equal(reversed.summary, first.summary);
});

test('CRLF 보고서와 확인 댓글도 기존 게이트와 Shadow가 함께 동작', async () => {
  const r = await runWithShadow({ lineEnding: '\r\n', extraComments: [approveFor()] });
  assert.deepEqual(r.calls, [['create', 'independent-review'], ['update', 'success']]);
  assert.match(r.summary, /자동 판정 후보\(high\): 예/);
});

test('PR 본문 변경은 fingerprint를 바꾸고 기존 확인을 무효화', async () => {
  const before = await runWithShadow();
  const metadata = '<!-- ai-review\nimplemented-by: claude\nrisk: high\nsensitive-change: yes\n-->';
  const after = await runWithShadow({ body: `${metadata}\n수정된 설명` });
  const fingerprint = text => /기준 fingerprint: ([a-f0-9]{64})/.exec(text)?.[1];
  assert.notEqual(fingerprint(after.summary), fingerprint(before.summary));
  assert.deepEqual(after.calls, [['create', 'independent-review'], ['update', 'failure']]);
  assert.match(after.summary, /사용자 승인: none/);
});

test('Shadow 승인 댓글이 기존 관리자 확인보다 새로워도 기존 게이트 성공을 바꾸지 않음', async () => {
  const r = await runWithShadow({ extraComments: [approveFor()] });
  assert.deepEqual(r.calls, [['create', 'independent-review'], ['update', 'success']]);
});

test('완료 상태의 두 지적 값이 누락·모순이면 판단 불가', () => {
  for (const change of [{ has_any_findings: false, has_unresolved_findings: null }, { has_any_findings: false, has_unresolved_findings: true }]) {
    assert.equal(codexFor({ comments: [stateComment(change)] }).status, 'indeterminate', JSON.stringify(change));
  }
  assert.equal(codexFor({ comments: [stateComment({ has_any_findings: true, has_unresolved_findings: null })], ...findingReview() }).status, 'indeterminate');
  assert.equal(codexFor({ comments: [stateComment({ has_any_findings: true, has_unresolved_findings: false })], ...findingReview() }).status, 'findings');
});

test('Codex 구현 PR은 Codex GitHub 리뷰를 독립 리뷰로 인정하지 않음', () => {
  const clean = { status: 'clean', findings: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 } };
  const decide = (agent, risk) => decideShadow({ risk, meta: meta('medium', 'no', agent), checks: [{ name: 'verify', state: 'success' }], codex: clean, approval: { state: 'approved' }, blocked: false, request: { requestCount: 1 }, maxReviewRequests: 3, baseSync: 'current' });
  for (const risk of ['medium', 'high']) {
    assert.equal(decide('codex', risk).candidate, false, risk);
    assert.match(decide('codex', risk).blockers.join(), /독립/);
    assert.equal(decide('claude', risk).candidate, true, risk);
    assert.equal(decide('human', risk).candidate, true, risk);
  }
});

test('본문 수정 이전의 승인 댓글은 무효이고 이후 승인은 유효', async () => {
  const body = `${gateMetadata}\n수정`;
  // 본문이 바뀌어 기존 확인은 실패하므로 승인 댓글만으로 판단한다.
  const before = await runWithShadow({ body, extraComments: [approveFor()], lastEditedAt: '2026-10-27T15:30:00Z' });
  assert.match(before.summary, /사용자 승인: invalid/, '수정 전 본문의 fingerprint로 쓴 승인');
  const stale = await runWithShadow({ body, extraComments: [approveFor(body)], lastEditedAt: '2026-10-27T16:30:00Z' });
  assert.match(stale.summary, /사용자 승인: invalid/);
  const fresh = await runWithShadow({ body, extraComments: [approveFor(body)], lastEditedAt: '2026-10-27T15:30:00Z' });
  assert.match(fresh.summary, /사용자 승인: approved/);
  assert.match(fresh.summary, /차이: 기존 게이트 실패, Shadow 후보/);
});

test('main이 앞서 나간 PR은 이전 승인이 있어도 후보가 아니고 기존 판정은 그대로', async () => {
  for (const behindBy of [1, 'error']) {
    const r = await runWithShadow({ extraComments: [approveFor()], behindBy });
    assert.deepEqual(r.calls, [['create', 'independent-review'], ['update', 'success']], String(behindBy));
    assert.match(r.summary, /자동 판정 후보\(high\): 아니오 — .*최신 base/, String(behindBy));
    assert.doesNotMatch(r.summary, /sensitive raw response/);
  }
  assert.match((await runWithShadow({ behindBy: 1 })).summary, /최신 base 반영: behind/);
});

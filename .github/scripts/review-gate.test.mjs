import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validTitle, parseMetadata, describe, decide, sha256, parseConfirmation, blockingReviews, normalizeNewlines, reportHash, assertPullRequestUnchanged, pullRequestSnapshot, gateEvidence } from './review-gate-core.mjs';
import { runGate } from './review-gate.mjs';
import { verifyGateSource } from './review-gate-source.mjs';

const config = JSON.parse(readFileSync(new URL('../../.ai/review-config.json', import.meta.url)));
const metadata = (agent = 'claude', risk = 'high', sensitive = 'yes') => `<!-- ai-review\nimplemented-by: ${agent}\nrisk: ${risk}\nsensitive-change: ${sensitive}\n-->`;
// 실제 PR API 응답처럼 draft·ref·저장소를 갖춘다. 공용 PR 변경 감지 함수는 값이 하나라도 없으면 실패한다.
const side = (sha, ref) => ({ sha, ref, repo: { full_name: 'owner/repo' } });
const pr = (body = metadata()) => ({ number: 1, title: 'fix: 권한 확인 누락 수정', body, state: 'open', draft: false, changed_files: 1, head: side('a'.repeat(40), 'fix/auth'), base: side('b'.repeat(40), 'main') });
const files = [{ filename: 'src/auth.ts', status: 'modified' }];
const reportFor = d => `# 독립 리뷰 보고서\nHEAD: ${d.head}\nBASE: ${d.base}\n독립 리뷰 완료. 인증 경계를 확인했습니다.`;
const confirmationFor = d => ({ fingerprint: d.fingerprint, decision: 'pass', reviewer: d.reviewer, reviewComplete: true, evidence: 'https://github.com/owner/repo/pull/1#issuecomment-10', evidenceHash: sha256(reportFor(d)), findings: { critical: 0, high: 0, medium: 0, low: 0 } });
const data = () => {
  const d = describe(pr(), files, config);
  return { d, c: confirmationFor(d), e: { body: reportFor(d), hash: sha256(reportFor(d)) } };
};

test('GitHub 기본 제목과 깨진 제목을 거부하고 한국어 Conventional Commit을 허용', () => {
  for (const title of ['Merge pull request #1', 'fix: only English', 'fix: 한글\uFFFD', 'feat: 기능\n명령']) assert.equal(validTitle(title), false);
  assert.equal(validTitle('fix(auth)!: 인증 경계 수정'), true);
});

test('누락·중복·알 수 없는 metadata는 fail-closed', () => {
  for (const body of ['', metadata() + metadata(), metadata().replace('risk: high', 'risk: high\nrisk: low'), metadata('bot'), metadata().replace('sensitive-change: yes', 'sensitive-change: false')]) {
    assert.throws(() => parseMetadata(body));
  }
});

test('low 입력도 workflow 변경·이전 경로·민감 변경·의존성 변경은 생략 불가', () => {
  for (const changed of [ [{filename: '.github/workflows/check.yml'}], [{filename: 'moved.yml', previous_filename: '.github/workflows/check.yml'}], [{filename: 'package.json'}] ]) {
    assert.equal(describe(pr(metadata('claude', 'low', 'no')), changed, config).needsReview, true);
  }
  assert.equal(describe(pr(metadata('claude', 'low', 'yes')), files, config).needsReview, true);
});

test('중간 위험은 기본 검증, 정책 선택 시 비민감 범위에만 생략 가능', () => {
  assert.equal(describe(pr(metadata('human', 'medium', 'no')), files, config).needsReview, true);
  assert.equal(describe(pr(metadata('human', 'medium', 'no')), files, {...config, reviewAllMedium: false}).needsReview, false);
});

test('구현자 교차 및 불명확한 구현자 차단', () => {
  assert.equal(describe(pr(metadata('codex')), files, config).reviewer, 'claude');
  const d = describe(pr(metadata('unknown')), files, config);
  assert.equal(decide(d, confirmationFor(d), {body: reportFor(d), hash: sha256(reportFor(d))}).state, 'failure');
});

test('head/base/위험도/제목/설정 변경은 과거 확인을 무효화', () => {
  const {d, c, e} = data();
  const variations = [
    {...pr(), head:{sha:'c'.repeat(40)}}, {...pr(), base:{sha:'c'.repeat(40)}},
    {...pr(), title:'fix: 권한 회귀 수정'}, pr(metadata('codex')),
    {...pr(), body:metadata()+'\nCloses #77'},
  ];
  for (const p of variations) assert.equal(decide(describe(p, files, config), c, e).state, 'failure');
  assert.notEqual(describe(pr(), files, {...config, reviewAllMedium:false}).fingerprint, d.fingerprint);
});

test('자기 리뷰·미완료·잘못된 집계·차단 지적·근거 변경을 통과시키지 않음', () => {
  const {d, c, e} = data();
  for (const change of [{reviewer:'claude'}, {reviewComplete:false}, {reviewComplete:'true'}, {findings:{critical:0,high:0,medium:0}}, {findings:{...c.findings,high:1}}, {findings:{...c.findings,medium:1}}, {findings:{...c.findings,low:-1}}, {evidenceHash:'bad'}]) {
    assert.equal(decide(d, {...c,...change}, e).state, 'failure');
  }
  assert.equal(decide(d, c, null).state, 'failure');
  assert.equal(decide(d, c, {...e, body:'이전 보고서'}).state, 'failure');
  assert.equal(decide(d, {...c, findings:{...c.findings,low:2}}, e).state, 'success');
});

test('low도 사람 확인·실제 생략 근거 필요', () => {
  const d = describe(pr(metadata('human','low','no')), files, config);
  assert.equal(decide(d, null).state, 'failure');
  assert.equal(decide(d, {fingerprint:d.fingerprint,decision:'skip',reason:''}).state, 'failure');
  assert.equal(decide(d, {fingerprint:d.fingerprint,decision:'skip',reason:'문구만 변경'}).state, 'success');
});

test('잘못된 JSON과 문자열 PASS를 확인으로 인정하지 않음', () => {
  for (const body of ['PASS','/review-gate\n```json\n{bad}\n```','/review-gate\n```json\n[]\n```']) assert.equal(parseConfirmation(body), null);
});

const withLineEnding = (text, ending) => text.replace(/\n/g, ending);

test('CRLF·단독 CR 줄바꿈을 LF로 정규화하고 LF 입력은 그대로 둠', () => {
  assert.equal(normalizeNewlines('a\r\nb\rc\nd'), 'a\nb\nc\nd');
  assert.equal(normalizeNewlines('a\r\r\nb'), 'a\n\nb');
  const lf = '# 독립 리뷰 보고서\n본문\n';
  assert.equal(normalizeNewlines(lf), lf);
  // 기존 LF 보고서로 작성한 확인 댓글의 해시가 그대로 유효해야 한다.
  assert.equal(reportHash(lf), sha256(lf));
  assert.equal(normalizeNewlines(undefined), '');
});

test('CRLF·CR 보고서도 LF 보고서와 같은 해시로 통과하고 내용 변경은 차단', () => {
  const {d, c} = data();
  for (const ending of ['\n', '\r\n', '\r']) {
    const body = withLineEnding(reportFor(d), ending);
    assert.equal(reportHash(body), c.evidenceHash, JSON.stringify(ending));
    assert.equal(decide(d, c, {body, hash: reportHash(body)}).state, 'success', JSON.stringify(ending));
    const tampered = body.replace('인증 경계', '권한 경계');
    assert.equal(decide(d, c, {body: tampered, hash: reportHash(tampered)}).state, 'failure', JSON.stringify(ending));
  }
});

test('CRLF·CR 확인 댓글도 같은 내용으로 해석', () => {
  const {c} = data();
  const lf = `/review-gate\n\`\`\`json\n${JSON.stringify(c)}\n\`\`\``;
  for (const ending of ['\r\n', '\r']) assert.deepEqual(parseConfirmation(withLineEnding(lf, ending)), c);
});

async function integration({permission='admin', role_name, type='User', changed=false, partial=false, malformed=false, reviews=[], apiFailure=false, mutateEvidence=false, duplicate=false, peerPermission='write', newestInvalid=false, otherEvidence=false, noPR=false, push=false, lineEnding='\n', reportPrefix='', extraComments=[]}={}) {
  const current = pr();
  const d = describe(current, files, config);
  const c = confirmationFor(d);
  if (otherEvidence) c.evidence=c.evidence.replace('/pull/1#','/pull/2#');
  const statuses = [];
  const summaryLines = [];
  const users = {login:'maintainer',id:1,type};
  // 실제 GitHub 댓글처럼 작성·수정 시각을 둔다. 게이트 근거(gateEvidence)는 시각이 없으면 실패한다.
  const at = {created_at:'2026-10-27T15:00:00Z',updated_at:'2026-10-27T15:00:00Z'};
  const comments = [
    {id:10,user:users,...at,body:withLineEnding(reportPrefix+reportFor(d)+(mutateEvidence?'변경':''),lineEnding)},
    {id:11,user:users,...at,body:withLineEnding(malformed?'/review-gate\n```json\n{bad}\n```':`/review-gate\n\`\`\`json\n${JSON.stringify(c)}\n\`\`\``,lineEnding)},
  ];
  comments.push(...extraComments);
  if (newestInvalid) comments.push({id:12,user:users,...at,body:'/review-gate\n```json\n{invalid}\n```'});
  let gets=0;
  const github = {
    rest:{
      pulls:{list:async()=>({data:duplicate?[current,{...current,number:2}]:[current]}),get:async()=>({data:changed && ++gets>1?{...current,head:{...current.head,sha:'c'.repeat(40)}}:current}),listFiles:async()=>({data:partial?[]:files}),listReviews:async()=>({data:reviews})},
      issues:{listComments:async()=>{if(apiFailure)throw new Error('sensitive response');return {data:comments};}},
      repos:{getCollaboratorPermissionLevel:async args=>({data:args.username==='peer'?{permission:peerPermission}:{permission,role_name}})},
      checks:{create:async()=>({data:{id:99}}),update:async value=>{statuses.push({...value,state:value.conclusion});}},
    },
    paginate:async(fn,args)=>(await fn(args)).data,
  };
  const summary = {addHeading(){return this;},addRaw(text){summaryLines.push(text);return this;},addCodeBlock(){return this;},async write(){}};
  let failure=false;
  await runGate({github,context:{repo:{owner:'owner',repo:'repo'},payload:noPR?{issue:{number:9}}:push?{}:{pull_request:{number:1}},eventName:push?'push':'pull_request_target',runId:42},core:{summary,setFailed(){failure=true;}}});
  return {statuses,failure,summary:summaryLines.join(''),evidenceHash:c.evidenceHash};
}

test('CRLF·CR 관리자 보고서를 Summary에 출력하고 확인 댓글로 통과', async()=>{
  for (const lineEnding of ['\r\n', '\r']) {
    const r=await integration({lineEnding});
    assert.equal(r.statuses.at(-1).state,'success',JSON.stringify(lineEnding));
    assert.match(r.summary,/보고서 댓글 ID: 10/);
    assert.ok(r.summary.includes(`보고서 SHA-256: ${r.evidenceHash}`));
  }
});

test('CRLF 보고서도 권한 없음·봇·내용 변경·첫 줄 불일치는 차단', async()=>{
  for (const options of [{permission:'write'},{type:'Bot'},{mutateEvidence:true},{reportPrefix:'참고\n'}]) {
    const r=await integration({...options,lineEnding:'\r\n'});
    assert.equal(r.statuses.at(-1).state,'failure',JSON.stringify(options));
    // 내용이 바뀐 관리자 보고서는 보고서로 표시되지만 확인 댓글의 해시와 달라 실패한다.
    if (options.mutateEvidence) assert.doesNotMatch(r.summary,new RegExp(`보고서 SHA-256: ${r.evidenceHash}`));
    else assert.doesNotMatch(r.summary,/보고서 댓글 ID/,JSON.stringify(options));
  }
});

test('API 경로에서 정상 관리자 확인만 성공', async()=>{
  const r=await integration();assert.equal(r.statuses.at(-1).state,'success');assert.equal(r.failure,false);
});

test('권한 없음·봇·잘못된 확인·부분 조회·API 실패·동시 변경·근거 변경 차단', async()=>{
  for (const options of [{permission:'write'},{type:'Bot'},{malformed:true},{partial:true},{apiFailure:true},{changed:true},{mutateEvidence:true},{duplicate:true}]) {
    const r=await integration(options);assert.equal(r.statuses.at(-1).state,'failure',JSON.stringify(options));
  }
});

test('현재 SHA의 변경 요청을 확인 댓글로 덮어쓰지 않음', async()=>{
  const r=await integration({reviews:[{commit_id:'a'.repeat(40),state:'CHANGES_REQUESTED',user:{id:2}}]});
  assert.equal(r.statuses.at(-1).state,'failure');
});

test('변경 요청 뒤 COMMENTED, 이전 SHA 요청은 차단하고 승인·기각은 반영',()=>{
  const user={id:2};
  const request={id:1,user,state:'CHANGES_REQUESTED',commit_id:'old'};
  assert.equal(blockingReviews([request,{id:2,user,state:'COMMENTED'}]).length,1);
  assert.equal(blockingReviews([request,{id:2,user,state:'APPROVED'}]).length,0);
  assert.equal(blockingReviews([{...request,state:'DISMISSED'}]).length,0);
});

test('실제 API 평가에서도 이전 SHA 요청과 후속 댓글은 해제되지 않음',async()=>{
  const user={id:2,login:'peer',type:'User'};
  const reviews=[{id:1,user,state:'CHANGES_REQUESTED',commit_id:'old'},{id:2,user,state:'COMMENTED',commit_id:'a'.repeat(40)}];
  assert.equal((await integration({reviews})).statuses.at(-1).state,'failure');
  assert.equal((await integration({reviews,peerPermission:'read'})).statuses.at(-1).state,'success');
});

test('maintain은 허용하고 최신 잘못된 확인·다른 PR 근거는 거부',async()=>{
  assert.equal((await integration({permission:'write',role_name:'maintain'})).statuses.at(-1).state,'success');
  for (const options of [{newestInvalid:true},{otherEvidence:true}]) assert.equal((await integration(options)).statuses.at(-1).state,'failure');
});

test('일반 이슈 댓글은 무시하고 기본 브랜치 push는 열린 PR 평가',async()=>{
  assert.equal((await integration({noPR:true})).statuses.length,0);
  assert.equal((await integration({push:true})).statuses.at(-1).state,'success');
});

test('프롬프트·체크리스트·내부 액션은 고위험이고 block.ts는 의존성이 아님',()=>{
  const p=pr(metadata('human','low','no'));
  for (const filename of ['.ai/prompts/review.md','.ai/checklists/start.md','.ai/templates/run.md','.github/actions/custom/action.yml','.github/CODEOWNERS','.github/pull_request_template.md']) {
    assert.equal(describe(p,[{filename}],config).risk,'high');
  }
  assert.equal(describe(p,[{filename:'src/block.ts'}],config).needsReview,false);
});

// 정상 PR을 실패 PR 앞뒤에 배치해 판정과 후속 처리가 모두 격리되는지 확인한다.
async function multiplePRs({invalid='draft',cleanupFailure=false,createFailure=false}={}) {
  const prs=[1,2,3].map(number=>({...pr(),number,head:side(String(number).repeat(40),`fix/pr-${number}`)}));
  if (invalid==='draft') prs[1].draft=true;
  if (invalid==='title') prs[1].title='chore: automated dependency update';
  if (invalid==='metadata') prs[1].body='metadata 없음';
  const checks=new Map();
  const evaluated=[];
  let failure=false;
  let summaryWritten=false;
  const github={rest:{
    pulls:{
      list:async()=>({data:prs}),
      get:async args=>({data:prs.find(p=>p.number===args.pull_number)}),
      listFiles:async args=>{evaluated.push(args.pull_number);return {data:files};},
      listReviews:async()=>({data:[]}),
    },
    issues:{listComments:async args=>{
      const p=prs.find(p=>p.number===args.issue_number);
      const d=describe(p,files,config);
      const c={...confirmationFor(d),evidence:`https://github.com/owner/repo/pull/${p.number}#issuecomment-10`};
      const user={id:1,login:'maintainer',type:'User'};
      const at={created_at:'2026-10-27T15:00:00Z',updated_at:'2026-10-27T15:00:00Z'};
      return {data:[{id:10,user,...at,body:reportFor(d)},{id:11,user,...at,body:`/review-gate\n\`\`\`json\n${JSON.stringify(c)}\n\`\`\``}]};
    }},
    repos:{getCollaboratorPermissionLevel:async()=>({data:{permission:'admin'}})},
    checks:{
      create:async value=>{
        const p=prs.find(p=>p.head.sha===value.head_sha);
        if (p.number===2 && createFailure) throw new Error('check 생성 실패');
        checks.set(p.number,{...value,id:p.number});return {data:{id:p.number}};
      },
      update:async value=>{
        if (value.check_run_id===2 && cleanupFailure && value.conclusion==='failure') throw new Error('실패 check 게시 실패');
        checks.set(value.check_run_id,{...checks.get(value.check_run_id),...value});
      },
    },
  },paginate:async(fn,args)=>(await fn(args)).data};
  const summary={addHeading(){return this;},addRaw(){return this;},addCodeBlock(){return this;},async write(){summaryWritten=true;}};
  await runGate({github,context:{repo:{owner:'owner',repo:'repo'},payload:{},eventName:'push',runId:42},core:{summary,setFailed(){failure=true;}}});
  return {checks,failure,summaryWritten,evaluated};
}

test('정상 PR과 draft·영문 제목·metadata 없는 PR이 공존해도 정상 PR은 통과',async()=>{
  for (const invalid of ['draft','title','metadata']) {
    const r=await multiplePRs({invalid});
    assert.equal(r.checks.get(1).conclusion,'success',invalid);
    assert.equal(r.checks.get(2).conclusion,'failure',invalid);
    assert.equal(r.checks.get(3).conclusion,'success',invalid);
    assert.equal(r.failure,false,invalid);
    assert.equal(r.summaryWritten,true);
  }
});

test('실패 check 게시 오류에도 이후 PR과 Summary를 처리하고 실행 오류를 보고',async()=>{
  const r=await multiplePRs({cleanupFailure:true});
  assert.equal(r.checks.get(1).conclusion,'success');
  assert.equal(r.checks.get(2).status,'in_progress');
  assert.equal(r.checks.get(2).conclusion,undefined);
  assert.equal(r.checks.get(3).conclusion,'success');
  assert.ok(r.evaluated.includes(3));
  assert.equal(r.summaryWritten,true);
  assert.equal(r.failure,true);
});

test('check 생성 오류도 성공으로 바꾸지 않고 이후 PR 평가를 계속함',async()=>{
  const r=await multiplePRs({createFailure:true});
  assert.equal(r.checks.has(2),false);
  assert.equal(r.checks.get(3).conclusion,'success');
  assert.equal(r.summaryWritten,true);
  assert.equal(r.failure,true);
});

// 게이트·Shadow·병합 도구가 함께 쓰는 PR 변경 감지. 이전 게이트는 base 브랜치·저장소·파일 수를 비교하지 않았다.
test('공용 PR 변경 감지: 판정 근거 값이 바뀌거나 검토 불가 상태면 실패', () => {
  const original = pr();
  assert.deepEqual(assertPullRequestUnchanged(original, structuredClone(original)), pullRequestSnapshot(original));
  // 댓글 수 등 판정 근거가 아닌 값의 변화는 허용한다.
  assertPullRequestUnchanged(original, { ...original, comments: 9, updated_at: '2026-10-28T00:00:00Z' });
  assertPullRequestUnchanged({ ...original, body: null }, { ...original, body: '' });
  const changes = {
    'base SHA': { base: { ...original.base, sha: 'c'.repeat(40) } }, 'base 브랜치': { base: { ...original.base, ref: 'release' } },
    'base 저장소': { base: { ...original.base, repo: { full_name: 'other/repo' } } }, 'head SHA': { head: { ...original.head, sha: 'c'.repeat(40) } },
    'head 브랜치': { head: { ...original.head, ref: 'other' } }, 'head 저장소(fork)': { head: { ...original.head, repo: { full_name: 'someone/fork' } } },
    '제목': { title: 'fix: 바뀐 제목' }, '본문': { body: `${metadata()}\n바뀐 본문` }, 'draft': { draft: true }, 'closed': { state: 'closed' },
    '파일 수': { changed_files: 2 }, 'PR 번호': { number: 2 },
  };
  for (const [label, change] of Object.entries(changes)) assert.throws(() => assertPullRequestUnchanged(original, { ...original, ...change }), /PR 변경/, label);
  // 시작 시점부터 검토 불가 상태면 같은 값이어도 실패한다.
  assert.throws(() => assertPullRequestUnchanged({ ...original, draft: true }, { ...original, draft: true }), /검토 준비 전/);
  // 값이 없으면 비교할 수 없으므로 실패한다(fork 저장소 삭제 등).
  for (const missing of [{ draft: undefined }, { changed_files: undefined }, { head: { ...original.head, repo: null } }, { base: { ...original.base, ref: '' } }, { head: { sha: 'a'.repeat(40) } }, { title: undefined }]) {
    assert.throws(() => assertPullRequestUnchanged(original, { ...original, ...missing }), /누락/, JSON.stringify(missing));
    assert.throws(() => assertPullRequestUnchanged({ ...original, ...missing }, original), /누락/, JSON.stringify(missing));
  }
});

// 게이트 판정 근거(proof v2). 댓글 수가 아니라 근거 댓글·리뷰의 ID·작성자·시각·본문·현재 권한을 고정한다.
const evidenceComment = (id, body, change = {}) => ({ id, body, user: { id: 1, login: 'maintainer', type: 'User' }, created_at: '2026-10-27T15:00:00Z', updated_at: '2026-10-27T15:00:00Z', ...change });

test('근거 digest: 입력 순서와 무관하고 ID·작성자·수정 시각·본문·권한·변경 요청이 바뀌면 달라짐', () => {
  const confirmation = { comment: evidenceComment(11, '/review-gate'), role: 'admin' };
  const report = { comment: evidenceComment(10, '# 독립 리뷰 보고서\n완료'), role: 'admin' };
  const approvals = [{ comment: evidenceComment(40, '/merge-approve a'), role: 'admin' }, { comment: evidenceComment(41, '/merge-approve b'), role: 'maintain' }];
  const blocking = [{ review: { id: 5, user: { id: 2 }, state: 'CHANGES_REQUESTED' }, role: 'read' }];
  const base = gateEvidence({ confirmation, report, approvals, blocking });
  assert.match(base.digest, /^[a-f0-9]{64}$/);
  assert.equal(gateEvidence({ confirmation, report, approvals: [...approvals].reverse(), blocking }).digest, base.digest);
  const variants = {
    '같은 본문 다른 ID': { confirmation: { ...confirmation, comment: { ...confirmation.comment, id: 12 } } },
    '보고서 본문 수정': { report: { ...report, comment: { ...report.comment, body: `${report.comment.body}!` } } },
    '본문 그대로 수정 시각만 변경': { report: { ...report, comment: { ...report.comment, updated_at: '2026-10-28T00:00:00Z' } } },
    '확인자 권한 변경': { confirmation: { ...confirmation, role: 'write' } },
    '작성자 변경': { confirmation: { ...confirmation, comment: { ...confirmation.comment, user: { id: 3, login: 'other', type: 'User' } } } },
    '보고서 삭제': { report: null },
    '승인 삭제': { approvals: approvals.slice(1) },
    '변경 요청자 권한 변경': { blocking: [{ ...blocking[0], role: 'write' }] },
    '변경 요청 추가': { blocking: [...blocking, { review: { id: 6, user: { id: 4 }, state: 'CHANGES_REQUESTED' }, role: 'write' }] },
  };
  for (const [label, change] of Object.entries(variants)) {
    assert.notEqual(gateEvidence({ confirmation, report, approvals, blocking, ...change }).digest, base.digest, label);
  }
  // 값이 없으면 같은지 비교할 수 없으므로 실패한다.
  for (const missing of [{ updated_at: undefined }, { created_at: 'x' }, { user: null }, { id: '11' }, { body: undefined }]) {
    assert.throws(() => gateEvidence({ confirmation: { ...confirmation, comment: { ...confirmation.comment, ...missing } } }), /근거 댓글 형식 오류/, JSON.stringify(missing));
  }
  assert.throws(() => gateEvidence({ blocking: [{ review: { id: 5, user: null, state: 'CHANGES_REQUESTED' }, role: 'read' }] }), /근거 리뷰 형식 오류/);
});

test('게이트는 proof v2(fingerprint와 근거 digest)를 기록하고, 무관한 댓글은 digest를 바꾸지 않음', async () => {
  const base = await integration();
  const proof = JSON.parse(base.statuses.at(-1).external_id);
  assert.equal(base.statuses.at(-1).state, 'success');
  assert.equal(proof.v, 2);
  assert.match(proof.evidenceDigest, /^[a-f0-9]{64}$/);
  assert.match(proof.fingerprint, /^[a-f0-9]{64}$/);
  const withBot = await integration({ extraComments: [{ id: 30, user: { id: 9, login: 'chatgpt-codex-connector[bot]', type: 'Bot' }, body: '안내', created_at: '2026-10-27T16:00:00Z', updated_at: '2026-10-27T16:00:00Z' }] });
  assert.equal(JSON.parse(withBot.statuses.at(-1).external_id).evidenceDigest, proof.evidenceDigest);
});

test('게이트 검사 출처 확인: v1 proof와 근거 digest 불일치는 구분된 사유로 거부', async () => {
  const pr = { number: 1, head: { sha: 'a'.repeat(40) } };
  const digest = 'd'.repeat(64);
  const check = proof => ({ id: 99, name: 'independent-review', app: { id: 15368, slug: 'github-actions' }, status: 'completed', conclusion: 'success', head_sha: pr.head.sha,
    external_id: JSON.stringify(proof), details_url: 'https://github.com/owner/repo/actions/runs/42' });
  const api = path => {
    if (path.endsWith('/actions/workflows/independent-review.yml')) return { id: 4, path: '.github/workflows/independent-review.yml' };
    if (path.endsWith('/actions/runs/42')) return { id: 42, workflow_id: 4, path: '.github/workflows/independent-review.yml', status: 'completed', conclusion: 'success', run_attempt: 1, repository: { full_name: 'owner/repo' }, head_repository: { full_name: 'owner/repo' }, event: 'issue_comment', head_sha: 'c'.repeat(40) };
    return { sha: 'workflow-blob' };
  };
  const verify = (proof, evidenceDigest = digest) => verifyGateSource({ check: check(proof), pr, fingerprint: 'f', evidenceDigest, repository: 'owner/repo', defaultBranch: 'main', api });
  const v2 = { v: 2, pr: 1, fingerprint: 'f', evidenceDigest: digest, runId: '42', attempt: '1' };
  assert.deepEqual(await verify(v2), v2);
  await assert.rejects(verify({ pr: 1, fingerprint: 'f', runId: '42', attempt: '1' }), error => error.code === 'proof-v1');
  await assert.rejects(verify(v2, 'e'.repeat(64)), error => error.code === 'evidence-changed');
  // 비교할 digest가 없거나 proof 형식이 다르면 통과시키지 않는다.
  await assert.rejects(verify(v2, null), error => error.code === 'evidence-changed');
  await assert.rejects(verify({ ...v2, v: 3 }), error => error.code === 'source');
  await assert.rejects(verify({ ...v2, evidenceDigest: 'short' }), error => error.code === 'source');
});

// PR #10에서 GitHub가 details_url을 workflow URL 대신 custom check URL로 반환했다.
// workflow는 기본 브랜치에서 실행하므로 run.head_sha·suite와 PR check의 값은 서로 다를 수 있다.
const pr10Source = JSON.parse(readFileSync(new URL('./fixtures/gate-source-pr10.json', import.meta.url), 'utf8'));
function createGateSourceFixture() {
  const data = structuredClone(pr10Source);
  const proof = JSON.parse(data.check.external_id);
  const calls = [];
  const approved = { sha: '2c74587ea980bef61381bcdad69d2d832ff8c648' };
  const executed = { ...approved };
  const api = path => {
    calls.push(path);
    const prefix = `repos/${data.repository}`;
    if (path === `${prefix}/actions/workflows/independent-review.yml`) return data.workflow;
    if (path === `${prefix}/actions/runs/${proof.runId}`) return data.run;
    if (path === `${prefix}/contents/.github/workflows/independent-review.yml?ref=main`) return approved;
    if (path === `${prefix}/contents/.github/workflows/independent-review.yml?ref=${data.run.head_sha}`) return executed;
    throw new Error('예상하지 못한 API 경로');
  };
  const args = { check: data.check, pr: data.pr, fingerprint: proof.fingerprint, evidenceDigest: proof.evidenceDigest,
    repository: data.repository, defaultBranch: data.defaultBranch, api };
  return { data, proof, args, calls, approved, executed };
}

test('PR #10 회귀: 실제 custom check URL과 기본 브랜치 workflow 실행을 함께 검증', async () => {
  const fixture = createGateSourceFixture();
  assert.notEqual(fixture.data.check.id, fixture.data.run.id, 'check ID와 workflow run ID는 다른 식별자');
  assert.notEqual(fixture.data.check.check_suite.id, fixture.data.run.check_suite_id, 'custom check와 job suite는 다를 수 있음');
  assert.notEqual(fixture.data.check.head_sha, fixture.data.run.head_sha, 'workflow 실행 HEAD는 PR HEAD와 다를 수 있음');
  assert.deepEqual(await verifyGateSource(fixture.args), fixture.proof);
  assert.deepEqual(fixture.calls, [
    `repos/${fixture.data.repository}/actions/workflows/independent-review.yml`,
    `repos/${fixture.data.repository}/actions/runs/${fixture.proof.runId}`,
    `repos/${fixture.data.repository}/contents/.github/workflows/independent-review.yml?ref=main`,
    `repos/${fixture.data.repository}/contents/.github/workflows/independent-review.yml?ref=${fixture.data.run.head_sha}`,
  ]);
});

test('기존 workflow run URL도 실제 run ID와 승인된 YAML이 일치할 때 허용', async () => {
  const fixture = createGateSourceFixture();
  fixture.data.check.details_url = `https://github.com/${fixture.data.repository}/actions/runs/${fixture.proof.runId}`;
  assert.deepEqual(await verifyGateSource(fixture.args), fixture.proof);
});

test('check 링크의 호스트·저장소·ID 위조와 유사 URL은 API 조회 전 거부', async t => {
  const prefix = `https://github.com/${pr10Source.repository}`;
  const id = pr10Source.check.id;
  const runId = pr10Source.run.id;
  for (const url of [
    `http://github.com/${pr10Source.repository}/runs/${id}`,
    `https://github.com.evil.example/${pr10Source.repository}/runs/${id}`,
    `https://github.com@evil.example/${pr10Source.repository}/runs/${id}`,
    `https://github.com/other/repository/runs/${id}`,
    `${prefix}/runs/${id + 1}`, `${prefix}/runs/${runId}`,
    `${prefix}/actions/runs/${id}`, `${prefix}/actions/runs/${runId + 1}`,
    `${prefix}/runs/${id}/`, `${prefix}/runs/${id}?next=evil`, `${prefix}/runs/${id}#fragment`,
    `${prefix}/runs/0${id}`, `${prefix}/actions/runs/${runId}/job/${id}`, null, '',
  ]) await t.test(String(url), async () => {
    const fixture = createGateSourceFixture();
    fixture.data.check.details_url = url;
    await assert.rejects(verifyGateSource(fixture.args), /검사 출처 링크 오류/);
    assert.deepEqual(fixture.calls, []);
  });
});

test('정상 URL을 복사해도 다른 앱·check ID·PR HEAD·오래된 fingerprint·근거는 거부', async t => {
  const cases = [
    ['다른 앱 ID', fixture => { fixture.data.check.app.id = 1; }],
    ['다른 앱 slug', fixture => { fixture.data.check.app.slug = 'other'; }],
    ['check ID 누락', fixture => { delete fixture.data.check.id; }],
    ['잘못된 check ID', fixture => { fixture.data.check.id = -1; }],
    ['문자열 check ID', fixture => { fixture.data.check.id = String(fixture.data.check.id); }],
    ['다른 check ID', fixture => { fixture.data.check.id += 1; }],
    ['다른 check 이름', fixture => { fixture.data.check.name = 'verify'; }],
    ['이전 HEAD', fixture => { fixture.data.check.head_sha = 'a'.repeat(40); }],
    ['이전 fingerprint', fixture => { fixture.args.fingerprint = 'b'.repeat(64); }],
    ['변경된 근거', fixture => { fixture.args.evidenceDigest = 'e'.repeat(64); }],
    ['근거 누락', fixture => { fixture.args.evidenceDigest = null; }],
    ['다른 PR', fixture => { fixture.data.pr.number += 1; }],
    ['미완료 check', fixture => { fixture.data.check.status = 'in_progress'; }],
    ['실패 check', fixture => { fixture.data.check.conclusion = 'failure'; }],
  ];
  for (const [name, change] of cases) await t.test(name, async () => {
    const fixture = createGateSourceFixture(); change(fixture);
    await assert.rejects(verifyGateSource(fixture.args));
    assert.deepEqual(fixture.calls, []);
  });
});

test('실제 workflow 응답의 ID·경로·저장소·attempt·완료 상태와 승인된 YAML을 검증', async t => {
  const cases = [
    ['다른 실행 ID', fixture => { fixture.data.run.id += 1; }],
    ['실행 ID 누락', fixture => { delete fixture.data.run.id; }],
    ['다른 workflow ID', fixture => { fixture.data.run.workflow_id += 1; }],
    ['workflow ID 누락', fixture => { delete fixture.data.workflow.id; delete fixture.data.run.workflow_id; }],
    ['다른 workflow 경로', fixture => { fixture.data.run.path = '.github/workflows/ci.yml'; }],
    ['다른 조회 workflow', fixture => { fixture.data.workflow.path = '.github/workflows/ci.yml'; }],
    ['다른 저장소', fixture => { fixture.data.run.repository.full_name = 'other/repository'; }],
    ['fork 실행', fixture => { fixture.data.run.head_repository.full_name = 'other/repository'; }],
    ['다른 attempt', fixture => { fixture.data.run.run_attempt += 1; }],
    ['실행 HEAD 누락', fixture => { delete fixture.data.run.head_sha; }],
    ['실행 HEAD 형식 오류', fixture => { fixture.data.run.head_sha = 'main'; }],
    ['허용하지 않은 이벤트', fixture => { fixture.data.run.event = 'pull_request'; }],
    ['미완료 실행', fixture => { fixture.data.run.status = 'in_progress'; }],
    ...['failure', 'cancelled', 'skipped', null].map(state => [`실행 결론 ${state}`, fixture => { fixture.data.run.conclusion = state; }]),
    ['변조한 workflow', fixture => { fixture.executed.sha = 'different-blob'; }],
    ['승인된 YAML 누락', fixture => { delete fixture.approved.sha; }],
    ['실행한 YAML 누락', fixture => { delete fixture.executed.sha; }],
  ];
  for (const [name, change] of cases) await t.test(name, async () => {
    const fixture = createGateSourceFixture(); change(fixture);
    await assert.rejects(verifyGateSource(fixture.args));
  });
});

test('출처 확인 API가 조회 실패하면 정상 URL도 통과시키지 않음', async t => {
  for (const at of ['actions/workflows/', 'actions/runs/', '?ref=main', `?ref=${pr10Source.run.head_sha}`]) {
    await t.test(at, async () => {
      const fixture = createGateSourceFixture();
      const api = fixture.args.api;
      fixture.args.api = path => { if (path.includes(at)) throw new Error('조회 실패'); return api(path); };
      await assert.rejects(verifyGateSource(fixture.args), /조회 실패/);
    });
  }
});

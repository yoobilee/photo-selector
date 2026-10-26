import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validTitle, parseMetadata, describe, decide, sha256, parseConfirmation, blockingReviews } from './review-gate-core.mjs';
import { runGate } from './review-gate.mjs';

const config = JSON.parse(readFileSync(new URL('../../.ai/review-config.json', import.meta.url)));
const metadata = (agent = 'claude', risk = 'high', sensitive = 'yes') => `<!-- ai-review\nimplemented-by: ${agent}\nrisk: ${risk}\nsensitive-change: ${sensitive}\n-->`;
const pr = (body = metadata()) => ({ number: 1, title: 'fix: 권한 확인 누락 수정', body, state: 'open', changed_files: 1, head: { sha: 'a'.repeat(40) }, base: { sha: 'b'.repeat(40) } });
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

async function integration({permission='admin', role_name, type='User', changed=false, partial=false, malformed=false, reviews=[], apiFailure=false, mutateEvidence=false, duplicate=false, peerPermission='write', newestInvalid=false, otherEvidence=false, noPR=false, push=false}={}) {
  const current = pr();
  const d = describe(current, files, config);
  const c = confirmationFor(d);
  if (otherEvidence) c.evidence=c.evidence.replace('/pull/1#','/pull/2#');
  const statuses = [];
  const users = {login:'maintainer',id:1,type};
  const comments = [
    {id:10,user:users,body:reportFor(d)+(mutateEvidence?'변경':'')},
    {id:11,user:users,body:malformed?'/review-gate\n```json\n{bad}\n```':`/review-gate\n\`\`\`json\n${JSON.stringify(c)}\n\`\`\``},
  ];
  if (newestInvalid) comments.push({id:12,user:users,body:'/review-gate\n```json\n{invalid}\n```'});
  let gets=0;
  const github = {
    rest:{
      pulls:{list:async()=>({data:duplicate?[current,{...current,number:2}]:[current]}),get:async()=>({data:changed && ++gets>1?{...current,head:{sha:'c'.repeat(40)}}:current}),listFiles:async()=>({data:partial?[]:files}),listReviews:async()=>({data:reviews})},
      issues:{listComments:async()=>{if(apiFailure)throw new Error('sensitive response');return {data:comments};}},
      repos:{getCollaboratorPermissionLevel:async args=>({data:args.username==='peer'?{permission:peerPermission}:{permission,role_name}})},
      checks:{create:async()=>({data:{id:99}}),update:async value=>{statuses.push({...value,state:value.conclusion});}},
    },
    paginate:async(fn,args)=>(await fn(args)).data,
  };
  const summary = {addHeading(){return this;},addRaw(){return this;},addCodeBlock(){return this;},async write(){}};
  let failure=false;
  await runGate({github,context:{repo:{owner:'owner',repo:'repo'},payload:noPR?{issue:{number:9}}:push?{}:{pull_request:{number:1}},eventName:push?'push':'pull_request_target',runId:42},core:{summary,setFailed(){failure=true;}}});
  return {statuses,failure};
}

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
  const prs=[1,2,3].map(number=>({...pr(),number,head:{sha:String(number).repeat(40)}}));
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
      return {data:[{id:10,user,body:reportFor(d)},{id:11,user,body:`/review-gate\n\`\`\`json\n${JSON.stringify(c)}\n\`\`\``}]};
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

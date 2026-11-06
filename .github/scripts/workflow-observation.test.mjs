import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sha256, describe } from './review-gate-core.mjs';
import { canonical, classifyWork, stateDigest, observe } from './workflow-observation-core.mjs';
import { preflight, createGet } from './workflow-preflight.mjs';
const config = JSON.parse(readFileSync(new URL('../../.ai/review-config.json', import.meta.url)));
const body = meta => '<!-- ai-review\n' + Object.entries(meta).map(([key,value])=>`${key}: ${value}`).join('\n') + '\n-->';
const bindMeta = f => { f.before.body=f.after.body=body(f.meta); };
function fixture() {
  const target = { repository:'owner/repo',number:1,head:'a'.repeat(40),base:'b'.repeat(40),fingerprint:'c'.repeat(64) };
  const before = { target,policyHash:'d'.repeat(64),title:'docs: 문서 수정',body:'body',summary:'summary',files:[{filename:'README.md',status:'modified'}],
    checks:[{id:1,name:'verify',workflow:'.github/workflows/ci.yml',head:target.head,status:'completed',conclusion:'success',appId:15368,runId:2}],reviews:[],permissions:[] };
  const source = { appId:3,installationId:4,runId:5,attempt:1,workflow:'.github/workflows/reviewer.yml',executorSha:'e'.repeat(40),resultId:6 };
  const receipt = { v:1,target:structuredClone(target),policyHash:before.policyHash,role:'self',reviewer:'codex',status:'completed',
    findings:{critical:0,high:0,medium:0,low:0,unknown:0},report:'실제 결과',reportHash:sha256('실제 결과'),source };
  before.reviews=[structuredClone(receipt)];
  before.body=body({'implemented-by':'codex',risk:'low','sensitive-change':'no'});
  return { before,after:structuredClone(before),receipt,meta:{'implemented-by':'codex',risk:'low','sensitive-change':'no'},config,
    trust:{appId:3,installationId:4,workflow:source.workflow,executorSha:source.executorSha},
    apiEvidence:{status:'completed',conclusion:'success',target:structuredClone(target),reportHash:receipt.reportHash,source:structuredClone(source),
      role:'self',reviewer:'codex',policyHash:receipt.policyHash,findings:structuredClone(receipt.findings)} };
}
test('일반 자체 리뷰 후보도 승인·출처 인증·병합 권한은 없음',()=>{
  const result=observe(fixture()); assert.equal(result.state,'candidate');
  for(const field of ['mergeAuthorized','approvalVerified','sourceAuthenticated'])assert.equal(result[field],false);
});
test('정책 강제 상향·rename·제품 구현자·역할 분리',()=>{
  const f=fixture(); const run=files=>classifyWork({...f,files});
  assert.equal(run([{filename:'docs/help.md',status:'modified'}]).risk,'medium');
  assert.equal(run([{filename:'README.md',status:'renamed',previous_filename:'.github/workflows/ci.yml'}]).role,'independent');
  assert.throws(()=>run([{filename:'src/photos/x.ts',status:'modified'}]));
  f.meta['implemented-by']='claude';
  assert.equal(run([{filename:'src/photos/x.ts',status:'modified'}]).reviewer,'codex');
  assert.equal(run([{filename:'package-lock.json',status:'modified'}]).risk,'high');
  assert.throws(()=>run([{filename:'../README.md',status:'modified'}]));
  assert.throws(()=>run([{filename:'README.md',status:'renamed'}]));
});
const mutations = {
  '위조 App': f=>{f.receipt.source.appId=99;}, '다른 installation':f=>{f.receipt.source.installationId=99;},
  '다른 실행':f=>{f.receipt.source.runId=99;},'재실행':f=>{f.receipt.source.attempt=2;},
  '미인증 로컬':f=>{f.receipt.source={kind:'local-session'};}, 'trust 미설정':f=>{f.trust={};},
  '오래된 HEAD':f=>{f.receipt.target.head='f'.repeat(40);},'오래된 base':f=>{f.receipt.target.base='f'.repeat(40);},
  '다른 PR':f=>{f.receipt.target.number=2;},'오래된 정책':f=>{f.receipt.policyHash='f'.repeat(64);},
  '위조 집계':f=>{f.receipt.findings.low=1;},'누락 집계':f=>{delete f.receipt.findings.medium;},
  'unknown':f=>{f.receipt.findings.unknown=1;},'medium':f=>{f.receipt.findings.medium=1;},
  '자체를 독립으로 위장':f=>{f.receipt.role='independent';},'본문 변조':f=>{f.receipt.report+='x';},
  '미완료':f=>{f.receipt.status='running';},'실패 API 실행':f=>{f.apiEvidence.conclusion='failure';},
  '누락 CI':f=>{f.after.checks=[];f.before.checks=[];},'이전 CI':f=>{f.after.checks[0].head='f'.repeat(40);f.before=structuredClone(f.after);},
  '동시 HEAD':f=>{f.after.target.head='f'.repeat(40);},'동시 base':f=>{f.after.target.base='f'.repeat(40);},
  '동시 본문':f=>{f.after.body+='x';},'동시 리뷰':f=>{f.after.reviews.push({id:9,body:'changed'});},
  '동시 CI':f=>{f.after.checks[0].id=99;},'동시 권한':f=>{f.after.permissions.push({id:9,role:'admin'});},
  '고위험 자체 리뷰':f=>{f.meta.risk='high';bindMeta(f);},'알 수 없는 구현자':f=>{f.meta['implemented-by']='unknown';bindMeta(f);},
  '일반 경로 Claude 자체 리뷰':f=>{f.meta['implemented-by']='claude';},
  '위조 CI 앱':f=>{f.after.checks[0].appId=99;f.before=structuredClone(f.after);},
  '위조 CI workflow':f=>{f.after.checks[0].workflow='.github/workflows/fake.yml';f.before=structuredClone(f.after);},
  '중복 CI':f=>{f.after.checks.push(structuredClone(f.after.checks[0]));f.before=structuredClone(f.after);},
};
for(const [name,mutate] of Object.entries(mutations))test(name,()=>{const f=fixture();mutate(f);const result=observe(f);assert.equal(result.state,'blocked');assert.ok(result.reason.length>0);});
test('독립 완료 high는 사용자 승인 필요 후보일 뿐',()=>{
  const f=fixture();f.meta.risk='high';f.receipt.role=f.apiEvidence.role='independent';f.receipt.reviewer=f.apiEvidence.reviewer='claude';
  bindMeta(f);
  f.before.reviews=f.after.reviews=[structuredClone(f.receipt)];
  const result=observe(f);assert.equal(result.state,'candidate');assert.equal(result.humanApprovalRequired,true);assert.equal(result.approvalVerified,false);
});
test('제품 Claude + Codex 독립 후보',()=>{
  const f=fixture();f.meta['implemented-by']='claude';f.before.files=f.after.files=[{filename:'src/app.ts',status:'modified'}];
  bindMeta(f);
  f.receipt.role=f.apiEvidence.role='independent';f.before.reviews=f.after.reviews=[structuredClone(f.receipt)];assert.equal(observe(f).state,'candidate');
});
test('M1 모든 의존성 변형은 기존 의존성 감지와 일치하며 high 강제',()=>{
  const names=['package.json','package-lock.json','npm-shrinkwrap.json','pnpm-lock.yaml','yarn.lock','bun.lock','bun.lockb','requirements-dev.txt','poetry.lock','uv.lock','Pipfile.lock','pyproject.toml','Cargo.toml','Cargo.lock','go.mod','go.sum','Gemfile','Gemfile.lock','composer.json','composer.lock'];
  for(const name of names)for(const filename of [name,'nested/'+name]){
    const f=fixture(),files=[{filename,status:'modified'}];
    const old=describe({title:f.before.title,body:body(f.meta),head:{sha:f.before.target.head},base:{sha:f.before.target.base}},files,{...config,highRiskPaths:[],reviewAllMedium:false});
    assert.equal(old.needsReview,true,filename);
    assert.equal(classifyWork({...f,files}).risk,'high',filename);
  }
});
test('M2 calibration/e2e/rename은 제품, 미분류 경로는 거부',()=>{
  for(const filename of ['calibration.html','e2e/app.spec.ts','other.html'])assert.throws(()=>classifyWork({...fixture(),files:[{filename,status:'modified'}]}),/제품 구현자/);
  assert.throws(()=>classifyWork({...fixture(),files:[{filename:'unknown-root.ts',status:'modified'}]}),/미분류/);
  assert.throws(()=>classifyWork({...fixture(),files:[{filename:'README.md',status:'renamed',previous_filename:'calibration.html'}]}),/제품 구현자/);
});
test('shadow 필수 CI 누락과 body 밖 metadata 변조는 차단',()=>{
  const f=fixture();f.config=structuredClone(config);f.config.shadow.requiredChecks=[];assert.equal(observe(f).state,'blocked');
  const g=fixture();g.meta.risk='high';assert.match(observe(g).reason,/metadata/);
});
test('canonical 키 순서 안정성, 누락 값은 성공으로 덮지 않음',()=>{
  assert.equal(canonical({b:1,a:2}),canonical({a:2,b:1}));assert.throws(()=>canonical({x:undefined}));
  const f=fixture();assert.equal(stateDigest(f.before),stateDigest(f.after));delete f.after.policyHash;assert.equal(observe(f).state,'blocked');
});
test('진단은 읽기 전용·미설정/실패/공유 관리자 인증을 차단',async()=>{
  const paths=[];const result=await preflight({repository:'owner/repo',settings:{},get:async path=>{paths.push(path);if(path==='user')return{id:1};if(path==='repos/owner/repo')return{default_branch:'main',permissions:{admin:true}};throw new Error('api secret');}});
  assert.equal(result.ready,false);assert.equal(result.mergeAuthorized,false);assert.ok(result.issues.length>=5);
  assert.ok(paths.every(path=>path==='user'||path.startsWith('repos/owner/repo')));assert.ok(!JSON.stringify(result).includes('api secret'));
});
test('게시/병합 App 동일·과다 권한·자기 승인·우회 설정을 탐지',async()=>{
  const result=await preflight({repository:'owner/repo',settings:{evidence:{appId:2,slug:'one'},merger:{appId:2,slug:'one'},executorUserId:1,approverId:1},get:async path=>{
    if(path==='user')return{id:1};if(path.startsWith('apps/'))return{id:2,permissions:{administration:'write'}};
    if(path.includes('/environments/'))return{can_admins_bypass:true,protection_rules:[{type:'required_reviewers',prevent_self_review:false,reviewers:[]}]};return{};
  }});
  for(const word of ['App 분리','권한','self-review','실행자'])assert.ok(result.issues.some(x=>x.includes(word)));
});
test('GET adapter는 명시적인 GET만 실행',()=>{
  const calls=[];const get=createGet(args=>{calls.push(args);return '{"id":1}';});
  assert.deepEqual(get('user'),{id:1});assert.deepEqual(calls,[['api','--method','GET','user']]);
});
test('설정 진단에 문제가 없어도 실제 격리는 미검증/ready=false',async()=>{
  const settings={evidence:{appId:2,slug:'evidence'},merger:{appId:3,slug:'merger'},executorUserId:5,approverId:6};
  const get=async path=>{
    if(path==='user')return{id:5};
    if(path==='repos/owner/repo')return{default_branch:'main',permissions:{admin:false,maintain:false}};
    if(path.endsWith('/protection'))return{required_status_checks:{strict:true,checks:[{context:'verify',app_id:15368},{context:'independent-review',app_id:15368}]},enforce_admins:{enabled:true}};
    if(path==='apps/evidence')return{id:2,permissions:{contents:'read',pull_requests:'read',actions:'read',issues:'write',checks:'write'}};
    if(path==='apps/merger')return{id:3,permissions:{contents:'write',pull_requests:'write',actions:'read',issues:'read',checks:'read',administration:'read'}};
    if(path.endsWith('/deployment-branch-policies'))return{branch_policies:[{name:'main',type:'branch'}]};
    return{can_admins_bypass:false,deployment_branch_policy:{custom_branch_policies:true,protected_branches:false},protection_rules:[{type:'required_reviewers',prevent_self_review:true,reviewers:[{type:'User',reviewer:{id:6}}]}]};
  };
  const result=await preflight({repository:'owner/repo',settings,get});assert.deepEqual(result.issues,[]);assert.equal(result.ready,false);
  const extra=await preflight({repository:'owner/repo',settings,get:async path=>{
    const value=await get(path);if(path.endsWith('/photo-selector-high-risk-merge'))value.protection_rules[0].reviewers.push({type:'User',reviewer:{id:5}});return value;
  }});assert.ok(extra.issues.some(x=>x.includes('self-review')));
  await assert.rejects(preflight({repository:'../..',settings,get}));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sha256 } from './review-gate-core.mjs';
import { canonical, classifyWork, stateDigest, observe } from './workflow-observation-core.mjs';
import { preflight } from './workflow-preflight.mjs';
const config = JSON.parse(readFileSync(new URL('../../.ai/review-config.json', import.meta.url)));
function fixture() {
  const target = { repository:'owner/repo',number:1,head:'a'.repeat(40),base:'b'.repeat(40),fingerprint:'c'.repeat(64) };
  const before = { target,policyHash:'d'.repeat(64),title:'docs: 문서 수정',body:'body',summary:'summary',files:[{filename:'README.md',status:'modified'}],
    checks:[{id:1,name:'verify',workflow:'.github/workflows/ci.yml',head:target.head,status:'completed',conclusion:'success',appId:15368,runId:2}],reviews:[],permissions:[] };
  const source = { appId:3,installationId:4,runId:5,attempt:1,workflow:'.github/workflows/reviewer.yml',executorSha:'e'.repeat(40),resultId:6 };
  const receipt = { v:1,target:structuredClone(target),policyHash:before.policyHash,role:'self',reviewer:'codex',status:'completed',
    findings:{critical:0,high:0,medium:0,low:0,unknown:0},report:'실제 결과',reportHash:sha256('실제 결과'),source };
  before.reviews=[structuredClone(receipt)];
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
  '고위험 자체 리뷰':f=>{f.meta.risk='high';},'알 수 없는 구현자':f=>{f.meta['implemented-by']='unknown';},
  '일반 경로 Claude 자체 리뷰':f=>{f.meta['implemented-by']='claude';},
  '위조 CI 앱':f=>{f.after.checks[0].appId=99;f.before=structuredClone(f.after);},
  '위조 CI workflow':f=>{f.after.checks[0].workflow='.github/workflows/fake.yml';f.before=structuredClone(f.after);},
  '중복 CI':f=>{f.after.checks.push(structuredClone(f.after.checks[0]));f.before=structuredClone(f.after);},
};
for(const [name,mutate] of Object.entries(mutations))test(name,()=>{const f=fixture();mutate(f);assert.equal(observe(f).state,'blocked');});
test('독립 완료 high는 사용자 승인 필요 후보일 뿐',()=>{
  const f=fixture();f.meta.risk='high';f.receipt.role=f.apiEvidence.role='independent';f.receipt.reviewer=f.apiEvidence.reviewer='claude';
  f.before.reviews=f.after.reviews=[structuredClone(f.receipt)];
  const result=observe(f);assert.equal(result.state,'candidate');assert.equal(result.humanApprovalRequired,true);assert.equal(result.approvalVerified,false);
});
test('제품 Claude + Codex 독립 후보',()=>{
  const f=fixture();f.meta['implemented-by']='claude';f.before.files=f.after.files=[{filename:'src/app.ts',status:'modified'}];
  f.receipt.role=f.apiEvidence.role='independent';f.before.reviews=f.after.reviews=[structuredClone(f.receipt)];assert.equal(observe(f).state,'candidate');
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

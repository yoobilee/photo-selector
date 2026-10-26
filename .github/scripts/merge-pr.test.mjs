import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

async function fakeMain() {
  const fs=require('node:fs');
  const args=process.argv.slice(2);
  const mode=process.env.STARTER_TEST_MODE;
  const title='fix: 한글 제목 "인용"과 $(명령) 보존';
  const {describe,sha256}=await import(process.env.STARTER_CORE_URL);
  const config=JSON.parse(fs.readFileSync(process.env.STARTER_CONFIG,'utf8'));
  const body='<!-- ai-review\nimplemented-by: claude\nrisk: high\nsensitive-change: yes\n-->\nCloses #7';
  const pr={number:1,state:mode==='closed'?'closed':'open',draft:mode==='draft',title,body,changed_files:1,head:{sha:'a'.repeat(40)},base:{sha:'b'.repeat(40),ref:mode==='other-base'?'develop':'main',repo:{full_name:'owner/repo'}},merged:fs.existsSync(process.env.STARTER_TEST_MERGED),merge_commit_sha:'c'.repeat(40)};
  const files=[{filename:'src/auth.ts',status:'modified'}];
  const d=describe(pr,files,config);
  const report='# 독립 리뷰 보고서\nHEAD: '+d.head+'\nBASE: '+d.base+'\n독립 리뷰 완료';
  const confirmation={fingerprint:d.fingerprint,decision:'pass',reviewer:'codex',reviewComplete:true,evidence:'https://github.com/owner/repo/pull/1#issuecomment-10',evidenceHash:sha256(report),findings:{critical:0,high:0,medium:0,low:0}};
  const user={id:1,login:'owner',type:'User'};
  const comments=[{id:10,user,body:report},{id:11,user,body:'/review-gate\n'+String.fromCharCode(96).repeat(3)+'json\n'+JSON.stringify(confirmation)+'\n'+String.fromCharCode(96).repeat(3)}];
  if(mode==='no-confirmation')comments.pop();
  const proof={pr:1,fingerprint:mode==='stale'?'bad':d.fingerprint,runId:'42',attempt:'1'};
  const check={id:99,name:'independent-review',head_sha:pr.head.sha,status:'completed',conclusion:mode==='gate-failure'?'failure':'success',app:{id:123,slug:mode==='wrong-app'?'other':'github-actions'},external_id:JSON.stringify(proof),details_url:'https://github.com/owner/repo/actions/runs/42'};
  fs.appendFileSync(process.env.STARTER_TEST_LOG,JSON.stringify(args)+'\n');
  if(args[0]==='pr'&&args[1]==='checks') {
    if(mode==='ci-failure')process.exit(1);
  } else if(args[0]==='pr'&&args[1]==='merge') {
    if(mode==='merge-failure')process.exit(1);
    if(args[args.indexOf('--subject')+1]!==title)process.exit(2);
    if(fs.readFileSync(args[args.indexOf('--body-file')+1],'utf8')!==body)process.exit(3);
    fs.writeFileSync(process.env.STARTER_TEST_MERGED,'yes');
  } else if(args[0]==='api') {
    const path=args[1];
    let out;
    if(path==='repos/owner/repo')out={default_branch:'main'};
    else if(path.endsWith('/pulls/1'))out=pr;
    else if(path.includes('/pulls?'))out=[[pr]];
    else if(path.endsWith('/files?per_page=100'))out=[files];
    else if(path.includes('/reviews?'))out=[[]];
    else if(path.includes('/comments?'))out=[comments];
    else if(path.includes('/permission'))out={permission:'admin'};
    else if(path.includes('/contents/.ai/review-config.json'))out={encoding:'base64',content:Buffer.from(JSON.stringify(config)).toString('base64')};
    else if(path.includes('/check-runs?'))out=[{check_runs:mode==='status-only'?[]:[check]}];
    else if(path.includes('/actions/workflows/'))out={id:4};
    else if(path.includes('/actions/runs/'))out={workflow_id:mode==='wrong-workflow'?5:4,path:'.github/workflows/independent-review.yml',status:'completed',conclusion:'success',run_attempt:1,repository:{full_name:'owner/repo'},head_repository:{full_name:'owner/repo'},event:'pull_request_target',head_sha:'d'.repeat(40)};
    else if(path.includes('/contents/.github/workflows/'))out={sha:mode==='changed-workflow'&&path.includes('ref=dddd')?'different':'approved'};
    else if(path.includes('/protection/required_status_checks'))out={strict:mode!=='non-strict',checks:[{context:'independent-review',app_id:123}]};
    else if(path.includes('/commits/'))out={commit:{message:mode==='bad-subject'?'Merge pull request #1':title+'\n\nCloses #7'}};
    else process.exit(4);
    console.log(JSON.stringify(out));
  } else process.exit(5);
}

function run(mode) {
  // 가짜 CLI의 안전한 실행을 보장할 수 없는 플랫폼에서는 실제 gh를 탐색하지 않는다.
  if(process.platform!=='linux')throw new Error('Linux 전용 가짜 CLI 테스트');
  const dir=mkdtempSync(join(tmpdir(),'starter-merge-test-'));
  try {
    writeFileSync(join(dir,'gh'),'#!/usr/bin/env node\n('+fakeMain.toString()+')().catch(()=>process.exit(9));',{mode:0o755});
    const log=join(dir,'commands.jsonl');
    const result=spawnSync(process.execPath,[fileURLToPath(new URL('./merge-pr.mjs',import.meta.url)),'owner/repo','1','squash'],{
      encoding:'utf8',env:{...process.env,PATH:dir+delimiter+process.env.PATH,STARTER_TEST_MODE:mode,STARTER_TEST_LOG:log,STARTER_TEST_MERGED:join(dir,'merged'),STARTER_CORE_URL:new URL('./review-gate-core.mjs',import.meta.url).href,STARTER_CONFIG:fileURLToPath(new URL('../../.ai/review-config.json',import.meta.url))},
    });
    return {result,calls:readFileSync(log,'utf8').trim().split('\n').map(JSON.parse)};
  } finally {rmSync(dir,{recursive:true,force:true});}
}
const linuxTest=process.platform==='linux'?test:test.skip;

linuxTest('한글·셸 기호·Issue 본문과 예상 head를 보존',()=>{
  const {result,calls}=run('success');
  assert.equal(result.status,0,result.stderr);
  const merge=calls.find(args=>args[0]==='pr'&&args[1]==='merge');
  assert.equal(merge[merge.indexOf('--match-head-commit')+1],'a'.repeat(40));
});

linuxTest('위조·출처 불일치·오래된 검사·근거 누락·CI 실패·잘못된 PR은 병합하지 않음',()=>{
  for(const mode of ['ci-failure','gate-failure','status-only','wrong-app','stale','wrong-workflow','changed-workflow','non-strict','no-confirmation','draft','closed','other-base']) {
    const {result,calls}=run(mode);
    assert.equal(result.status,1,mode);
    assert.equal(calls.some(args=>args[0]==='pr'&&args[1]==='merge'),false,mode);
  }
});

linuxTest('병합 명령 실패 또는 저장 제목 오류 후 자동 재시도하지 않음',()=>{
  for(const mode of ['merge-failure','bad-subject']) {
    const {result,calls}=run(mode);
    assert.equal(result.status,1);
    assert.equal(calls.filter(args=>args[0]==='pr'&&args[1]==='merge').length,1);
    if(mode==='bad-subject')assert.match(result.stderr,/사후 검증이 실패/);
  }
});

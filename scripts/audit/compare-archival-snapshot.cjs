// Paired real-PostgreSQL archival test; both arms roll back to the SAME snapshot.
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const repo = path.resolve(__dirname, '../..');
require('ts-node').register({transpileOnly:true,project:path.join(repo,'tsconfig.json')});
const {PrismaClient} = require('@prisma/client');
const {PrismaPg} = require('@prisma/adapter-pg');
const baselineRepo = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const Baseline = require(path.join(baselineRepo,'src/consolidation/stages/dream-cycle-archival.stage.ts')).DreamCycleArchivalStage;
const Candidate = require(path.join(repo,'src/consolidation/stages/dream-cycle-archival.stage.ts')).DreamCycleArchivalStage;
const prisma = new PrismaClient({adapter:new PrismaPg({connectionString:'postgresql://postgres:lifecycle_scratch@127.0.0.1:55441/engram_lifecycle_synthetic'})});
const rollback = new Error('intentional rollback');
(async()=>{
 try {
  const source = await prisma.memory.findFirst({where:{userId:'lifecycle-user',source:'EXPLICIT_STATEMENT',layer:'SESSION',consolidatedInto:{not:null},searchable:true}});
  const receipt = await prisma.memory.findFirst({where:{userId:'lifecycle-user',source:'EXPLICIT_STATEMENT',raw:{contains:'collection token is VERDIGRIS-84'}}});
  assert.ok(source,'Requires an actually consolidated source'); assert.ok(receipt,'Requires independent unique receipt source');
  const selected=[source.id,receipt.id]; const result={sourceId:source.id,summaryId:source.consolidatedInto,receiptId:receipt.id,arms:{}};
  for(const [name,Stage] of [['baseline',Baseline],['candidate',Candidate]]) {
   try { await prisma.$transaction(async tx=>{
    await tx.memory.update({where:{id:source.consolidatedInto},data:{raw:'Intentionally incomplete summary, no source facts retained.'}});
    await tx.memory.updateMany({where:{id:{in:selected}},data:{searchable:true,userPinned:false,supersededById:null,deletedAt:null,tier:'COLD',importanceScore:0.01,createdAt:new Date(Date.now()-100*86400000),lastRetrievedAt:null,lastUsedAt:null,usedCount:0}});
    const stageResult=await new Stage(tx,{get:()=>undefined}).run('lifecycle-user',false);
    const rows=await tx.memory.findMany({where:{id:{in:selected}},select:{id:true,raw:true,searchable:true,consolidatedInto:true}});
    result.arms[name]={stageResult,rows};throw rollback;
   }); } catch(e){if(e!==rollback)throw e;}
  }
  assert.ok(result.arms.baseline.rows.every(r=>!r.searchable),'Baseline must reproduce hiding');
  assert.ok(result.arms.candidate.rows.every(r=>r.searchable),'Candidate must preserve eligibility');
  assert.deepEqual(result.arms.baseline.rows.map(r=>r.raw),result.arms.candidate.rows.map(r=>r.raw));
  result.passed=true;result.allMutationsRolledBack=true;fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');console.log('PASS: same snapshot; baseline hides both sources, candidate retains both; all mutations rolled back');
 } finally {await prisma.$disconnect();}
})().catch(e=>{console.error(e);process.exitCode=1});

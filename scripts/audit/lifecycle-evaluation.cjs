// Synthetic-only full-app lifecycle probe. Never load .env from a live checkout.
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const repo = path.resolve(__dirname, '../..');
const db = new URL(process.env.DATABASE_URL || 'file:///missing');
assert.equal(db.hostname, '127.0.0.1');
assert.equal(db.port, '55441');
assert.equal(db.pathname, '/engram_lifecycle_synthetic');
assert.equal(process.env.REDIS_URL, 'redis://127.0.0.1:16391');
// Optional diagnostic arm: serialize real embedding HTTP transport, no fake vectors.
if (process.env.LIFECYCLE_SERIAL_EMBED === '1') {
 const originalFetch=global.fetch; let tail=Promise.resolve();
 global.fetch=(url,options)=>{
  if (!String(url).startsWith('http://127.0.0.1:8080/')) return originalFetch(url,options);
  const result=tail.then(async()=>{const r=await originalFetch(url,options); const body=await r.text(); return new Response(body,{status:r.status,headers:r.headers});});
  tail=result.catch(()=>{}); return result;
 };
}
require('ts-node').register({ transpileOnly: true, project: path.join(repo, 'tsconfig.json') });
const Module = require('node:module');
const resolve = Module._resolveFilename;
Module._resolveFilename = function(spec, parent, ...rest) {
 if (spec.startsWith('.') && spec.endsWith('.js') && parent) {
  const ts = path.resolve(path.dirname(parent.filename), spec.slice(0,-3)+'.ts');
  if (fs.existsSync(ts)) spec=ts;
 }
 return resolve.call(this,spec,parent,...rest);
};
const { createTestApp } = require(path.join(repo, 'test/helpers/create-test-app.ts'));
const { DreamCycleConsolidationStage } = require(path.join(repo, 'src/consolidation/stages/dream-cycle-consolidation.stage.ts'));
const { DreamCycleArchivalStage } = require(path.join(repo, 'src/consolidation/stages/dream-cycle-archival.stage.ts'));
const corpus = require(process.env.LIFECYCLE_CORPUS || './lifecycle-corpus.json');
assert.equal(new Set(corpus.memories.map(([id])=>id)).size, corpus.memories.length);
assert.ok(corpus.queries.every(q=>q.relevant.every(id=>corpus.memories.some(([label])=>label===id))));
const request = require('supertest');
const output = process.env.LIFECYCLE_OUTPUT || '/tmp/lifecycle-results.json';
const report = { corpusSha256: crypto.createHash('sha256').update(JSON.stringify(corpus)).digest('hex'), config: { serialEmbeddingTransport: process.env.LIFECYCLE_SERIAL_EMBED === '1', model: process.env.EMBEDDING_MODEL, llm: process.env.LLM_MODEL, llmProvider: process.env.LLM_PROVIDER, elasticsearchOverride: 'no keyword results', semanticJudgmentRequired: true, consolidationSimilarity: 'default 0.82', retrievalLimit: 5 }, ingestion: [], stages: {}, summaries: [], appCloseReturned: false };
const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2));
(async () => {
 const { app, prisma } = await createTestApp({ overrideEmbedding: false });
 try {
  if (process.env.LIFECYCLE_DIAGNOSTIC_ENUM === '1') {
   await prisma.$executeRawUnsafe("ALTER TYPE \"MemorySource\" ADD VALUE IF NOT EXISTS 'DREAM_CYCLE'");
   report.config.diagnosticEnumRepair = true;
  }
  const userId = 'lifecycle-user'; const accountId = 'lifecycle-account'; const key = 'eng_lifecycle_synthetic_only';
  await prisma.$executeRawUnsafe("INSERT INTO accounts(id,email,password_hash,created_at,updated_at) VALUES ($1,'lifecycle@synthetic.invalid','unused',now(),now())", accountId);
  await prisma.$executeRawUnsafe("INSERT INTO agents(id,name,account_id,api_key_hash,api_key_hint,created_at,updated_at) VALUES ('lifecycle-agent','lifecycle',$1,$2,'only',now(),now())", accountId, crypto.createHash('sha256').update(key).digest('hex'));
  await prisma.$executeRawUnsafe("INSERT INTO users(id,external_id,account_id,is_default,created_at,updated_at) VALUES ($1,$1,$2,false,now(),now())",userId,accountId);
  const headers = { 'X-AM-API-Key': key, 'X-AM-User-ID': userId };
  const ids = {};
  for (const [label, raw] of [...corpus.memories, ['exact_repeat', corpus.memories[3][1]]]) {
   const res = await request(app.getHttpServer()).post('/v1/memories').set(headers).send({raw, layer: 'SESSION', source: 'EXPLICIT_STATEMENT'});
   assert.ok([200,201].includes(res.status), JSON.stringify(res.body));
   ids[label] = res.body.id;
   report.ingestion.push({label,id:res.body.id,status:res.status}); save();
   // Serial processing avoids making this tiny semantic test a saturation test.
   const deadline = Date.now()+90000;
   while (Date.now()<deadline) {
    const row=await prisma.memory.findUnique({where:{id:res.body.id}});
    if (['COMPLETE','DUPLICATE','FAILED'].includes(row.embeddingStatus)) { report.ingestion.at(-1).embeddingStatus=row.embeddingStatus; break; }
    await new Promise(r=>setTimeout(r,500));
   }
   report.ingestion.at(-1).completionObserved = !!report.ingestion.at(-1).embeddingStatus;
   save();
  }
  const snapshot = async (name) => {
   const rows=await prisma.memory.findMany({where:{userId},include:{extraction:true}});
   report.stages[name]={rows:rows.map(r=>({id:r.id,raw:r.raw,layer:r.layer,source:r.source,searchable:r.searchable,tier:r.tier,supersededById:r.supersededById,embeddingStatus:r.embeddingStatus,consolidatedInto:r.consolidatedInto,extraction:r.extraction})),queries:[]};
   for (const q of corpus.queries) {
    const res=await request(app.getHttpServer()).post('/v1/memories/query').set(headers).send({query:q.query,limit:5});
    const returned=res.body.memories || []; const top=returned.slice(0,5);
    const judged=top.map(r=>({id:r.id,raw:r.raw, relevant:q.relevant.some(label=>ids[label]===r.id)}));
    const text=top.map(r=>r.raw).join('\n');
    report.stages[name].queries.push({id:q.id,status:res.status,expectedFacts:q.facts,matchedFacts:q.facts.filter(f=>text.toLowerCase().includes(f.toLowerCase())),results:judged,noAnswer:q.relevant.length===0,abstained:[200,201].includes(res.status) ? top.length===0 : null, querySucceeded:[200,201].includes(res.status)});
   }
   save();
  };
  await snapshot('formed');
  await prisma.memory.updateMany({where:{userId,embeddingStatus:'COMPLETE'},data:{tier:'COLD',createdAt:new Date(Date.now()-100*86400000)}});
  report.dream = await app.get(DreamCycleConsolidationStage).run(userId,false); save();
  await snapshot('consolidated');
  report.summaries=report.stages.consolidated.rows.filter(r=>r.source==='DREAM_CYCLE');
  if (process.env.LIFECYCLE_OMISSION_CONTROL === '1') {
   const source=await prisma.memory.findFirst({where:{userId,consolidatedInto:{not:null},searchable:true}});
   if (!source) { report.omissionControl={executed:false,reason:'No actually consolidated source'}; }
   else {
    // Separate causal diagnostic, never counted as semantic retrieval scoring:
    // deliberately remove all source facts from the actual linked summary.
    await prisma.memory.update({where:{id:source.consolidatedInto},data:{raw:'Deliberately incomplete diagnostic summary: source details omitted.'}});
    await prisma.memory.update({where:{id:source.id},data:{importanceScore:0.01,lastRetrievedAt:null,lastUsedAt:null,usedCount:0,createdAt:new Date(Date.now()-100*86400000)}});
    const result=await app.get(DreamCycleArchivalStage).run(userId,false);
    const after=await prisma.memory.findUnique({where:{id:source.id}});
    report.omissionControl={executed:true,sourceId:source.id,summaryId:source.consolidatedInto,sourceRaw:source.raw,result,searchableAfter:after.searchable,sourceRawUnchanged:after.raw===source.raw};
    // Restore summary text before normal archival/retrieval scoring; embeddings unchanged.
    const summary=report.summaries.find(r=>r.id===source.consolidatedInto);
    await prisma.memory.update({where:{id:summary.id},data:{raw:summary.raw}});
   }
   save();
  }
  // Explicit future-lifecycle scenario: emulate 100-day age and no recent use.
  await prisma.memory.updateMany({where:{id:{in:corpus.memories.filter(([id])=>id.startsWith('archive_')).map(([id])=>ids[id])}},data:{importanceScore:0.01,lastRetrievedAt:null,lastUsedAt:null,usedCount:0,createdAt:new Date(Date.now()-100*86400000)}});
  report.archival = await app.get(DreamCycleArchivalStage).run(userId,false); save();
  await snapshot('archived');
 } finally { await app.close(); report.appCloseReturned=true; report.activeResourcesAfterClose=process.getActiveResourcesInfo(); save(); }
})().catch(e=>{report.error=String(e.stack||e);save();console.error(e);process.exitCode=1});

// Isolated H1 regression: never reads application DATABASE_URL or touches its DB.
// Run: node scripts/audit/preservation-postgres.cjs (local socket /tmp, pgvector).
const path = require('node:path');
const assert = require('node:assert/strict');
const repo = path.resolve(__dirname, '../..');
require('ts-node').register({ transpileOnly: true, project: path.join(repo, 'tsconfig.json') });
const { Client } = require('pg');
const { DreamCycleConsolidationStage } = require(path.join(repo, 'src/consolidation/stages/dream-cycle-consolidation.stage.ts'));
const { EmbeddingWriteService } = require(path.join(repo, 'src/vector/embedding-write.service.ts'));
const db = `engram_preservation_test_${process.pid}`;
const config = { host: '/tmp', database: 'postgres' };
(async () => {
  const admin = new Client(config); await admin.connect();
  await admin.query(`CREATE DATABASE ${db}`);
  const tx = new Client({ ...config, database: db });
  try {
    await tx.connect();
    await tx.query('CREATE EXTENSION vector');
    await tx.query(`CREATE TABLE memories(id text PRIMARY KEY, user_id text DEFAULT 'u', raw text,
      embedding vector(768), searchable boolean, superseded_by_id text, tier text,
      consolidated boolean DEFAULT false, consolidated_into text, user_pinned boolean DEFAULT false,
      deleted_at timestamp, created_at timestamp DEFAULT now())`);
    await tx.query(`CREATE TABLE memory_embeddings(id text PRIMARY KEY, memory_id text REFERENCES memories(id),
      model_id text, dimensions int, embedding vector, created_at timestamp, updated_at timestamp,
      UNIQUE(memory_id, model_id))`);
    const sql = {
      $queryRawUnsafe: async (q, ...args) => (await tx.query(q, args)).rows,
      $executeRawUnsafe: async (q, ...args) => (await tx.query(q, args)).rowCount,
    };
    let failPublication = false;
    const client = { ...sql, memory: {
      create: async ({ data }) => {
        await tx.query('INSERT INTO memories(id,raw,searchable,tier) VALUES ($1,$2,$3,$4)', ['new', data.raw, data.searchable, data.tier]);
        return { id: 'new' };
      },
      update: async ({ data }) => tx.query("UPDATE memories SET searchable=$1 WHERE id='new'", [data.searchable]),
      updateMany: async ({ data }) => {
        if (failPublication) await tx.query('SELECT 1/0');
        return tx.query(`UPDATE memories SET consolidated=$1,consolidated_into=$2,
        superseded_by_id=$3,tier=COALESCE($4,tier) WHERE id IN ('a','b','c')`,
        [data.consolidated, data.consolidatedInto, data.supersededById ?? null, data.tier ?? null]);
      },
    } };
    const prisma = { $queryRaw: async (strings, ...args) => (await tx.query(strings.reduce((s, part, i) => s + (i ? '$' + i : '') + part, ''), args)).rows, $transaction: async (fn) => {
      await tx.query('BEGIN');
      try { const result = await fn(client); await tx.query('COMMIT'); return result; }
      catch (e) { await tx.query('ROLLBACK'); throw e; }
    } };
    const embeddingWriter = new EmbeddingWriteService({
      $queryRawUnsafe: () => { throw new Error('Used external connection'); },
      $executeRawUnsafe: () => { throw new Error('Used external connection'); },
    });
    for (const [name, model, dims, vector, fail] of [
      ['768 success', 'bge-base', 768, Array(768).fill(0.1), false],
      ['1536 success', 'openai-small', 1536, Array(1536).fill(0.1), false],
      ['publication DB failure', 'bge-base', 768, Array(768).fill(0.1), true],
      ['missing', 'bge-base', 768, undefined, true],
      ['sparse', 'bge-base', 768, Array(768), true],
      ['wrong dimensions', 'bge-base', 768, Array(1536).fill(0.1), true],
    ]) {
      failPublication = name === 'publication DB failure';
      process.env.EMBEDDING_MODEL = model;
      await tx.query('TRUNCATE memories, memory_embeddings');
      await tx.query("INSERT INTO memories(id,raw,searchable,tier) VALUES ('a','date: September 12',true,'COLD'),('b','exception: weekends',true,'COLD'),('c','name: Ada',true,'COLD')");
      const vec = `[${Array(dims).fill(0.1).join(',')}]`;
      await tx.query('INSERT INTO memory_embeddings SELECT id,id,$1,$2,$3::vector,now(),now() FROM memories', [model, dims, vec]);
      const stage = new DreamCycleConsolidationStage(prisma, { get: () => undefined },
        { embed: async () => [vector] }, { chat: async () => ({ content: 'Lossy summary' }) }, embeddingWriter);
      assert.equal((await stage.fetchColdMemories('u')).length, 3);
      const call = () => stage.consolidateCluster([{ id: 'a', content: 'date: September 12' }, { id: 'b', content: 'exception: weekends' }, { id: 'c', content: 'name: Ada' }], 'u');
      if (fail) await assert.rejects(call); else await call();
      const eligible = (await tx.query(`SELECT m.id, me.dimensions FROM memories m JOIN memory_embeddings me ON me.memory_id=m.id
        WHERE m.searchable AND m.superseded_by_id IS NULL AND me.model_id=$1 ORDER BY m.id`, [model])).rows;
      assert.equal(eligible.length, fail ? 3 : 4);
      assert.deepEqual(eligible.filter(r => r.id !== 'new').map(r => r.id), ['a','b','c']);
      assert.ok(eligible.every(r => r.dimensions === dims));
      console.log(JSON.stringify({ name, eligible: eligible.length, sourcesPreserved: 3, rollback: fail }));
    }
    await tx.query("UPDATE memories SET consolidated_into='missing-replacement' WHERE id IN ('a','b','c')");
    const inventory = require('node:fs').readFileSync(path.join(__dirname, 'consolidation-reconciliation.sql'), 'utf8')
      .replace(/:'model_id'/g, "'bge-base'").replace(/:expected_dims/g, '768');
    const inventoryResult = await tx.query(inventory);
    assert.equal(inventoryResult[1].rows.length, 1);
    assert.equal(inventoryResult[1].rows[0].missing_replacement, true);
    console.log(JSON.stringify({ reconciliationReadOnly: true, missingReplacementDetected: true }));
  } finally {
    await tx.end(); await admin.query(`DROP DATABASE ${db}`); await admin.end();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });

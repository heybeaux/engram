/**
 * Sync cloud Engram → local via REST API
 * Pulls all memories and inserts into local Postgres
 */
const { Client } = require('pg');
const https = require('https');

const API_KEY   = 'eng_dca0a9f0cb98341af8daca93e2070bff6c60b78ef2cf829b';
const USER_ID   = 'beaux';
const LOCAL_URL = 'postgresql://beauxwalton@localhost:5432/engram';
const PAGE_SIZE = 100;

function apiGet(path) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.openengram.ai',
      path,
      headers: { 'X-AM-API-Key': API_KEY, 'X-AM-User-ID': USER_ID }
    };
    https.get(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(new Error(`JSON parse: ${d.substring(0,200)}`)); }
      });
    }).on('error', reject);
  });
}

async function run() {
  const db = new Client(LOCAL_URL);
  await db.connect();
  console.log('Connected to local DB');

  // Fetch first page to get userId/agentId
  const firstPage = await apiGet(`/v1/memories?limit=1`);
  const total = firstPage.total || 0;
  const sample = firstPage.memories?.[0];
  const cloudUserId = sample?.userId;
  const cloudAgentId = sample?.agentId;

  console.log(`Total memories: ${total}`);
  console.log(`Cloud userId: ${cloudUserId}, agentId: ${cloudAgentId}`);
  if (!cloudUserId) { console.error('Could not determine userId'); process.exit(1); }

  // Generate a stable local account ID
  const accountId = cloudUserId; // reuse same ID for simplicity

  // 1. Seed account
  await db.query(`
    INSERT INTO accounts (id, email, password_hash, plan, created_at, updated_at)
    VALUES ($1, $2, $3, 'PRO'::"Plan", NOW(), NOW())
    ON CONFLICT (id) DO NOTHING
  `, [accountId, 'beaux@local.kit', 'local_noop']);

  // 2. Seed agent (needed before users because users.agent_id → agents.id)
  const agentRowId = cloudAgentId || accountId + '_agent';
  await db.query(`
    INSERT INTO agents (id, account_id, name, api_key_hash, api_key_hint, created_at, updated_at)
    VALUES ($1, $2, 'kit', $3, $4, NOW(), NOW())
    ON CONFLICT (id) DO NOTHING
  `, [agentRowId, accountId, API_KEY, API_KEY.substring(0, 8)]);

  // 3. Seed user (external_id = 'beaux', account_id, agent_id)
  const userRowId = cloudUserId;
  await db.query(`
    INSERT INTO users (id, account_id, external_id, agent_id, display_name, created_at, updated_at)
    VALUES ($1, $2, $3, $4, 'Beaux Walton', NOW(), NOW())
    ON CONFLICT (id) DO NOTHING
  `, [userRowId, accountId, USER_ID, agentRowId]);

  console.log('Seeded account + agent + user. Starting memory sync...\n');

  let inserted = 0, skipped = 0, page = 0;
  const seenAgents = new Set([agentRowId]);

  while (true) {
    const offset = page * PAGE_SIZE;
    const res = await apiGet(`/v1/memories?limit=${PAGE_SIZE}&offset=${offset}`);
    const memories = res.memories || [];
    if (memories.length === 0) break;

    for (const m of memories) {
      // Ensure agent row exists for any new agentId
      if (m.agentId && !seenAgents.has(m.agentId)) {
        await db.query(`
          INSERT INTO agents (id, account_id, name, api_key_hash, api_key_hint, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, NOW(), NOW()) ON CONFLICT (id) DO NOTHING
        `, [m.agentId, accountId, m.agentId, m.agentId + '_hash', m.agentId.substring(0, 8)]);
        seenAgents.add(m.agentId);
      }

      try {
        await db.query(`
          INSERT INTO memories (
            id, user_id, project_id, session_id, raw, layer, source,
            importance_hint, importance_score, confidence,
            session_position, embedding_id, embedding_model,
            retrieval_count, last_retrieved_at,
            used_count, last_used_at,
            consolidated, consolidated_at,
            superseded_by_id, consolidated_into,
            created_at, updated_at, deleted_at,
            subject_type, subject_id, agent_id,
            memory_type, type_confidence, priority, promoted_from,
            user_pinned, user_hidden, effective_score, score_computed_at,
            safety_critical, durability
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37
          ) ON CONFLICT (id) DO NOTHING
        `, [
          m.id,
          m.userId,
          null, // skip project FK for now
          null, // skip session FK for now
          m.raw,
          m.layer,
          m.source || 'EXPLICIT_STATEMENT',
          m.importanceHint || null,
          m.importanceScore ?? 0.5,
          m.confidence ?? 1.0,
          m.sessionPosition ?? null,
          m.embeddingId ?? null,
          m.embeddingModel ?? null,
          m.retrievalCount ?? 0,
          m.lastRetrievedAt ?? null,
          m.usedCount ?? 0,
          m.lastUsedAt ?? null,
          m.consolidated ?? false,
          m.consolidatedAt ?? null,
          null, // superseded_by_id - skip self-referential FK
          null, // consolidated_into - skip self-referential FK
          m.createdAt,
          m.updatedAt,
          m.deletedAt ?? null,
          m.subjectType ?? 'USER',
          m.subjectId ?? m.userId,
          m.agentId ?? null,
          m.memoryType ?? null,
          m.typeConfidence ?? null,
          m.priority ?? 3,
          m.promotedFrom ?? null,
          m.userPinned ?? false,
          m.userHidden ?? false,
          m.effectiveScore ?? 0.5,
          m.scoreComputedAt ?? null,
          m.safetyCritical ?? false,
          m.durability ?? 'UNCLASSIFIED'
        ]);
        inserted++;
      } catch(e) {
        skipped++;
        if (skipped <= 5) console.error(`\n  Skip ${m.id}: ${e.message.substring(0,150)}`);
      }
    }

    process.stdout.write(`\r  ${offset + memories.length}/${total} inserted=${inserted} skipped=${skipped}`);
    page++;
    if (memories.length < PAGE_SIZE) break;
    await new Promise(r => setTimeout(r, 50));
  }

  const countRes = await db.query(`SELECT count(*) as c FROM memories WHERE deleted_at IS NULL`);
  console.log(`\n\n✅ Sync complete! Local: ${countRes.rows[0].c} / ${total} cloud memories`);
  await db.end();
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1); });

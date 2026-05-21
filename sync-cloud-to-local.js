/**
 * Sync cloud Engram → local Postgres using raw pg (no Prisma client issues)
 * Direction: PROD (Supabase) → LOCAL
 */
const { Client } = require('pg');

const LOCAL_URL = 'postgresql://beauxwalton@localhost:5432/engram';
const PROD_URL  = 'postgresql://postgres:I8LQDu5EzvVaoRHR@db.sokoclvtxiejsxmpcovv.supabase.co:5432/postgres';

async function getColumns(client, table) {
  const res = await client.query(
    `SELECT column_name, udt_name FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position`,
    [table]
  );
  return res.rows;
}

async function syncTable(src, dst, table, where = '') {
  try {
    const srcCols = await getColumns(src, table);
    const dstColNames = new Set((await getColumns(dst, table)).map(c => c.column_name));

    const common = srcCols.filter(c => dstColNames.has(c.column_name));
    if (common.length === 0) { console.log(`${table}: no common columns, skipping`); return 0; }

    const vectorCols = new Set(common.filter(c => c.udt_name === 'vector').map(c => c.column_name));
    const colNames = common.map(c => c.column_name);

    const countRes = await src.query(`SELECT count(*) as c FROM "${table}" ${where}`);
    const total = parseInt(countRes.rows[0].c);
    console.log(`\n${table}: ${total} rows (${colNames.length} cols)`);
    if (total === 0) return 0;

    const BATCH = 200;
    let copied = 0, errors = 0;

    const selectExpr = colNames.map(c => vectorCols.has(c) ? `"${c}"::text` : `"${c}"`).join(', ');
    const insertCols = colNames.map(c => `"${c}"`).join(', ');

    for (let offset = 0; offset < total; offset += BATCH) {
      const rows = await src.query(
        `SELECT ${selectExpr} FROM "${table}" ${where} ORDER BY created_at OFFSET $1 LIMIT $2`,
        [offset, BATCH]
      );

      for (const row of rows.rows) {
        const placeholders = colNames.map((_, i) => `$${i + 1}`).join(', ');
        const values = colNames.map(c => {
          const v = row[c];
          if (vectorCols.has(c) && v !== null) return v; // already text cast
          return v;
        });

        try {
          await dst.query(
            `INSERT INTO "${table}" (${insertCols}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
            values
          );
          copied++;
        } catch (e) {
          errors++;
          if (errors <= 3) console.error(`  Row error: ${e.message.substring(0, 120)}`);
        }
      }

      if ((offset + BATCH) % 1000 === 0 || offset + BATCH >= total) {
        process.stdout.write(`\r  ${Math.min(offset + BATCH, total)}/${total} copied=${copied} errors=${errors}`);
      }
    }
    console.log(`\n  Done: copied=${copied} errors=${errors}`);
    return copied;
  } catch (e) {
    console.error(`\nFailed ${table}: ${e.message?.substring(0, 300)}`);
    return 0;
  }
}

async function run() {
  const src = new Client(PROD_URL);
  const dst = new Client(LOCAL_URL);

  console.log('Connecting...');
  await src.connect();
  await dst.connect();
  console.log('Connected to both databases.');

  // Enable vector extension for inserts
  await dst.query(`SET search_path TO public`);

  // Sync in dependency order
  await syncTable(src, dst, 'accounts');
  await syncTable(src, dst, 'agents');
  await syncTable(src, dst, 'users');
  await syncTable(src, dst, 'memory_clusters');
  await syncTable(src, dst, 'memories', 'WHERE deleted_at IS NULL');
  await syncTable(src, dst, 'memory_embeddings');

  const local = await dst.query(`SELECT count(*) as c FROM memories WHERE deleted_at IS NULL`);
  console.log('\n✅ Sync complete. Local memory count:', local.rows[0].c);

  await src.end();
  await dst.end();
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1); });

const { Client } = require('pg');

const password = process.argv[2];
const env = process.argv[3] || 'staging';

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log(`Connected to ${env} DB`);

  // Check if role exists
  const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'engram_service'");
  if (exists.rows.length > 0) {
    console.log('Role engram_service already exists — updating password');
    await client.query(`ALTER ROLE engram_service WITH PASSWORD '${password}'`);
  } else {
    console.log('Creating engram_service role...');
    await client.query(`CREATE ROLE engram_service LOGIN PASSWORD '${password}' BYPASSRLS`);
  }

  // Ensure BYPASSRLS is set
  await client.query(`ALTER ROLE engram_service WITH BYPASSRLS`);

  // Grant permissions
  await client.query(`GRANT CONNECT ON DATABASE engram TO engram_service`);
  await client.query(`GRANT USAGE ON SCHEMA public TO engram_service`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO engram_service`);
  await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO engram_service`);
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO engram_service`);
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO engram_service`);

  // Verify
  const verify = await client.query("SELECT rolname, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'engram_service'");
  console.log('Role verified:', verify.rows[0]);

  await client.end();
  console.log('Done.');
}

main().catch(e => { console.error(e.message); process.exit(1); });

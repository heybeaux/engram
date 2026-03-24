/**
 * Cleanup script — deletes all benchmark memories from Engram
 * Reads benchmark-data.json and deletes by stored IDs
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

const ENGRAM_BASE = 'http://localhost:3001';
const API_KEY = 'engram_gv9r6c4vesomlekojvkne';
const USER_ID = 'Beaux';
const DATA_FILE = path.join(__dirname, '../benchmark-data.json');
const DELAY_MS = 100;

const headers = {
  'X-AM-API-Key': API_KEY,
  'X-AM-User-ID': USER_ID,
  'Content-Type': 'application/json',
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function deleteMemory(id: string): Promise<boolean> {
  try {
    await axios.delete(`${ENGRAM_BASE}/v1/memories/${id}`, { headers });
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ Failed to delete ${id}: ${msg}`);
    return false;
  }
}

async function main() {
  console.log('🧹 Engram Benchmark Cleanup');
  console.log('============================');

  if (!fs.existsSync(DATA_FILE)) {
    console.error(`❌ benchmark-data.json not found at ${DATA_FILE}`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  const campaigns = data.campaigns || [];

  const ids: string[] = [];
  for (const c of campaigns) {
    if (c.formatAId) ids.push(c.formatAId);
    if (c.formatBId) ids.push(c.formatBId);
  }

  console.log(`Found ${ids.length} memory IDs to delete...`);

  let deleted = 0;
  for (const id of ids) {
    process.stdout.write(`  Deleting ${id.slice(0, 8)}...`);
    const ok = await deleteMemory(id);
    if (ok) { deleted++; process.stdout.write(' ✓\n'); }
    await sleep(DELAY_MS);
  }

  console.log(`\n✅ Deleted ${deleted}/${ids.length} benchmark memories`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

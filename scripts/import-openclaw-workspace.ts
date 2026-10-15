import { readdir, readFile, lstat } from 'node:fs/promises';
import { join, relative, resolve, basename } from 'node:path';

function eligiblePath(path: string): boolean {
  return /(?:^|\/)(?:workspace\/)?(?:MEMORY|DELEGATION)\.md$/.test(path) ||
    /(?:^|\/)workspace\/memory\/[^/]+\.md$/.test(path) ||
    /(?:^|\/)exports\/[^/]+\.md$/.test(path);
}

async function listMarkdownFiles(root: string, dir = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listMarkdownFiles(root, path));
    else if (entry.isFile() && eligiblePath(relative(root, path).split('\\').join('/'))) files.push(path);
  }
  return files.sort();
}

async function main() {
  if (process.env.ENABLE_WORKSPACE_FILE_IMPORT !== 'true') throw new Error('Import flag is off');
  const options = Object.fromEntries(process.argv.slice(2).map((argument) => {
    const match = argument.match(/^--(root|cutoff|api-url|user-id)=(.+)$/);
    if (!match) throw new Error('Expected --root, --cutoff, --api-url, or --user-id');
    return [match[1], match[2]];
  }));
  if (!options.root || !options.cutoff || !options['api-url'] || !options['user-id']) {
    throw new Error('Required: --root, --cutoff, --api-url, --user-id');
  }
  const databaseUrl = new URL(process.env.DATABASE_URL || 'postgresql://invalid/invalid');
  const apiUrl = new URL(options['api-url']);
  if (!['localhost', '127.0.0.1'].includes(databaseUrl.hostname) ||
      !/^\/engram_(?:dev|eval)[a-z0-9_-]*$/.test(databaseUrl.pathname) ||
      !['localhost', '127.0.0.1'].includes(apiUrl.hostname) ||
      apiUrl.port === '47291' || apiUrl.protocol !== 'http:') {
    throw new Error('Only a local throwaway engram_dev*/engram_eval* DB and private local API are allowed');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.cutoff) ||
      Number.isNaN(Date.parse(`${options.cutoff}T00:00:00Z`))) throw new Error('Invalid cutoff');
  const apiKey = process.env.ENGRAM_IMPORT_API_KEY;
  if (!apiKey) throw new Error('ENGRAM_IMPORT_API_KEY is required');
  const root = resolve(options.root);
  let total = 0;
  for (const path of await listMarkdownFiles(root)) {
    const nameDate = basename(path).match(/(?:^|[^\d])(\d{4}-\d{2}-\d{2})(?:[^\d]|$)/)?.[1];
    const fileDate = nameDate ?? (await lstat(path)).mtime.toISOString().slice(0, 10);
    const response = await fetch(new URL('/v1/memories/bulk/workspace-file', apiUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-am-api-key': apiKey,
        'x-am-user-id': options['user-id'],
      },
      body: JSON.stringify({
        path: relative(root, path).split('\\').join('/'),
        text: await readFile(path, 'utf8'),
        fileDate,
        cutoff: options.cutoff,
      }),
    });
    if (!response.ok) throw new Error(`Workspace import failed: HTTP ${response.status}`);
    const result = await response.json() as { created: number };
    total += result.created;
  }
  console.log(`Created ${total} workspace chunks`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

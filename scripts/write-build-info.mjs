#!/usr/bin/env node
// Writes dist/build-info.json so /v1/health can report which commit dist was
// built from (see src/health/build-info.ts). Never fails the build: missing git
// (e.g. Docker, where .git is ignored) just records gitSha: null.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const SHA_RE = /^[0-9a-f]{7,40}$/i;

function gitSha() {
  for (const name of ['ENGRAM_GIT_SHA', 'RAILWAY_GIT_COMMIT_SHA', 'SOURCE_COMMIT']) {
    const v = process.env[name]?.trim();
    if (v && SHA_RE.test(v)) return v.toLowerCase();
  }
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return SHA_RE.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

try {
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
  const info = { version, gitSha: gitSha(), builtAt: new Date().toISOString() };
  mkdirSync('dist', { recursive: true });
  writeFileSync('dist/build-info.json', JSON.stringify(info, null, 2) + '\n');
  console.log(`build-info: ${info.version} ${info.gitSha ?? '(no sha)'}`);
} catch (err) {
  console.warn(`build-info: skipped (${err instanceof Error ? err.message : err})`);
}

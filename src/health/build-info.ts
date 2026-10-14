import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface BuildInfo {
  version: string | null;
  gitSha: string | null;
  builtAt: string | null;
}

/**
 * Env vars checked for the deployed commit, in priority order.
 * RAILWAY_GIT_COMMIT_SHA is injected by Railway on GitHub-triggered deploys;
 * ENGRAM_GIT_SHA lets any other deploy (Docker, LaunchAgent) set it explicitly.
 */
export const GIT_SHA_ENV_VARS = [
  'ENGRAM_GIT_SHA',
  'RAILWAY_GIT_COMMIT_SHA',
  'SOURCE_COMMIT',
] as const;

const SHA_RE = /^[0-9a-f]{7,40}$/i;

function readJson(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function asSha(value: unknown): string | null {
  return typeof value === 'string' && SHA_RE.test(value.trim())
    ? value.trim().toLowerCase()
    : null;
}

/**
 * Resolve what code this process is running. Never runs git at request time:
 * the checkout HEAD can differ from what dist was built from, which is exactly
 * the drift this field exists to expose.
 *
 * - version: package.json next to dist/ (or src/ under ts-jest)
 * - gitSha: env var first, then dist/build-info.json written at build time
 */
export function resolveBuildInfo(
  env: NodeJS.ProcessEnv = process.env,
  baseDir: string = join(__dirname, '..'),
): BuildInfo {
  const pkg = readJson(join(baseDir, '..', 'package.json'));
  const stamp = readJson(join(baseDir, 'build-info.json'));

  const version =
    typeof pkg?.version === 'string'
      ? pkg.version
      : typeof stamp?.version === 'string'
        ? stamp.version
        : null;

  const gitSha =
    GIT_SHA_ENV_VARS.map((name) => asSha(env[name])).find(Boolean) ??
    asSha(stamp?.gitSha);

  const builtAt =
    typeof stamp?.builtAt === 'string' && !isNaN(Date.parse(stamp.builtAt))
      ? stamp.builtAt
      : null;

  return { version, gitSha, builtAt };
}

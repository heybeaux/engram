import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveBuildInfo } from './build-info';

describe('resolveBuildInfo', () => {
  let root: string;
  let dist: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'build-info-'));
    dist = join(root, 'dist');
    mkdirSync(dist);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ version: '1.5.0' }),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const stamp = (info: Record<string, unknown>) =>
    writeFileSync(join(dist, 'build-info.json'), JSON.stringify(info));

  it('reads version from package.json and nulls when nothing else is known', () => {
    expect(resolveBuildInfo({}, dist)).toEqual({
      version: '1.5.0',
      gitSha: null,
      builtAt: null,
    });
  });

  it('prefers an env SHA over the build stamp', () => {
    stamp({ gitSha: 'a'.repeat(40), builtAt: '2026-10-13T00:00:00.000Z' });

    const info = resolveBuildInfo(
      { RAILWAY_GIT_COMMIT_SHA: 'B'.repeat(40) },
      dist,
    );

    expect(info.gitSha).toBe('b'.repeat(40));
    expect(info.builtAt).toBe('2026-10-13T00:00:00.000Z');
  });

  it('checks ENGRAM_GIT_SHA before RAILWAY_GIT_COMMIT_SHA', () => {
    const info = resolveBuildInfo(
      { ENGRAM_GIT_SHA: 'ef4e30f', RAILWAY_GIT_COMMIT_SHA: 'c'.repeat(40) },
      dist,
    );

    expect(info.gitSha).toBe('ef4e30f');
  });

  it('falls back to the build stamp SHA when no env var is set', () => {
    stamp({ gitSha: '0bebe49aaaa', builtAt: '2026-07-04T12:00:00.000Z' });

    expect(resolveBuildInfo({}, dist)).toEqual({
      version: '1.5.0',
      gitSha: '0bebe49aaaa',
      builtAt: '2026-07-04T12:00:00.000Z',
    });
  });

  it('rejects values that are not hex SHAs instead of echoing them', () => {
    stamp({ gitSha: 'not-a-sha', builtAt: 'yesterday' });

    const info = resolveBuildInfo(
      { ENGRAM_GIT_SHA: '<script>', RAILWAY_GIT_COMMIT_SHA: '' },
      dist,
    );

    expect(info.gitSha).toBeNull();
    expect(info.builtAt).toBeNull();
  });

  it('tolerates a corrupt build stamp', () => {
    writeFileSync(join(dist, 'build-info.json'), '{not json');

    expect(resolveBuildInfo({}, dist).gitSha).toBeNull();
  });

  it('resolves the real package.json version by default', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { version } = require('../../package.json');
    expect(resolveBuildInfo({}).version).toBe(version);
  });
});

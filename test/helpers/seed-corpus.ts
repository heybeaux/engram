/**
 * Seed Corpus — deterministic test fixtures loader.
 *
 * STUB: Full corpus fixture file will be added in ENG-21.
 *
 * This module will load a JSON fixture of pre-defined memories and insert them
 * into the test database so that recall evaluation tests have a stable baseline.
 *
 * Current behaviour: logs a warning and inserts a minimal set of synthetic
 * fixtures so that tests that depend on this module can still run.
 */

import { Logger } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';

const logger = new Logger('SeedCorpus');

export interface CorpusMemory {
  raw: string;
  layer?: string;
  tags?: string[];
}

/** Minimal stub fixtures — replace with real JSON import in ENG-21 */
const STUB_FIXTURES: CorpusMemory[] = [
  { raw: 'The user prefers dark mode in all applications.', layer: 'IDENTITY' },
  { raw: 'Project deadline is end of Q2 2026.', layer: 'PROJECT' },
  { raw: 'The user takes Vyvanse every morning.', layer: 'IDENTITY' },
  { raw: 'Favourite coffee is a large dairy latte.', layer: 'IDENTITY' },
  {
    raw: 'The user lives in Powell River, British Columbia.',
    layer: 'IDENTITY',
  },
];

export interface SeedCorpusOptions {
  /** Prisma internal user ID to associate memories with */
  internalUserId: string;
  /** Override fixtures (defaults to STUB_FIXTURES) */
  fixtures?: CorpusMemory[];
}

/**
 * Seed the test DB with a deterministic corpus of memories.
 *
 * @returns Array of created memory IDs
 */
export async function seedCorpus(
  prisma: PrismaService,
  options: SeedCorpusOptions,
): Promise<string[]> {
  const fixtures = options.fixtures ?? STUB_FIXTURES;

  logger.warn(
    `[ENG-21 STUB] Seeding ${fixtures.length} stub fixtures for userId=${options.internalUserId}. ` +
      'Replace with full corpus fixture in ENG-21.',
  );

  const ids: string[] = [];
  for (const fixture of fixtures) {
    const memory = await prisma.memory.create({
      data: {
        raw: fixture.raw,
        userId: options.internalUserId,
        layer: (fixture.layer as any) ?? 'SESSION',
      },
    });
    ids.push(memory.id);
  }

  return ids;
}

/**
 * Remove all memories created by seedCorpus for a given user.
 */
export async function cleanCorpus(
  prisma: PrismaService,
  internalUserId: string,
): Promise<void> {
  await prisma.memory
    .deleteMany({ where: { userId: internalUserId } })
    .catch(() => {});
}

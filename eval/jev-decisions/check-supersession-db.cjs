// Run only against an isolated PostgreSQL instance and a throwaway database.
const assert = require('node:assert/strict');
const path = require('node:path');

const url = new URL(process.env.DATABASE_URL || 'postgresql://invalid/invalid');
if (
  !['127.0.0.1', 'localhost'].includes(url.hostname) ||
  url.pathname !== '/eng122test' ||
  !url.port ||
  url.port === '5432' ||
  process.env.ENG122_THROWAWAY_DB !== '1'
) {
  throw new Error('Refusing to run outside the isolated ENG-122 test database');
}

require('ts-node/register/transpile-only');
const root = path.resolve(__dirname, '../..');
const { ServicePrismaService } = require(
  path.join(root, 'src/prisma/service-prisma.service'),
);
const { PrismaService } = require(path.join(root, 'src/prisma/prisma.service'));
const { DedupResolutionService } = require(
  path.join(root, 'src/deduplication/automated/dedup-resolution.service'),
);
const { LineageService } = require(
  path.join(root, 'src/deduplication/lineage.service'),
);

async function main() {
  const service = new ServicePrismaService();
  const prisma = new PrismaService();
  await Promise.all([service.$connect(), prisma.$connect()]);
  try {
    const account = await service.account.create({
      data: {
        email: 'eng122-test@example.invalid',
        passwordHash: 'synthetic-test-only',
      },
    });
    const user = await service.user.create({
      data: { accountId: account.id, externalId: 'eng122-test' },
    });
    const older = await service.memory.create({
      data: {
        userId: user.id,
        raw: 'Avery works at Northwood.',
        layer: 'PROJECT',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    });
    const newer = await service.memory.create({
      data: {
        userId: user.id,
        raw: 'Avery now works at Eastport.',
        layer: 'PROJECT',
        createdAt: new Date('2026-02-01T00:00:00Z'),
      },
    });
    const pair = await service.dedupCandidate.create({
      data: {
        memoryId1: older.id,
        memoryId2: newer.id,
        detectionMethod: 'TEXT',
        similarityScore: 0.9,
        classification: 'SUPERSEDES',
        confidence: 0.95,
        status: 'CLASSIFIED',
      },
    });

    const resolver = new DedupResolutionService(service, {});
    delete process.env.DEDUP_SUPERSESSION_ENABLED;
    const off = await resolver.processClassifiedCandidates(user.id);
    assert.equal(off.autoSuperseded, 0);
    assert.equal(off.queued, 1);
    assert.equal(
      (await service.memory.findUnique({ where: { id: older.id } }))
        .supersededById,
      null,
    );
    assert.equal(await service.memoryMergeEvent.count(), 0);

    await service.dedupCandidate.update({
      where: { id: pair.id },
      data: { status: 'CLASSIFIED' },
    });
    process.env.DEDUP_SUPERSESSION_ENABLED = 'true';
    const on = await resolver.processClassifiedCandidates(user.id);
    assert.equal(on.autoSuperseded, 1);
    assert.equal(on.errors, 0);
    const linked = await service.memory.findUnique({ where: { id: older.id } });
    assert.equal(linked.raw, older.raw);
    assert.equal(linked.deletedAt, null);
    assert.equal(linked.supersededById, newer.id);
    assert.ok(linked.supersededAt);
    assert.equal(
      (await service.memory.findUnique({ where: { id: newer.id } })).raw,
      newer.raw,
    );
    const events = await service.memoryMergeEvent.findMany();
    assert.equal(events.length, 1);
    assert.equal(events[0].strategy, 'SUPERSEDE');
    assert.equal(events[0].canRollback, true);
    assert.deepEqual(events[0].absorbedMemoryIds, [older.id]);

    const lineage = new LineageService(prisma, {});
    const rollback = await lineage.rollbackMerge(events[0].id);
    assert.equal(rollback.success, true);
    assert.deepEqual(rollback.restoredMemoryIds, [older.id]);
    const restored = await service.memory.findUnique({
      where: { id: older.id },
    });
    assert.equal(restored.raw, older.raw);
    assert.equal(restored.deletedAt, null);
    assert.equal(restored.supersededById, null);
    assert.equal(restored.supersededAt, null);
    const event = await service.memoryMergeEvent.findUnique({
      where: { id: events[0].id },
    });
    assert.equal(event.canRollback, false);
    assert.ok(event.rolledBackAt);
    await assert.rejects(
      () => lineage.rollbackMerge(events[0].id),
      /cannot be rolled back/,
    );
    console.log(
      'PASS: flag off queued without row changes; flag on preserved both rows and linked older to newer; rollback restored link and prevented duplicate rollback.',
    );
  } finally {
    delete process.env.DEDUP_SUPERSESSION_ENABLED;
    await Promise.all([service.$disconnect(), prisma.$disconnect()]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

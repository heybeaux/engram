import { DreamCycleConsolidationStage } from './dream-cycle-consolidation.stage';
import { DreamCycleTieringStage } from './dream-cycle-tiering.stage';
import { DreamCycleArchivalStage } from './dream-cycle-archival.stage';
import { EmbeddingWriteService } from '../../vector/embedding-write.service';
import { MemoryDedupService } from '../../memory/memory-dedup.service';

const config = { get: () => undefined };

describe('audit preservation regressions', () => {
  it.each([0.99, 0.88])(
    'preserves corrected facts at similarity %s',
    async (score) => {
      const prisma = {
        memory: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'old',
            userId: 'u',
            raw: 'Deadline September 12',
            searchable: true,
          }),
        },
        mergeCandidate: { create: jest.fn() },
      };
      const service = new MemoryDedupService(
        prisma as any,
        {
          generate: async () => [1],
          search: async () => [{ id: 'old', score }],
        } as any,
      );
      expect(
        await service.findDuplicateV2('u', 'Deadline September 13'),
      ).toEqual({ action: 'create' });
    },
  );

  it('processes all 501 eligible records, even when first 500 are unchanged', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => ({
      id: `m${String(i).padStart(4, '0')}`,
      tier: 'HOT',
      userPinned: true,
      createdAt: new Date(),
      lastRetrievedAt: null,
      retrievalCount: 0,
    }));
    const findMany = jest
      .fn()
      .mockResolvedValueOnce(rows.slice(0, 500))
      .mockResolvedValueOnce(rows.slice(500));
    const stage = new DreamCycleTieringStage(
      { memory: { findMany } } as any,
      config as any,
    );
    expect((await stage.run('u', true)).unchanged).toBe(501);
    expect(findMany.mock.calls[1][0].where).toMatchObject({
      id: { gt: 'm0499' },
      searchable: true,
      supersededById: null,
      OR: [{ tier: null }, { tier: { not: 'ARCHIVED' } }],
    });
  });

  it('rechecks pin, age and access guards at archival update and reports actual writes', async () => {
    const findMany = jest
      .fn()
      .mockResolvedValue([{ id: 'm', layer: 'SESSION', usedCount: 0 }]);
    const updateMany = jest.fn().mockResolvedValue({ count: 0 }); // pinned after selection
    const stage = new DreamCycleArchivalStage(
      { memory: { findMany, updateMany } } as any,
      config as any,
    );
    expect((await stage.run('u', false)).archived).toBe(0);
    const selection = findMany.mock.calls[0][0].where;
    expect(selection).toMatchObject({
      userPinned: false,
      createdAt: { lt: expect.any(Date) },
      AND: [
        {
          OR: [
            { lastRetrievedAt: null },
            { lastRetrievedAt: { lt: expect.any(Date) } },
          ],
        },
        {
          OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: expect.any(Date) } }],
        },
      ],
    });
    expect(updateMany.mock.calls[0][0].where).toEqual({
      ...selection,
      id: { in: ['m'] },
    });
  });

  it('rejects zero-row model writes and never uses a separate connection when given a transaction', async () => {
    const external = {
      $executeRawUnsafe: jest.fn(),
      $queryRawUnsafe: jest.fn(),
    };
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ exists: 1 }]),
      $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    };
    const writer = new EmbeddingWriteService(external as any);
    await expect(
      writer.writeMemoryEmbedding(
        'new',
        'openai-small',
        Array(1536).fill(0.1),
        false,
        tx as any,
      ),
    ).rejects.toThrow('Expected one model row');
    expect(external.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(external.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('keeps source retrieval and provenance intact after publishing a lossy summary', async () => {
    const tx = {
      memory: {
        create: jest.fn().mockResolvedValue({ id: 'new' }),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    const writeMemoryEmbedding = jest.fn();
    const stage = new DreamCycleConsolidationStage(
      { $transaction: (fn: any) => fn(tx) } as any,
      config as any,
      { embed: async () => [[0.1]] } as any,
      { chat: async () => ({ content: 'Incomplete summary' }) } as any,
      {
        writeMemoryEmbedding,
        getCurrentModelId: () => 'configured-model',
      } as any,
    );
    await (stage as any).consolidateCluster(
      [{ id: 'source', content: 'Original precise date' }],
      'u',
    );
    expect(writeMemoryEmbedding).toHaveBeenCalledWith(
      'new',
      'configured-model',
      [0.1],
      false,
      tx,
    );
    expect(tx.memory.updateMany.mock.calls[0][0].data).toEqual({
      consolidatedInto: 'new',
      consolidated: true,
    });
  });

  it('does not retire sources on missing embedding', async () => {
    const transaction = jest.fn();
    const stage = new DreamCycleConsolidationStage(
      { $transaction: transaction } as any,
      config as any,
      { embed: async () => [] } as any,
      { chat: async () => ({ content: 'summary' }) } as any,
      {} as any,
    );
    await expect(
      (stage as any).consolidateCluster([{ id: 's', content: 'fact' }], 'u'),
    ).rejects.toThrow('missing');
    expect(transaction).not.toHaveBeenCalled();
  });
});

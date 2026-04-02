import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DreamCycleArchivalStage } from './dream-cycle-archival.stage';
import { ServicePrismaService } from '../../prisma/service-prisma.service';

describe('DreamCycleArchivalStage', () => {
  let stage: DreamCycleArchivalStage;
  let prisma: {
    memory: { findMany: jest.Mock; updateMany: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      memory: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };

    const module = await Test.createTestingModule({
      providers: [
        DreamCycleArchivalStage,
        { provide: ServicePrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(undefined) },
        },
      ],
    }).compile();

    stage = module.get(DreamCycleArchivalStage);
  });

  it('should return zeros when no candidates', async () => {
    const result = await stage.run('user1', false);
    expect(result).toEqual({
      archived: 0,
      skippedProtectedLayer: 0,
      skippedRecentlyRetrieved: 0,
      skippedFrequentlyUsed: 0,
      byLayer: {},
      byType: {},
    });
  });

  it('should archive low importance + old + unretrieved memory', async () => {
    prisma.memory.findMany.mockResolvedValue([
      {
        id: 'm1',
        layer: 'SESSION',
        memoryType: 'EVENT',
        lastRetrievedAt: null,
        usedCount: 0,
      },
    ]);

    const result = await stage.run('user1', false);
    expect(result.archived).toBe(1);
    expect(result.byLayer).toEqual({ SESSION: 1 });
    expect(result.byType).toEqual({ EVENT: 1 });
    expect(prisma.memory.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['m1'] }, userId: 'user1' },
      data: {
        archivedReason: 'low_importance',
        searchable: false,
        lastDreamCycleAt: expect.any(Date),
      },
    });
  });

  it('should never archive IDENTITY layer memories', async () => {
    prisma.memory.findMany.mockResolvedValue([
      {
        id: 'm1',
        layer: 'IDENTITY',
        memoryType: 'FACT',
        lastRetrievedAt: null,
        usedCount: 0,
      },
    ]);

    const result = await stage.run('user1', false);
    expect(result.archived).toBe(0);
    expect(result.skippedProtectedLayer).toBe(1);
    expect(prisma.memory.updateMany).not.toHaveBeenCalled();
  });

  it('should never archive PROJECT layer memories', async () => {
    prisma.memory.findMany.mockResolvedValue([
      {
        id: 'm1',
        layer: 'PROJECT',
        memoryType: 'FACT',
        lastRetrievedAt: null,
        usedCount: 0,
      },
    ]);

    const result = await stage.run('user1', false);
    expect(result.archived).toBe(0);
    expect(result.skippedProtectedLayer).toBe(1);
    expect(prisma.memory.updateMany).not.toHaveBeenCalled();
  });

  it('should not archive recently retrieved memories', async () => {
    const now = new Date();
    prisma.memory.findMany.mockResolvedValue([
      {
        id: 'm1',
        layer: 'SESSION',
        memoryType: 'EVENT',
        lastRetrievedAt: new Date(now.getTime() - 10 * 86_400_000), // 10 days ago
        usedCount: 0,
      },
    ]);

    const result = await stage.run('user1', false);
    expect(result.archived).toBe(0);
    expect(result.skippedRecentlyRetrieved).toBe(1);
    expect(prisma.memory.updateMany).not.toHaveBeenCalled();
  });

  it('should not archive frequently used memories (usedCount > 5)', async () => {
    prisma.memory.findMany.mockResolvedValue([
      {
        id: 'm1',
        layer: 'SESSION',
        memoryType: 'EVENT',
        lastRetrievedAt: null,
        usedCount: 6,
      },
    ]);

    const result = await stage.run('user1', false);
    expect(result.archived).toBe(0);
    expect(result.skippedFrequentlyUsed).toBe(1);
    expect(prisma.memory.updateMany).not.toHaveBeenCalled();
  });

  it('should archive memory with usedCount exactly 5', async () => {
    prisma.memory.findMany.mockResolvedValue([
      {
        id: 'm1',
        layer: 'SESSION',
        memoryType: 'FACT',
        lastRetrievedAt: null,
        usedCount: 5,
      },
    ]);

    const result = await stage.run('user1', false);
    expect(result.archived).toBe(1);
  });

  it('should not archive memory retrieved 29 days ago (within window)', async () => {
    const now = new Date();
    prisma.memory.findMany.mockResolvedValue([
      {
        id: 'm1',
        layer: 'SESSION',
        memoryType: 'EVENT',
        lastRetrievedAt: new Date(now.getTime() - 29 * 86_400_000), // 29 days ago
        usedCount: 0,
      },
    ]);

    const result = await stage.run('user1', false);
    expect(result.skippedRecentlyRetrieved).toBe(1);
    expect(result.archived).toBe(0);
  });

  it('should archive memory retrieved 31 days ago', async () => {
    const now = new Date();
    prisma.memory.findMany.mockResolvedValue([
      {
        id: 'm1',
        layer: 'TASK',
        memoryType: 'TASK',
        lastRetrievedAt: new Date(now.getTime() - 31 * 86_400_000),
        usedCount: 0,
      },
    ]);

    const result = await stage.run('user1', false);
    expect(result.archived).toBe(1);
    expect(result.byLayer).toEqual({ TASK: 1 });
  });

  it('should not update in dryRun mode', async () => {
    prisma.memory.findMany.mockResolvedValue([
      {
        id: 'm1',
        layer: 'SESSION',
        memoryType: 'EVENT',
        lastRetrievedAt: null,
        usedCount: 0,
      },
    ]);

    const result = await stage.run('user1', true);
    expect(result.archived).toBe(1);
    expect(prisma.memory.updateMany).not.toHaveBeenCalled();
  });

  it('should count stats by layer and type for multiple memories', async () => {
    prisma.memory.findMany.mockResolvedValue([
      {
        id: 'm1',
        layer: 'SESSION',
        memoryType: 'EVENT',
        lastRetrievedAt: null,
        usedCount: 0,
      },
      {
        id: 'm2',
        layer: 'SESSION',
        memoryType: 'FACT',
        lastRetrievedAt: null,
        usedCount: 0,
      },
      {
        id: 'm3',
        layer: 'TASK',
        memoryType: 'EVENT',
        lastRetrievedAt: null,
        usedCount: 1,
      },
    ]);

    const result = await stage.run('user1', false);
    expect(result.archived).toBe(3);
    expect(result.byLayer).toEqual({ SESSION: 2, TASK: 1 });
    expect(result.byType).toEqual({ EVENT: 2, FACT: 1 });
  });

  it('should handle mixed archivable and protected memories', async () => {
    const now = new Date();
    prisma.memory.findMany.mockResolvedValue([
      {
        id: 'm1',
        layer: 'SESSION',
        memoryType: 'EVENT',
        lastRetrievedAt: null,
        usedCount: 0,
      },
      {
        id: 'm2',
        layer: 'IDENTITY',
        memoryType: 'CONSTRAINT',
        lastRetrievedAt: null,
        usedCount: 0,
      },
      {
        id: 'm3',
        layer: 'SESSION',
        memoryType: 'FACT',
        lastRetrievedAt: new Date(now.getTime() - 5 * 86_400_000),
        usedCount: 0,
      },
      {
        id: 'm4',
        layer: 'TASK',
        memoryType: 'TASK',
        lastRetrievedAt: null,
        usedCount: 10,
      },
    ]);

    const result = await stage.run('user1', false);
    expect(result.archived).toBe(1);
    expect(result.skippedProtectedLayer).toBe(1);
    expect(result.skippedRecentlyRetrieved).toBe(1);
    expect(result.skippedFrequentlyUsed).toBe(1);
    expect(prisma.memory.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['m1'] }, userId: 'user1' },
      data: expect.objectContaining({ archivedReason: 'low_importance' }),
    });
  });
});

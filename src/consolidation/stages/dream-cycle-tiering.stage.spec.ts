import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DreamCycleTieringStage } from './dream-cycle-tiering.stage';
import { ServicePrismaService } from '../../prisma/service-prisma.service';

describe('DreamCycleTieringStage', () => {
  let stage: DreamCycleTieringStage;
  let prisma: { memory: { findMany: jest.Mock; update: jest.Mock } };

  beforeEach(async () => {
    prisma = {
      memory: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    const module = await Test.createTestingModule({
      providers: [
        DreamCycleTieringStage,
        { provide: ServicePrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(undefined) },
        },
      ],
    }).compile();

    stage = module.get(DreamCycleTieringStage);
  });

  it('should return zeros when no memories', async () => {
    const result = await stage.run('user1', false);
    expect(result).toEqual({ promoted: 0, demoted: 0, unchanged: 0 });
  });

  it('should tier pinned memory as HOT', async () => {
    prisma.memory.findMany.mockResolvedValue([
      {
        id: 'm1',
        tier: 'COLD',
        userPinned: true,
        createdAt: new Date('2020-01-01'),
        lastRetrievedAt: null,
        retrievalCount: 0,
      },
    ]);

    const result = await stage.run('user1', false);
    expect(result.promoted).toBe(1);
    expect(prisma.memory.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { tier: 'HOT' },
    });
  });

  it('should tier recently created memory as HOT', async () => {
    const now = new Date();
    prisma.memory.findMany.mockResolvedValue([
      {
        id: 'm1',
        tier: 'WARM',
        userPinned: false,
        createdAt: new Date(now.getTime() - 24 * 3600 * 1000), // 24h ago
        lastRetrievedAt: null,
        retrievalCount: 0,
      },
    ]);

    const result = await stage.run('user1', false);
    expect(result.promoted).toBe(1);
  });

  it('should tier recently accessed memory as HOT', async () => {
    const now = new Date();
    prisma.memory.findMany.mockResolvedValue([
      {
        id: 'm1',
        tier: 'COLD',
        userPinned: false,
        createdAt: new Date('2020-01-01'),
        lastRetrievedAt: new Date(now.getTime() - 3 * 86_400_000), // 3 days ago
        retrievalCount: 1,
      },
    ]);

    const result = await stage.run('user1', false);
    expect(result.promoted).toBe(1);
    expect(prisma.memory.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { tier: 'HOT' },
    });
  });

  it('should tier frequently retrieved memory as WARM', async () => {
    const now = new Date();
    prisma.memory.findMany.mockResolvedValue([
      {
        id: 'm1',
        tier: 'COLD',
        userPinned: false,
        createdAt: new Date('2020-01-01'),
        lastRetrievedAt: new Date(now.getTime() - 60 * 86_400_000), // 60 days ago
        retrievalCount: 5,
      },
    ]);

    const result = await stage.run('user1', false);
    expect(result.promoted).toBe(1);
    expect(prisma.memory.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { tier: 'WARM' },
    });
  });

  it('should tier old unused memory as COLD', async () => {
    const now = new Date();
    prisma.memory.findMany.mockResolvedValue([
      {
        id: 'm1',
        tier: 'HOT',
        userPinned: false,
        createdAt: new Date(now.getTime() - 120 * 86_400_000), // 120 days ago
        lastRetrievedAt: new Date(now.getTime() - 60 * 86_400_000), // 60 days ago
        retrievalCount: 1,
      },
    ]);

    const result = await stage.run('user1', false);
    expect(result.demoted).toBe(1);
    expect(prisma.memory.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { tier: 'COLD' },
    });
  });

  it('should not update in dryRun mode', async () => {
    prisma.memory.findMany.mockResolvedValue([
      {
        id: 'm1',
        tier: 'COLD',
        userPinned: true,
        createdAt: new Date('2020-01-01'),
        lastRetrievedAt: null,
        retrievalCount: 0,
      },
    ]);

    const result = await stage.run('user1', true);
    expect(result.promoted).toBe(1);
    expect(prisma.memory.update).not.toHaveBeenCalled();
  });

  it('should count unchanged memories', async () => {
    prisma.memory.findMany.mockResolvedValue([
      {
        id: 'm1',
        tier: 'HOT',
        userPinned: true,
        createdAt: new Date('2020-01-01'),
        lastRetrievedAt: null,
        retrievalCount: 0,
      },
    ]);

    const result = await stage.run('user1', false);
    expect(result.unchanged).toBe(1);
    expect(prisma.memory.update).not.toHaveBeenCalled();
  });

  it('should default null tier to WARM for comparison', async () => {
    const now = new Date();
    prisma.memory.findMany.mockResolvedValue([
      {
        id: 'm1',
        tier: null,
        userPinned: false,
        createdAt: new Date(now.getTime() - 120 * 86_400_000),
        lastRetrievedAt: new Date(now.getTime() - 60 * 86_400_000),
        retrievalCount: 1,
      },
    ]);

    const result = await stage.run('user1', false);
    // null defaults to WARM, calculated is COLD → demoted
    expect(result.demoted).toBe(1);
  });
});

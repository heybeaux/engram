import { Test, TestingModule } from '@nestjs/testing';
import { CapabilityDeltaService } from './capability-delta.service';
import { PrismaService } from '../prisma/prisma.service';

const mockPrisma = {
  trustSignal: { findMany: jest.fn() },
  capabilityCheckpoint: {
    create: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
  },
};

describe('CapabilityDeltaService', () => {
  let service: CapabilityDeltaService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CapabilityDeltaService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get<CapabilityDeltaService>(CapabilityDeltaService);
  });

  describe('createCheckpoint', () => {
    it('should aggregate signals and create checkpoint', async () => {
      const now = new Date();
      const earlier = new Date(now.getTime() - 86400000);
      mockPrisma.trustSignal.findMany.mockResolvedValue([
        { category: 'coding', createdAt: earlier },
        { category: 'coding', createdAt: now },
        { category: 'coding', createdAt: now },
        { category: 'deploy', createdAt: now },
      ]);
      mockPrisma.capabilityCheckpoint.create.mockResolvedValue({});

      const result = await service.createCheckpoint('user1');

      // coding has 3 signals (>= MIN_EVIDENCE=2), deploy has 1 (filtered out)
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('coding');
      expect(result[0].evidenceCount).toBe(3);
      expect(mockPrisma.capabilityCheckpoint.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ userId: 'user1' }),
      });
    });

    it('should filter by agentId when provided', async () => {
      mockPrisma.trustSignal.findMany.mockResolvedValue([]);
      mockPrisma.capabilityCheckpoint.create.mockResolvedValue({});

      await service.createCheckpoint('user1', { agentId: 'agent1' });

      expect(mockPrisma.trustSignal.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ agentId: 'agent1' }),
        }),
      );
    });

    it('should return empty when no signals meet threshold', async () => {
      mockPrisma.trustSignal.findMany.mockResolvedValue([
        { category: 'coding', createdAt: new Date() },
      ]);
      mockPrisma.capabilityCheckpoint.create.mockResolvedValue({});

      const result = await service.createCheckpoint('user1');
      expect(result).toHaveLength(0);
    });

    it('should skip signals with null category', async () => {
      mockPrisma.trustSignal.findMany.mockResolvedValue([
        { category: null, createdAt: new Date() },
        { category: null, createdAt: new Date() },
      ]);
      mockPrisma.capabilityCheckpoint.create.mockResolvedValue({});

      const result = await service.createCheckpoint('user1');
      expect(result).toHaveLength(0);
    });
  });

  describe('computeDelta', () => {
    it('should return empty when no checkpoints', async () => {
      mockPrisma.capabilityCheckpoint.findMany.mockResolvedValue([]);
      const delta = await service.computeDelta('user1');
      expect(delta.gained).toEqual([]);
      expect(delta.improved).toEqual([]);
    });

    it('should treat all as gained when only one checkpoint', async () => {
      const caps = [
        { name: 'coding', evidenceCount: 5, firstSeen: 'a', lastSeen: 'b' },
      ];
      mockPrisma.capabilityCheckpoint.findMany.mockResolvedValue([
        { checkpointAt: new Date(), capabilities: caps },
      ]);

      const delta = await service.computeDelta('user1');
      expect(delta.gained).toEqual(caps);
      expect(delta.improved).toEqual([]);
    });

    it('should detect gained and improved capabilities', async () => {
      const now = new Date();
      const prev = new Date(now.getTime() - 86400000);
      mockPrisma.capabilityCheckpoint.findMany.mockResolvedValue([
        {
          checkpointAt: now,
          capabilities: [
            {
              name: 'coding',
              evidenceCount: 10,
              firstSeen: 'a',
              lastSeen: 'b',
            },
            { name: 'deploy', evidenceCount: 3, firstSeen: 'a', lastSeen: 'b' },
          ],
        },
        {
          checkpointAt: prev,
          capabilities: [
            { name: 'coding', evidenceCount: 5, firstSeen: 'a', lastSeen: 'b' },
          ],
        },
      ]);

      const delta = await service.computeDelta('user1');
      expect(delta.gained).toHaveLength(1);
      expect(delta.gained[0].name).toBe('deploy');
      expect(delta.improved).toHaveLength(1);
      expect(delta.improved[0]).toEqual({
        name: 'coding',
        previousCount: 5,
        currentCount: 10,
      });
    });
  });

  describe('getLatestCapabilities', () => {
    it('should return empty when no checkpoints', async () => {
      mockPrisma.capabilityCheckpoint.findFirst.mockResolvedValue(null);
      expect(await service.getLatestCapabilities('user1')).toEqual([]);
    });

    it('should return capabilities from latest checkpoint', async () => {
      const caps = [{ name: 'coding', evidenceCount: 5 }];
      mockPrisma.capabilityCheckpoint.findFirst.mockResolvedValue({
        capabilities: caps,
      });
      expect(await service.getLatestCapabilities('user1')).toEqual(caps);
    });
  });
});

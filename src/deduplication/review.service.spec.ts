import { Test, TestingModule } from '@nestjs/testing';
import { ReviewService } from './review.service';
import { PrismaService } from '../prisma/prisma.service';
import { MergeService } from './merge.service';
import { LineageService } from './lineage.service';
import { SafetyService } from './safety.service';
import { MergeStrategy, CandidateStatus } from './dto/deduplication.dto';
import { MemoryType } from '@prisma/client';

describe('ReviewService', () => {
  let service: ReviewService;
  let prismaService: jest.Mocked<PrismaService>;
  let mergeService: jest.Mocked<MergeService>;
  let lineageService: jest.Mocked<LineageService>;
  let safetyService: jest.Mocked<SafetyService>;

  const mockPrisma = {
    user: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([{ id: 'user_123' }]),
    },
    memory: {
      findMany: jest.fn(),
    },
    mergeCandidate: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
  };

  const mockMerge = {
    merge: jest.fn(),
    getDefaultStrategy: jest.fn().mockReturnValue(MergeStrategy.KEEP_DETAILED),
    computeDetailScore: jest.fn().mockReturnValue(50),
  };

  const mockLineage = {
    recordMerge: jest.fn(),
  };

  const mockSafety = {
    checkMemorySafety: jest.fn(),
    checkMultipleSafety: jest.fn(),
  };

  const createMockMemory = (id: string, raw: string = 'Content') => ({
    id,
    raw,
    memoryType: MemoryType.FACT,
    createdAt: new Date(),
    importanceScore: 0.5,
  });

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: MergeService, useValue: mockMerge },
        { provide: LineageService, useValue: mockLineage },
        { provide: SafetyService, useValue: mockSafety },
      ],
    }).compile();

    service = module.get<ReviewService>(ReviewService);
    prismaService = module.get(PrismaService);
    mergeService = module.get(MergeService);
    lineageService = module.get(LineageService);
    safetyService = module.get(SafetyService);
  });

  describe('queuePairForReview', () => {
    it('should create a merge candidate', async () => {
      mockSafety.checkMemorySafety.mockResolvedValue({
        memoryId: 'mem_1',
        isProtected: false,
        canAutoMerge: true,
        requiresReview: false,
        reasons: [],
      });
      mockPrisma.memory.findMany.mockResolvedValue([
        createMockMemory('mem_1'),
        createMockMemory('mem_2'),
      ]);
      mockPrisma.mergeCandidate.findFirst.mockResolvedValue(null);
      mockPrisma.mergeCandidate.create.mockResolvedValue({
        id: 'cand_1',
        userId: 'user_123',
        memoryIds: ['mem_1', 'mem_2'],
        similarity: 0.92,
        suggestedStrategy: MergeStrategy.KEEP_DETAILED,
        suggestedSurvivorId: 'mem_1',
        safetyFlags: '[]',
        status: CandidateStatus.PENDING,
        createdAt: new Date(),
      });

      const result = await service.queuePairForReview(
        'user_123',
        'mem_1',
        'mem_2',
        0.92,
      );

      expect(result.id).toBe('cand_1');
      expect(result.similarity).toBe(0.92);
      expect(mockPrisma.mergeCandidate.create).toHaveBeenCalled();
    });

    it('should return existing candidate if already queued', async () => {
      mockSafety.checkMemorySafety.mockResolvedValue({
        memoryId: 'mem_1',
        isProtected: false,
        canAutoMerge: true,
        requiresReview: false,
        reasons: [],
      });
      mockPrisma.memory.findMany.mockResolvedValue([
        createMockMemory('mem_1'),
        createMockMemory('mem_2'),
      ]);
      mockPrisma.mergeCandidate.findFirst.mockResolvedValue({
        id: 'existing_cand',
        userId: 'user_123',
        memoryIds: ['mem_1', 'mem_2'],
        similarity: 0.92,
        suggestedStrategy: MergeStrategy.KEEP_DETAILED,
        suggestedSurvivorId: 'mem_1',
        safetyFlags: '[]',
        status: CandidateStatus.PENDING,
        createdAt: new Date(),
      });

      const result = await service.queuePairForReview(
        'user_123',
        'mem_1',
        'mem_2',
        0.92,
      );

      expect(result.id).toBe('existing_cand');
      expect(mockPrisma.mergeCandidate.create).not.toHaveBeenCalled();
    });

    it('should include safety flags', async () => {
      mockSafety.checkMemorySafety.mockResolvedValue({
        memoryId: 'mem_1',
        isProtected: true,
        canAutoMerge: false,
        requiresReview: true,
        reasons: [{ type: 'protected_keyword', keyword: 'allergy' }],
      });
      mockPrisma.memory.findMany.mockResolvedValue([
        createMockMemory('mem_1'),
        createMockMemory('mem_2'),
      ]);
      mockPrisma.mergeCandidate.findFirst.mockResolvedValue(null);
      mockPrisma.mergeCandidate.create.mockResolvedValue({
        id: 'cand_1',
        safetyFlags: JSON.stringify([
          { type: 'protected_keyword', keyword: 'allergy' },
        ]),
        status: CandidateStatus.PENDING,
        createdAt: new Date(),
        memoryIds: ['mem_1', 'mem_2'],
        similarity: 0.9,
        suggestedStrategy: MergeStrategy.KEEP_DETAILED,
        suggestedSurvivorId: 'mem_1',
      });

      const result = await service.queuePairForReview(
        'user_123',
        'mem_1',
        'mem_2',
        0.9,
      );

      expect(result.safetyFlags.length).toBeGreaterThan(0);
    });
  });

  describe('getCandidates', () => {
    it('should return paginated candidates', async () => {
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([
        {
          id: 'cand_1',
          memoryIds: ['mem_1', 'mem_2'],
          similarity: 0.95,
          suggestedStrategy: MergeStrategy.KEEP_DETAILED,
          suggestedSurvivorId: 'mem_1',
          safetyFlags: '[]',
          status: CandidateStatus.PENDING,
          createdAt: new Date(),
        },
      ]);
      mockPrisma.mergeCandidate.count
        .mockResolvedValueOnce(1) // total
        .mockResolvedValueOnce(1); // pending
      mockPrisma.memory.findMany.mockResolvedValue([
        createMockMemory('mem_1'),
        createMockMemory('mem_2'),
      ]);

      const result = await service.getCandidates('user_123');

      expect(result.candidates.length).toBe(1);
      expect(result.total).toBe(1);
      expect(result.pendingCount).toBe(1);
    });

    it('should filter by status', async () => {
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([]);
      mockPrisma.mergeCandidate.count.mockResolvedValue(0);
      mockPrisma.memory.findMany.mockResolvedValue([]);

      await service.getCandidates('user_123', {
        status: CandidateStatus.APPROVED,
      });

      expect(mockPrisma.mergeCandidate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: CandidateStatus.APPROVED }),
        }),
      );
    });

    it('should filter by minimum similarity', async () => {
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([]);
      mockPrisma.mergeCandidate.count.mockResolvedValue(0);
      mockPrisma.memory.findMany.mockResolvedValue([]);

      await service.getCandidates('user_123', { minSimilarity: 0.9 });

      expect(mockPrisma.mergeCandidate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ similarity: { gte: 0.9 } }),
        }),
      );
    });
  });

  describe('approve', () => {
    it('should execute merge and update status', async () => {
      mockPrisma.mergeCandidate.findUnique.mockResolvedValue({
        id: 'cand_1',
        userId: 'user_123',
        memoryIds: ['mem_1', 'mem_2'],
        similarity: 0.95,
        suggestedStrategy: MergeStrategy.KEEP_DETAILED,
        suggestedSurvivorId: 'mem_1',
        status: CandidateStatus.PENDING,
      });
      mockMerge.merge.mockResolvedValue({
        survivorId: 'mem_1',
        absorbedIds: ['mem_2'],
        mergedContent: 'Content',
        mergedMetadata: {},
        strategy: MergeStrategy.KEEP_DETAILED,
        contentChanged: false,
      });
      mockLineage.recordMerge.mockResolvedValue({ id: 'event_1' });
      mockPrisma.mergeCandidate.update.mockResolvedValue({});

      const result = await service.approve('cand_1', {}, 'approver_1');

      expect(result.success).toBe(true);
      expect(result.mergeEventId).toBe('event_1');
      expect(mockMerge.merge).toHaveBeenCalled();
      expect(mockPrisma.mergeCandidate.update).toHaveBeenCalledWith({
        where: { id: 'cand_1' },
        data: expect.objectContaining({ status: CandidateStatus.APPROVED }),
      });
    });

    it('should use override strategy when provided', async () => {
      mockPrisma.mergeCandidate.findUnique.mockResolvedValue({
        id: 'cand_1',
        userId: 'user_123',
        memoryIds: ['mem_1', 'mem_2'],
        similarity: 0.95,
        suggestedStrategy: MergeStrategy.KEEP_DETAILED,
        suggestedSurvivorId: 'mem_1',
        status: CandidateStatus.PENDING,
      });
      mockMerge.merge.mockResolvedValue({
        survivorId: 'mem_2',
        absorbedIds: ['mem_1'],
        mergedContent: 'Content',
        mergedMetadata: {},
        strategy: MergeStrategy.KEEP_NEWEST,
        contentChanged: false,
      });
      mockLineage.recordMerge.mockResolvedValue({ id: 'event_1' });
      mockPrisma.mergeCandidate.update.mockResolvedValue({});

      await service.approve(
        'cand_1',
        { strategy: MergeStrategy.KEEP_NEWEST },
        'approver_1',
      );

      expect(mockMerge.merge).toHaveBeenCalledWith(
        ['mem_1', 'mem_2'],
        MergeStrategy.KEEP_NEWEST,
        expect.any(Object),
      );
    });

    it('should throw when candidate not found', async () => {
      mockPrisma.mergeCandidate.findUnique.mockResolvedValue(null);

      await expect(service.approve('nonexistent', {})).rejects.toThrow(
        'Candidate not found',
      );
    });

    it('should throw when candidate not pending', async () => {
      mockPrisma.mergeCandidate.findUnique.mockResolvedValue({
        id: 'cand_1',
        status: CandidateStatus.APPROVED,
      });

      await expect(service.approve('cand_1', {})).rejects.toThrow(
        'not pending',
      );
    });
  });

  describe('reject', () => {
    it('should update status to rejected', async () => {
      mockPrisma.mergeCandidate.findUnique.mockResolvedValue({
        id: 'cand_1',
        memoryIds: ['mem_1', 'mem_2'],
        status: CandidateStatus.PENDING,
      });
      mockPrisma.mergeCandidate.update.mockResolvedValue({});

      const result = await service.reject(
        'cand_1',
        { reason: 'Not duplicates' },
        'rejector_1',
      );

      expect(result.success).toBe(true);
      expect(mockPrisma.mergeCandidate.update).toHaveBeenCalledWith({
        where: { id: 'cand_1' },
        data: expect.objectContaining({
          status: CandidateStatus.REJECTED,
          reviewNotes: 'Not duplicates',
        }),
      });
    });

    it('should throw when candidate not found', async () => {
      mockPrisma.mergeCandidate.findUnique.mockResolvedValue(null);

      await expect(
        service.reject('nonexistent', { reason: 'Test' }),
      ).rejects.toThrow('Candidate not found');
    });
  });

  describe('skip', () => {
    it('should set skip until date', async () => {
      mockPrisma.mergeCandidate.findUnique.mockResolvedValue({
        id: 'cand_1',
        status: CandidateStatus.PENDING,
      });
      mockPrisma.mergeCandidate.update.mockResolvedValue({});

      const result = await service.skip('cand_1', 7);

      expect(result.success).toBe(true);
      expect(result.nextReviewAt).toBeDefined();
      expect(mockPrisma.mergeCandidate.update).toHaveBeenCalledWith({
        where: { id: 'cand_1' },
        data: expect.objectContaining({
          status: CandidateStatus.SKIPPED,
          skipUntil: expect.any(Date),
        }),
      });
    });

    it('should throw when candidate not found', async () => {
      mockPrisma.mergeCandidate.findUnique.mockResolvedValue(null);

      await expect(service.skip('nonexistent')).rejects.toThrow(
        'Candidate not found',
      );
    });
  });

  describe('wasRejected', () => {
    it('should return true when pair was rejected', async () => {
      mockPrisma.mergeCandidate.findFirst.mockResolvedValue({
        id: 'cand_1',
        status: CandidateStatus.REJECTED,
      });

      const result = await service.wasRejected('mem_1', 'mem_2');

      expect(result).toBe(true);
    });

    it('should return false when no rejection found', async () => {
      mockPrisma.mergeCandidate.findFirst.mockResolvedValue(null);

      const result = await service.wasRejected('mem_1', 'mem_2');

      expect(result).toBe(false);
    });
  });

  describe('processBacklog', () => {
    it('should auto-approve high-confidence candidates older than 24h', async () => {
      const oldCandidate = {
        id: 'cand_old',
        userId: 'user_123',
        memoryIds: ['mem_1', 'mem_2'],
        similarity: 0.95,
        suggestedStrategy: MergeStrategy.KEEP_DETAILED,
        suggestedSurvivorId: 'mem_1',
        safetyFlags: '[]',
        status: CandidateStatus.PENDING,
        createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      };

      mockPrisma.mergeCandidate.findMany.mockResolvedValue([oldCandidate]);
      mockSafety.checkMultipleSafety.mockResolvedValue([
        {
          isProtected: false,
          canAutoMerge: true,
          requiresReview: false,
          reasons: [],
        },
        {
          isProtected: false,
          canAutoMerge: true,
          requiresReview: false,
          reasons: [],
        },
      ]);
      mockPrisma.mergeCandidate.findUnique.mockResolvedValue(oldCandidate);
      mockMerge.merge.mockResolvedValue({
        survivorId: 'mem_1',
        absorbedIds: ['mem_2'],
        mergedContent: 'merged',
        strategy: MergeStrategy.KEEP_DETAILED,
        contentChanged: true,
      });
      mockLineage.recordMerge.mockResolvedValue({ id: 'event-1' });
      mockPrisma.mergeCandidate.update.mockResolvedValue({});

      const result = await service.processBacklog(0.93, 24);

      expect(result.approved).toBe(1);
      expect(result.skippedSafety).toBe(0);
      expect(result.errors).toBe(0);
    });

    it('should skip safety-critical memories in backlog', async () => {
      const candidate = {
        id: 'cand_protected',
        userId: 'user_123',
        memoryIds: ['mem_1', 'mem_2'],
        similarity: 0.96,
        suggestedStrategy: MergeStrategy.KEEP_DETAILED,
        suggestedSurvivorId: 'mem_1',
        safetyFlags: '[]',
        status: CandidateStatus.PENDING,
        createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      };

      mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
      mockSafety.checkMultipleSafety.mockResolvedValue([
        {
          isProtected: true,
          canAutoMerge: false,
          requiresReview: true,
          reasons: [{ type: 'PROTECTED_TYPE' }],
        },
        {
          isProtected: false,
          canAutoMerge: true,
          requiresReview: false,
          reasons: [],
        },
      ]);

      const result = await service.processBacklog();

      expect(result.approved).toBe(0);
      expect(result.skippedSafety).toBe(1);
      expect(mockMerge.merge).not.toHaveBeenCalled();
    });

    it('should handle merge failures gracefully', async () => {
      const candidate = {
        id: 'cand_fail',
        userId: 'user_123',
        memoryIds: ['mem_1', 'mem_2'],
        similarity: 0.95,
        suggestedStrategy: MergeStrategy.KEEP_DETAILED,
        suggestedSurvivorId: 'mem_1',
        safetyFlags: '[]',
        status: CandidateStatus.PENDING,
        createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      };

      mockPrisma.mergeCandidate.findMany.mockResolvedValue([candidate]);
      mockSafety.checkMultipleSafety.mockResolvedValue([
        {
          isProtected: false,
          canAutoMerge: true,
          requiresReview: false,
          reasons: [],
        },
        {
          isProtected: false,
          canAutoMerge: true,
          requiresReview: false,
          reasons: [],
        },
      ]);
      // approve throws (e.g., memory deleted)
      mockPrisma.mergeCandidate.findUnique.mockResolvedValue(candidate);
      mockMerge.merge.mockRejectedValue(new Error('Memory not found'));
      // Fallback update succeeds
      mockPrisma.mergeCandidate.update.mockResolvedValue({});

      const result = await service.processBacklog();

      expect(result.approved).toBe(1);
      expect(result.errors).toBe(0);
    });

    it('should return empty stats when no candidates match', async () => {
      mockPrisma.mergeCandidate.findMany.mockResolvedValue([]);

      const result = await service.processBacklog();

      expect(result).toEqual({ approved: 0, skippedSafety: 0, errors: 0 });
    });
  });

  describe('queueClusterForReview', () => {
    it('should create candidate for cluster', async () => {
      const cluster = {
        id: 'cluster_1',
        memoryIds: ['mem_1', 'mem_2', 'mem_3'],
        centroidMemoryId: 'mem_1',
        avgSimilarity: 0.93,
        minSimilarity: 0.9,
      };

      mockSafety.checkMultipleSafety.mockResolvedValue([
        {
          memoryId: 'mem_1',
          isProtected: false,
          canAutoMerge: true,
          requiresReview: false,
          reasons: [],
        },
        {
          memoryId: 'mem_2',
          isProtected: false,
          canAutoMerge: true,
          requiresReview: false,
          reasons: [],
        },
        {
          memoryId: 'mem_3',
          isProtected: false,
          canAutoMerge: true,
          requiresReview: false,
          reasons: [],
        },
      ]);
      mockPrisma.memory.findMany.mockResolvedValue([
        createMockMemory('mem_1'),
        createMockMemory('mem_2'),
        createMockMemory('mem_3'),
      ]);
      mockPrisma.mergeCandidate.findFirst.mockResolvedValue(null);
      mockPrisma.mergeCandidate.create.mockResolvedValue({
        id: 'cand_1',
        memoryIds: ['mem_1', 'mem_2', 'mem_3'],
        similarity: 0.93,
        suggestedStrategy: MergeStrategy.KEEP_DETAILED,
        suggestedSurvivorId: 'mem_1',
        safetyFlags: '[]',
        status: CandidateStatus.PENDING,
        createdAt: new Date(),
      });

      const result = await service.queueClusterForReview('user_123', cluster);

      expect(result.memories.length).toBe(3);
      expect(result.suggestedSurvivorId).toBe('mem_1');
    });
  });
});

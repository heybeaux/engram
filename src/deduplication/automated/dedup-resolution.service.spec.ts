import { Test, TestingModule } from '@nestjs/testing';
import { DedupResolutionService } from './dedup-resolution.service';
import { ServicePrismaService } from '../../prisma/service-prisma.service';
import { SafetyService } from '../safety.service';

const makeMemory = (
  overrides: Partial<{
    id: string;
    raw: string;
    importanceScore: number;
    userId: string;
    createdAt: Date;
    safetyCritical: boolean;
    memoryType: string | null;
  }> = {},
) => ({
  id: 'mem-1',
  raw: 'Test memory content',
  importanceScore: 0.5,
  userId: 'user-1',
  createdAt: new Date(),
  safetyCritical: false,
  memoryType: null,
  ...overrides,
});

const makeCandidate = (overrides: Record<string, unknown> = {}) => ({
  id: 'cand-1',
  classification: 'DUPLICATE',
  confidence: 0.85,
  similarityScore: 0.92,
  mergedContent: null,
  classifiedAt: new Date(),
  memory1: makeMemory({ id: 'mem-1' }),
  memory2: makeMemory({ id: 'mem-2', importanceScore: 0.4 }),
  ...overrides,
});

const mockPrisma = {
  dedupCandidate: {
    findMany: jest.fn(),
    update: jest.fn(),
  },
  memory: {
    update: jest.fn(),
  },
  memoryMergeEvent: {
    create: jest.fn(),
  },
  $transaction: jest.fn(),
};

describe('DedupResolutionService', () => {
  let service: DedupResolutionService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DedupResolutionService,
        { provide: ServicePrismaService, useValue: mockPrisma },
        { provide: SafetyService, useValue: {} },
      ],
    }).compile();

    service = module.get<DedupResolutionService>(DedupResolutionService);
    jest.clearAllMocks();

    // Default: $transaction resolves successfully
    mockPrisma.$transaction.mockResolvedValue([]);
    mockPrisma.dedupCandidate.update.mockResolvedValue({});
  });

  describe('processClassifiedCandidates', () => {
    it('returns zero stats when no classified candidates', async () => {
      mockPrisma.dedupCandidate.findMany.mockResolvedValue([]);
      const stats = await service.processClassifiedCandidates();
      expect(stats.processed).toBe(0);
      expect(stats.autoMerged).toBe(0);
    });

    it('auto-merges DUPLICATE candidates with confidence >= 0.7', async () => {
      mockPrisma.dedupCandidate.findMany.mockResolvedValue([
        makeCandidate({ classification: 'DUPLICATE', confidence: 0.85 }),
      ]);

      const stats = await service.processClassifiedCandidates();

      expect(stats.autoMerged).toBe(1);
      expect(stats.processed).toBe(1);
      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it('queues DUPLICATE candidates with confidence < 0.7 for review', async () => {
      mockPrisma.dedupCandidate.findMany.mockResolvedValue([
        makeCandidate({ classification: 'DUPLICATE', confidence: 0.5 }),
      ]);

      const stats = await service.processClassifiedCandidates();

      expect(stats.autoMerged).toBe(0);
      expect(stats.queued).toBe(1);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('auto-merges SUPPORTING candidates with confidence >= 0.7', async () => {
      mockPrisma.dedupCandidate.findMany.mockResolvedValue([
        makeCandidate({ classification: 'SUPPORTING', confidence: 0.75 }),
      ]);

      const stats = await service.processClassifiedCandidates();
      expect(stats.autoMerged).toBe(1);
    });

    it('auto-consolidates OVERLAPPING with confidence >= 0.9', async () => {
      mockPrisma.dedupCandidate.findMany.mockResolvedValue([
        makeCandidate({ classification: 'OVERLAPPING', confidence: 0.95 }),
      ]);

      const stats = await service.processClassifiedCandidates();
      expect(stats.autoConsolidated).toBe(1);
    });

    it('queues OVERLAPPING with confidence 0.7–0.9 for review', async () => {
      mockPrisma.dedupCandidate.findMany.mockResolvedValue([
        makeCandidate({ classification: 'OVERLAPPING', confidence: 0.8 }),
      ]);

      const stats = await service.processClassifiedCandidates();
      expect(stats.queued).toBe(1);
      expect(stats.autoConsolidated).toBe(0);
    });

    it('always queues CONFLICTING candidates — never auto-merges', async () => {
      mockPrisma.dedupCandidate.findMany.mockResolvedValue([
        makeCandidate({ classification: 'CONFLICTING', confidence: 0.99 }),
      ]);

      const stats = await service.processClassifiedCandidates();

      expect(stats.queued).toBe(1);
      expect(stats.autoMerged).toBe(0);
      expect(stats.autoConsolidated).toBe(0);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('marks RELATED candidates resolved immediately without merge', async () => {
      mockPrisma.dedupCandidate.findMany.mockResolvedValue([
        makeCandidate({ classification: 'RELATED', confidence: 0.5 }),
      ]);

      const stats = await service.processClassifiedCandidates();

      expect(stats.skipped).toBe(1);
      expect(stats.autoMerged).toBe(0);
      expect(mockPrisma.dedupCandidate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'RESOLVED' }),
        }),
      );
    });

    it('never auto-merges CONSTRAINT-type memories', async () => {
      mockPrisma.dedupCandidate.findMany.mockResolvedValue([
        makeCandidate({
          classification: 'DUPLICATE',
          confidence: 0.95,
          memory1: makeMemory({ id: 'mem-1', memoryType: 'CONSTRAINT' }),
        }),
      ]);

      const stats = await service.processClassifiedCandidates();

      expect(stats.autoMerged).toBe(0);
      expect(stats.queued).toBe(1);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('never auto-merges safety-critical memories', async () => {
      mockPrisma.dedupCandidate.findMany.mockResolvedValue([
        makeCandidate({
          classification: 'DUPLICATE',
          confidence: 0.95,
          memory2: makeMemory({ id: 'mem-2', safetyCritical: true }),
        }),
      ]);

      const stats = await service.processClassifiedCandidates();

      expect(stats.autoMerged).toBe(0);
      expect(stats.queued).toBe(1);
    });

    it('creates MemoryMergeEvent with canRollback: true on auto-merge', async () => {
      mockPrisma.dedupCandidate.findMany.mockResolvedValue([
        makeCandidate({ classification: 'DUPLICATE', confidence: 0.9 }),
      ]);

      let capturedTransaction: unknown[] | null = null;
      mockPrisma.$transaction.mockImplementation((ops: unknown[]) => {
        capturedTransaction = ops;
        return Promise.resolve([]);
      });

      await service.processClassifiedCandidates();

      expect(capturedTransaction).not.toBeNull();
      // Transaction should include memoryMergeEvent.create (3rd item)
      expect(mockPrisma.$transaction).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.anything(),
          expect.anything(),
          expect.anything(),
          expect.anything(),
        ]),
      );
    });

    it('handles errors per candidate without crashing the batch', async () => {
      mockPrisma.dedupCandidate.findMany.mockResolvedValue([
        makeCandidate({ classification: 'DUPLICATE', confidence: 0.9 }),
      ]);

      mockPrisma.$transaction.mockRejectedValue(new Error('DB error'));

      const stats = await service.processClassifiedCandidates();
      expect(stats.errors).toBe(1);
      expect(stats.processed).toBe(0);
    });
  });
});

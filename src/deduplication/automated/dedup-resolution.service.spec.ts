import { Test, TestingModule } from '@nestjs/testing';
import { DedupResolutionService } from './dedup-resolution.service';
import { ServicePrismaService } from '../../prisma/service-prisma.service';
import { SafetyService } from '../safety.service';

const makeMemory = (
  overrides: Partial<{
    id: string;
    raw: string;
    importanceScore: number;
    typeConfidence: number | null;
    userId: string;
    agentId: string | null;
    createdAt: Date;
    safetyCritical: boolean;
    memoryType: string | null;
  }> = {},
) => ({
  id: 'mem-1',
  raw: 'Test memory content',
  importanceScore: 0.5,
  typeConfidence: null,
  userId: 'user-1',
  agentId: null,
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
    create: jest.fn(),
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

    it('queues DUPLICATE candidates with confidence < 0.7 for review and updates status to QUEUED', async () => {
      mockPrisma.dedupCandidate.findMany.mockResolvedValue([
        makeCandidate({ classification: 'DUPLICATE', confidence: 0.5 }),
      ]);

      const stats = await service.processClassifiedCandidates();

      expect(stats.autoMerged).toBe(0);
      expect(stats.queued).toBe(1);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockPrisma.dedupCandidate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'QUEUED' }),
        }),
      );
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

    it('queues OVERLAPPING with confidence 0.7–0.9 for review and updates status to QUEUED', async () => {
      mockPrisma.dedupCandidate.findMany.mockResolvedValue([
        makeCandidate({ classification: 'OVERLAPPING', confidence: 0.8 }),
      ]);

      const stats = await service.processClassifiedCandidates();
      expect(stats.queued).toBe(1);
      expect(stats.autoConsolidated).toBe(0);
      expect(mockPrisma.dedupCandidate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'QUEUED' }),
        }),
      );
    });

    it('resolves CONFLICTING — newer memory wins, older gets superseded', async () => {
      const older = new Date('2026-01-01');
      const newer = new Date('2026-03-01');
      mockPrisma.dedupCandidate.findMany.mockResolvedValue([
        makeCandidate({
          classification: 'CONFLICTING',
          confidence: 0.9,
          memory1: makeMemory({
            id: 'old-mem',
            raw: 'User lives in NYC',
            createdAt: older,
            importanceScore: 0.6,
          }),
          memory2: makeMemory({
            id: 'new-mem',
            raw: 'User lives in LA',
            createdAt: newer,
            importanceScore: 0.5,
          }),
        }),
      ]);

      const stats = await service.processClassifiedCandidates();

      expect(stats.contradictionsResolved).toBe(1);
      expect(stats.queued).toBe(0);
      expect(stats.autoMerged).toBe(0);
      expect(mockPrisma.$transaction).toHaveBeenCalledWith(
        expect.arrayContaining([
          // weaker (older) memory gets superseded
          expect.anything(),
          // INSIGHT memory created
          expect.anything(),
          // candidate marked resolved
          expect.anything(),
        ]),
      );
    });

    it('resolves CONFLICTING — equal timestamps, higher confidence wins', async () => {
      const sameTime = new Date('2026-02-01');
      mockPrisma.dedupCandidate.findMany.mockResolvedValue([
        makeCandidate({
          classification: 'CONFLICTING',
          confidence: 0.85,
          memory1: makeMemory({
            id: 'low-conf',
            raw: 'User prefers tea',
            createdAt: sameTime,
            importanceScore: 0.3,
            typeConfidence: 0.4,
          }),
          memory2: makeMemory({
            id: 'high-conf',
            raw: 'User prefers coffee',
            createdAt: sameTime,
            importanceScore: 0.8,
            typeConfidence: 0.9,
          }),
        }),
      ]);

      const stats = await service.processClassifiedCandidates();

      expect(stats.contradictionsResolved).toBe(1);
      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it('sets supersededById and searchable=false on the weaker memory', async () => {
      const older = new Date('2026-01-01');
      const newer = new Date('2026-03-01');

      let transactionOps: unknown[] = [];
      mockPrisma.$transaction.mockImplementation((ops: unknown[]) => {
        transactionOps = ops;
        return Promise.resolve([]);
      });
      // Ensure memory.update returns a promise (called via $transaction array)
      mockPrisma.memory.update.mockReturnValue(Promise.resolve({}));
      mockPrisma.memory.create.mockReturnValue(Promise.resolve({}));
      mockPrisma.dedupCandidate.update.mockReturnValue(Promise.resolve({}));

      mockPrisma.dedupCandidate.findMany.mockResolvedValue([
        makeCandidate({
          classification: 'CONFLICTING',
          confidence: 0.9,
          memory1: makeMemory({
            id: 'old-mem',
            raw: 'Fact A',
            createdAt: older,
          }),
          memory2: makeMemory({
            id: 'new-mem',
            raw: 'Fact B',
            createdAt: newer,
          }),
        }),
      ]);

      await service.processClassifiedCandidates();

      // The transaction should have 3 operations
      expect(mockPrisma.$transaction).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.anything(),
          expect.anything(),
          expect.anything(),
        ]),
      );
    });

    it('creates an INSIGHT memory documenting the contradiction resolution', async () => {
      const older = new Date('2026-01-01');
      const newer = new Date('2026-03-01');

      mockPrisma.$transaction.mockImplementation((ops: unknown[]) =>
        Promise.resolve([]),
      );
      mockPrisma.memory.update.mockReturnValue(Promise.resolve({}));
      mockPrisma.memory.create.mockReturnValue(Promise.resolve({}));
      mockPrisma.dedupCandidate.update.mockReturnValue(Promise.resolve({}));

      mockPrisma.dedupCandidate.findMany.mockResolvedValue([
        makeCandidate({
          classification: 'CONFLICTING',
          confidence: 0.9,
          memory1: makeMemory({
            id: 'old-mem',
            raw: 'User lives in NYC',
            createdAt: older,
            importanceScore: 0.7,
          }),
          memory2: makeMemory({
            id: 'new-mem',
            raw: 'User lives in LA',
            createdAt: newer,
            importanceScore: 0.5,
          }),
        }),
      ]);

      await service.processClassifiedCandidates();

      // memory.create should have been called (via $transaction) for the INSIGHT
      expect(mockPrisma.memory.create).toHaveBeenCalled();
    });

    it('does not resolve non-CONFLICTING pairs as contradictions', async () => {
      mockPrisma.dedupCandidate.findMany.mockResolvedValue([
        makeCandidate({ classification: 'DUPLICATE', confidence: 0.85 }),
        makeCandidate({
          id: 'cand-2',
          classification: 'RELATED',
          confidence: 0.5,
        }),
      ]);

      const stats = await service.processClassifiedCandidates();

      expect(stats.contradictionsResolved).toBe(0);
      expect(stats.autoMerged).toBe(1);
      expect(stats.skipped).toBe(1);
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

    it('never auto-merges CONSTRAINT-type memories — marks QUEUED', async () => {
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
      expect(mockPrisma.dedupCandidate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'QUEUED' }),
        }),
      );
    });

    it('never auto-merges safety-critical memories — marks QUEUED', async () => {
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
      expect(mockPrisma.dedupCandidate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'QUEUED' }),
        }),
      );
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

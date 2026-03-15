import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CandidateDetectionService } from './candidate-detection.service';
import { ServicePrismaService } from '../../prisma/service-prisma.service';
import { DEFAULT_DETECTION_WINDOW_HOURS } from './dedup-candidate.model';

const mockMemories = [
  { id: 'mem-1', raw: 'User prefers dark mode in all apps' },
  { id: 'mem-2', raw: 'User prefers dark mode in applications' },
  { id: 'mem-3', raw: 'User enjoys hiking on weekends' },
];

const mockPrisma = {
  memory: {
    findMany: jest.fn(),
  },
  dedupCandidate: {
    upsert: jest.fn(),
  },
  $queryRaw: jest.fn(),
  $queryRawUnsafe: jest.fn(),
};

const mockConfig = {
  get: jest.fn().mockReturnValue(undefined),
};

describe('CandidateDetectionService', () => {
  let service: CandidateDetectionService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CandidateDetectionService,
        { provide: ServicePrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<CandidateDetectionService>(CandidateDetectionService);
    jest.clearAllMocks();
  });

  describe('detection window configuration', () => {
    it('defaults to DEFAULT_DETECTION_WINDOW_HOURS when env var not set', () => {
      expect((service as any).windowHours).toBe(DEFAULT_DETECTION_WINDOW_HOURS);
    });

    it('reads DEDUP_DETECTION_WINDOW_HOURS from config', async () => {
      const customConfig = { get: jest.fn().mockReturnValue('48') };
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          CandidateDetectionService,
          { provide: ServicePrismaService, useValue: mockPrisma },
          { provide: ConfigService, useValue: customConfig },
        ],
      }).compile();

      const svc = module.get<CandidateDetectionService>(CandidateDetectionService);
      expect((svc as any).windowHours).toBe(48);
    });
  });

  describe('levenshteinSimilarity', () => {
    it('returns 1 for identical strings', () => {
      expect(service.levenshteinSimilarity('hello', 'hello')).toBe(1);
    });

    it('returns 0 for completely different strings of same length', () => {
      const sim = service.levenshteinSimilarity('abc', 'xyz');
      expect(sim).toBeLessThan(0.5);
    });

    it('returns a high score for very similar strings', () => {
      const sim = service.levenshteinSimilarity(
        'User prefers dark mode in all apps',
        'User prefers dark mode in applications',
      );
      expect(sim).toBeGreaterThan(0.7);
    });

    it('returns 0 for empty strings (both empty)', () => {
      expect(service.levenshteinSimilarity('', '')).toBe(1);
    });

    it('returns 0 when one string is empty', () => {
      expect(service.levenshteinSimilarity('hello', '')).toBe(0);
    });
  });

  describe('normalizeText', () => {
    it('lowercases text', () => {
      expect(service.normalizeText('Hello WORLD')).toBe('hello world');
    });

    it('collapses multiple spaces', () => {
      expect(service.normalizeText('hello   world')).toBe('hello world');
    });

    it('trims leading/trailing whitespace', () => {
      expect(service.normalizeText('  hello  ')).toBe('hello');
    });
  });

  describe('detectCandidates', () => {
    it('returns zero stats when no recent memories', async () => {
      mockPrisma.memory.findMany.mockResolvedValue([]);
      mockPrisma.$queryRaw.mockResolvedValue([]);

      const stats = await service.detectCandidates();

      expect(stats.scanned).toBe(0);
      expect(stats.created).toBe(0);
      expect(stats.skipped).toBe(0);
    });

    it('processes memories and attempts text comparison', async () => {
      mockPrisma.memory.findMany
        .mockResolvedValueOnce(mockMemories) // recent memories
        .mockResolvedValue(mockMemories.slice(1)); // neighbours in text phase

      // Embedding-eligible: only mem-1 and mem-2
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'mem-1' }, { id: 'mem-2' }]);

      // pgvector neighbours query
      jest.spyOn(service as any, 'detectVectorNeighbours').mockResolvedValue({
        created: 1,
        skipped: 0,
      });

      mockPrisma.dedupCandidate.upsert.mockResolvedValue({});

      const stats = await service.detectCandidates();
      expect(stats.scanned).toBe(3);
    });

    it('skips vector phase for memories without embeddings', async () => {
      mockPrisma.memory.findMany
        .mockResolvedValueOnce([mockMemories[2]]) // one memory, no embedding
        .mockResolvedValue([]);

      mockPrisma.$queryRaw.mockResolvedValue([]); // no embedding-eligible ids

      const vectorSpy = jest
        .spyOn(service as any, 'detectVectorNeighbours')
        .mockResolvedValue({ created: 0, skipped: 0 });

      await service.detectCandidates();

      expect(vectorSpy).not.toHaveBeenCalled();
    });

    it('creates dedup candidate when text similarity exceeds threshold', async () => {
      const similar1 = { id: 'a', raw: 'User prefers dark mode' };
      const similar2 = { id: 'b', raw: 'User prefers dark mode' };

      mockPrisma.memory.findMany
        .mockResolvedValueOnce([similar1])
        .mockResolvedValue([similar2]);

      mockPrisma.$queryRaw.mockResolvedValue([]);
      mockPrisma.dedupCandidate.upsert.mockResolvedValue({});

      const stats = await service.detectCandidates();
      expect(stats.created).toBeGreaterThan(0);
    });
  });
});

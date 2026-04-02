import { Test, TestingModule } from '@nestjs/testing';
import { TemporalGapService } from './temporal-gap.service';
import { PrismaService } from '../prisma/prisma.service';

describe('TemporalGapService', () => {
  let service: TemporalGapService;
  const mockPrisma = {
    $queryRawUnsafe: jest.fn(),
  };

  const AGENT_ID = 'agent-1';

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TemporalGapService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<TemporalGapService>(TemporalGapService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('detectGaps', () => {
    it('should detect absolute gaps when days have no memories', async () => {
      // 3-day range, only day 2 has memories
      mockPrisma.$queryRawUnsafe.mockResolvedValue([
        { day: new Date('2026-03-02'), count: BigInt(3) },
      ]);

      const result = await service.detectGaps(
        'deployment',
        new Date('2026-03-01'),
        new Date('2026-03-03'),
        AGENT_ID,
      );

      expect(result.topic).toBe('deployment');
      expect(result.totalMemories).toBe(3);
      expect(result.gaps).toEqual(
        expect.arrayContaining([
          { date: '2026-03-01', memoryCount: 0, isAbsoluteGap: true },
          { date: '2026-03-03', memoryCount: 0, isAbsoluteGap: true },
        ]),
      );
      // Only day 2 has absolute gaps filtered out
      const absoluteGaps = result.gaps.filter((g) => g.isAbsoluteGap);
      expect(absoluteGaps).toHaveLength(2);
    });

    it('should correctly count memories per day', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([
        { day: new Date('2026-03-01'), count: BigInt(5) },
        { day: new Date('2026-03-02'), count: BigInt(10) },
        { day: new Date('2026-03-03'), count: BigInt(8) },
      ]);

      const result = await service.detectGaps(
        'testing',
        new Date('2026-03-01'),
        new Date('2026-03-03'),
        AGENT_ID,
      );

      expect(result.totalMemories).toBe(23);
      expect(result.averagePerDay).toBeCloseTo(7.67, 1);
    });

    it('should calculate accurate coverage percentage', async () => {
      // 5-day range, 3 days have memories
      mockPrisma.$queryRawUnsafe.mockResolvedValue([
        { day: new Date('2026-03-01'), count: BigInt(2) },
        { day: new Date('2026-03-03'), count: BigInt(4) },
        { day: new Date('2026-03-05'), count: BigInt(1) },
      ]);

      const result = await service.detectGaps(
        'meetings',
        new Date('2026-03-01'),
        new Date('2026-03-05'),
        AGENT_ID,
      );

      // 3 out of 5 days = 60%
      expect(result.coverage).toBe(60);
    });

    it('should isolate by agentId', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      await service.detectGaps(
        'topic',
        new Date('2026-03-01'),
        new Date('2026-03-01'),
        'agent-xyz',
      );

      expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledWith(
        expect.any(String),
        'agent-xyz',
        'topic',
        expect.any(Date),
        expect.any(Date),
      );
    });

    it('should handle empty results (no memories in range)', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      const result = await service.detectGaps(
        'nonexistent',
        new Date('2026-03-01'),
        new Date('2026-03-03'),
        AGENT_ID,
      );

      expect(result.totalMemories).toBe(0);
      expect(result.averagePerDay).toBe(0);
      expect(result.coverage).toBe(0);
      expect(result.gaps).toHaveLength(3); // All 3 days are gaps
      expect(result.gaps.every((g) => g.isAbsoluteGap)).toBe(true);
    });

    it('should identify sparse days relative to average', async () => {
      // Average will be 10/5 = 2, sparse threshold = max(1, floor(1)) = 1
      // Days with count < 1 are sparse — but since count >= 1, they won't be sparse
      // Let's use bigger numbers: avg = 50/5 = 10, threshold = 5
      mockPrisma.$queryRawUnsafe.mockResolvedValue([
        { day: new Date('2026-03-01'), count: BigInt(20) },
        { day: new Date('2026-03-02'), count: BigInt(2) },  // sparse (2 < 5)
        { day: new Date('2026-03-03'), count: BigInt(15) },
        { day: new Date('2026-03-04'), count: BigInt(10) },
        { day: new Date('2026-03-05'), count: BigInt(3) },  // sparse (3 < 5)
      ]);

      const result = await service.detectGaps(
        'activity',
        new Date('2026-03-01'),
        new Date('2026-03-05'),
        AGENT_ID,
      );

      // avg = 50/5 = 10, threshold = floor(10*0.5) = 5
      const sparseGaps = result.gaps.filter((g) => !g.isAbsoluteGap);
      expect(sparseGaps).toHaveLength(2);
      expect(sparseGaps).toEqual(
        expect.arrayContaining([
          { date: '2026-03-02', memoryCount: 2, isAbsoluteGap: false },
          { date: '2026-03-05', memoryCount: 3, isAbsoluteGap: false },
        ]),
      );
    });

    it('should return correct range in response', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

      const result = await service.detectGaps(
        'topic',
        new Date('2026-03-10'),
        new Date('2026-03-15'),
        AGENT_ID,
      );

      expect(result.range).toEqual({
        start: '2026-03-10',
        end: '2026-03-15',
      });
    });

    it('should handle single-day range', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([
        { day: new Date('2026-03-01'), count: BigInt(5) },
      ]);

      const result = await service.detectGaps(
        'topic',
        new Date('2026-03-01'),
        new Date('2026-03-01'),
        AGENT_ID,
      );

      expect(result.totalMemories).toBe(5);
      expect(result.gaps).toHaveLength(0);
      expect(result.coverage).toBe(100);
    });

    it('should handle 100% coverage', async () => {
      mockPrisma.$queryRawUnsafe.mockResolvedValue([
        { day: new Date('2026-03-01'), count: BigInt(5) },
        { day: new Date('2026-03-02'), count: BigInt(5) },
        { day: new Date('2026-03-03'), count: BigInt(5) },
      ]);

      const result = await service.detectGaps(
        'topic',
        new Date('2026-03-01'),
        new Date('2026-03-03'),
        AGENT_ID,
      );

      expect(result.coverage).toBe(100);
      // No absolute gaps; no sparse gaps since all equal average
      expect(result.gaps).toHaveLength(0);
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RecallWeightService } from './recall-weight.service';
import { PrismaService } from '../prisma/prisma.service';
import { Memory } from '@prisma/client';

const DAY_MS = 24 * 60 * 60 * 1000;

function createMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'test-1',
    userId: 'user-1',
    projectId: null,
    sessionId: null,
    raw: 'test memory content',
    layer: 'SESSION' as any,
    memoryType: null,
    typeConfidence: null,
    priority: 3,
    promotedFrom: null,
    userPinned: false,
    userHidden: false,
    effectiveScore: 0.5,
    scoreComputedAt: null,
    safetyCritical: false,
    subjectType: 'USER' as any,
    subjectId: null,
    agentId: null,
    source: 'EXPLICIT_STATEMENT' as any,
    importanceHint: null,
    importanceScore: 0.5,
    confidence: 1.0,
    sessionPosition: null,
    embeddingId: null,
    embeddingModel: null,
    embeddingStatus: 'COMPLETE' as any,
    isDuplicateOf: null,
    ingestedAt: new Date(),
    retrievalCount: 0,
    lastRetrievedAt: null,
    usedCount: 0,
    lastUsedAt: null,
    consolidated: false,
    consolidatedAt: null,
    supersededById: null,
    supersededAt: null,
    consolidatedInto: null,
    createdAt: new Date(Date.now() - 30 * DAY_MS),
    updatedAt: new Date(),
    deletedAt: null,
    clusterId: null,
    visibility: 'PRIVATE' as any,
    ...overrides,
  } as Memory;
}

describe('RecallWeightService — Usage Weighting (ENG-27)', () => {
  let service: RecallWeightService;
  let mockPrisma: any;

  beforeEach(async () => {
    mockPrisma = {
      feedback: {
        groupBy: jest.fn().mockResolvedValue([]),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecallWeightService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, defaultValue?: string) => {
              const config: Record<string, string> = {
                RECALL_TIER_WEIGHT_ENABLED: 'true',
                USAGE_WEIGHT: '0.15',
                USAGE_RECENCY_HALFLIFE_DAYS: '14',
                USAGE_USED_COUNT_MULTIPLIER: '2',
                USAGE_FEEDBACK_BOOST: '1.5',
                USAGE_FEEDBACK_PENALTY: '0.5',
                USAGE_MIN_RETRIEVALS: '3',
              };
              return config[key] ?? defaultValue;
            },
          },
        },
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<RecallWeightService>(RecallWeightService);
  });

  describe('usageSignal', () => {
    it('should return 0 for memories below minimum retrieval threshold', () => {
      const memory = createMemory({ retrievalCount: 2, usedCount: 0 });
      expect(service.usageSignal(memory)).toBe(0);
    });

    it('should return > 0 for memories with enough retrievals', () => {
      const memory = createMemory({
        retrievalCount: 10,
        usedCount: 5,
        lastRetrievedAt: new Date(),
      });
      expect(service.usageSignal(memory)).toBeGreaterThan(0);
    });

    it('should weight usedCount higher than retrievalCount', () => {
      const highUsed = createMemory({
        retrievalCount: 5,
        usedCount: 10,
        lastRetrievedAt: new Date(),
      });
      const highRetrieved = createMemory({
        retrievalCount: 25, // same raw total: 10*2 + 5 = 25, vs 0*2 + 25 = 25
        usedCount: 0,
        lastRetrievedAt: new Date(),
      });
      // With usedCountMultiplier=2: highUsed = 10*2 + 5 = 25, highRetrieved = 0*2 + 25 = 25
      // But with usedCount=10 vs 0, let's make the numbers different
      const moreUsed = createMemory({
        retrievalCount: 3,
        usedCount: 10,
        lastRetrievedAt: new Date(),
      });
      const moreRetrieved = createMemory({
        retrievalCount: 20,
        usedCount: 0,
        lastRetrievedAt: new Date(),
      });
      // moreUsed raw = 10*2 + 3 = 23
      // moreRetrieved raw = 0*2 + 20 = 20
      expect(service.usageSignal(moreUsed)).toBeGreaterThan(
        service.usageSignal(moreRetrieved),
      );
    });

    it('should decay with time since last use', () => {
      const recentlyUsed = createMemory({
        retrievalCount: 10,
        usedCount: 5,
        lastUsedAt: new Date(),
        lastRetrievedAt: new Date(),
      });
      const oldUsed = createMemory({
        retrievalCount: 10,
        usedCount: 5,
        lastUsedAt: new Date(Date.now() - 60 * DAY_MS),
        lastRetrievedAt: new Date(Date.now() - 60 * DAY_MS),
      });

      expect(service.usageSignal(recentlyUsed)).toBeGreaterThan(
        service.usageSignal(oldUsed),
      );
    });

    it('should cap at 1.0', () => {
      const heavilyUsed = createMemory({
        retrievalCount: 1000,
        usedCount: 500,
        lastRetrievedAt: new Date(),
        lastUsedAt: new Date(),
      });
      expect(service.usageSignal(heavilyUsed)).toBeLessThanOrEqual(1.0);
    });
  });

  describe('applyUsageWeighting', () => {
    it('should boost high-usage memories above equidistant ones', async () => {
      const memories = [
        {
          ...createMemory({
            id: 'low-usage',
            retrievalCount: 3,
            usedCount: 0,
            lastRetrievedAt: new Date(),
          }),
          score: 0.8,
        },
        {
          ...createMemory({
            id: 'high-usage',
            retrievalCount: 20,
            usedCount: 15,
            lastRetrievedAt: new Date(),
            lastUsedAt: new Date(),
          }),
          score: 0.8, // same vector score
        },
      ];

      const result = await service.applyUsageWeighting(memories);
      expect(result[0].id).toBe('high-usage');
      expect(result[0].score).toBeGreaterThan(result[1].score);
    });

    it('should apply feedback boost for positive feedback', async () => {
      mockPrisma.feedback.groupBy.mockResolvedValue([
        { memoryId: 'positive', _sum: { rating: 3 }, _count: { rating: 3 } },
      ]);

      const memories = [
        {
          ...createMemory({
            id: 'positive',
            retrievalCount: 10,
            usedCount: 5,
            lastRetrievedAt: new Date(),
          }),
          score: 0.7,
        },
        {
          ...createMemory({
            id: 'neutral',
            retrievalCount: 10,
            usedCount: 5,
            lastRetrievedAt: new Date(),
          }),
          score: 0.7,
        },
      ];

      const result = await service.applyUsageWeighting(memories);
      const positiveResult = result.find((r) => r.id === 'positive');
      const neutralResult = result.find((r) => r.id === 'neutral');
      expect(positiveResult!.score).toBeGreaterThan(neutralResult!.score);
    });

    it('should suppress negatively-rated memories', async () => {
      mockPrisma.feedback.groupBy.mockResolvedValue([
        { memoryId: 'negative', _sum: { rating: -2 }, _count: { rating: 2 } },
      ]);

      const memories = [
        {
          ...createMemory({
            id: 'negative',
            retrievalCount: 10,
            usedCount: 5,
            lastRetrievedAt: new Date(),
          }),
          score: 0.8,
        },
        {
          ...createMemory({
            id: 'neutral',
            retrievalCount: 10,
            usedCount: 5,
            lastRetrievedAt: new Date(),
          }),
          score: 0.8,
        },
      ];

      const result = await service.applyUsageWeighting(memories);
      const negativeResult = result.find((r) => r.id === 'negative');
      const neutralResult = result.find((r) => r.id === 'neutral');
      expect(negativeResult!.score).toBeLessThan(neutralResult!.score);
    });

    it('should handle empty array', async () => {
      const result = await service.applyUsageWeighting([]);
      expect(result).toEqual([]);
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HybridSearchService } from './hybrid-search.service';
import { PrismaService } from '../prisma/prisma.service';

describe('HybridSearchService', () => {
  let service: HybridSearchService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HybridSearchService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, defaultValue?: string) => {
              const config: Record<string, string> = {
                HYBRID_VECTOR_WEIGHT: '0.6',
                HYBRID_TEXT_WEIGHT: '0.4',
                HYBRID_RRF_K: '60',
                HYBRID_MIN_TEXT_SCORE: '0.01',
                HYBRID_FUZZY_ENABLED: 'true',
              };
              return config[key] ?? defaultValue;
            },
          },
        },
        {
          provide: PrismaService,
          useValue: { $queryRawUnsafe: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<HybridSearchService>(HybridSearchService);
  });

  describe('fuseResults', () => {
    it('should combine vector and text results using RRF', () => {
      const vectorResults = [
        { id: 'a', score: 0.95 },
        { id: 'b', score: 0.85 },
        { id: 'c', score: 0.75 },
      ];
      const textResults = [
        { id: 'b', score: 0.9 },
        { id: 'd', score: 0.7 },
        { id: 'a', score: 0.5 },
      ];

      const fused = service.fuseResults(vectorResults, textResults, 10);

      // 'b' should rank highest — it appears in both lists at good positions
      expect(fused[0].id).toBe('b');
      expect(fused[0].fusionMethod).toBe('rrf');

      // 'a' should be second — also in both lists
      expect(fused[1].id).toBe('a');
      expect(fused[1].fusionMethod).toBe('rrf');

      // All 4 unique IDs should be present
      expect(fused.length).toBe(4);
    });

    it('should mark vector-only results correctly', () => {
      const vectorResults = [{ id: 'a', score: 0.9 }];
      const textResults = [{ id: 'b', score: 0.8 }];

      const fused = service.fuseResults(vectorResults, textResults, 10);
      const aResult = fused.find((r) => r.id === 'a');
      const bResult = fused.find((r) => r.id === 'b');

      expect(aResult?.fusionMethod).toBe('vector_only');
      expect(bResult?.fusionMethod).toBe('rrf');
    });

    it('should respect limit parameter', () => {
      const vectorResults = Array.from({ length: 50 }, (_, i) => ({
        id: `v${i}`,
        score: 1 - i * 0.01,
      }));
      const textResults = Array.from({ length: 50 }, (_, i) => ({
        id: `t${i}`,
        score: 1 - i * 0.01,
      }));

      const fused = service.fuseResults(vectorResults, textResults, 10);
      expect(fused.length).toBe(10);
    });

    it('should handle empty text results gracefully', () => {
      const vectorResults = [
        { id: 'a', score: 0.9 },
        { id: 'b', score: 0.8 },
      ];

      const fused = service.fuseResults(vectorResults, [], 10);
      expect(fused.length).toBe(2);
      expect(fused[0].id).toBe('a');
    });
  });

  describe('classifyQuery', () => {
    it('should increase text weight for acronym-heavy queries', () => {
      const weights = service.classifyQuery('MAP OB invoice');
      expect(weights.textWeight).toBeGreaterThan(0.4);
    });

    it('should increase text weight for ticket number queries', () => {
      const weights = service.classifyQuery('HEY-480');
      expect(weights.textWeight).toBeGreaterThan(0.5);
    });

    it('should use default weights for semantic queries', () => {
      const weights = service.classifyQuery(
        'What are the best practices for fundraising email campaigns?',
      );
      // Semantic queries should not dramatically shift weights
      expect(weights.vectorWeight).toBeGreaterThanOrEqual(0.4);
    });

    it('should increase text weight for short queries', () => {
      const short = service.classifyQuery('Beaux');
      const long = service.classifyQuery(
        'Tell me everything you know about the fundraising strategy discussion',
      );
      expect(short.textWeight).toBeGreaterThan(long.textWeight);
    });

    it('should handle empty queries', () => {
      const weights = service.classifyQuery('');
      expect(weights.vectorWeight).toBeDefined();
      expect(weights.textWeight).toBeDefined();
    });
  });
});

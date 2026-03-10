import { HttpException, HttpStatus } from '@nestjs/common';
import { MultiQueryController } from './multi-query.controller';
import { MultiQueryService } from './multi-query.service';
import { QueryExpansionService } from './query-expansion.service';
import { ExpansionStrategy } from './dto/multi-query.dto';

// Mock expansion-rules for getRulesInfo
jest.mock('./expansion-rules', () => ({
  SYNONYM_GROUPS: { greeting: ['hi', 'hello'], farewell: ['bye', 'goodbye'] },
  RELATED_CONCEPTS: { memory: ['recall', 'remember'] },
  PATTERN_RULES: [{ pattern: /test/, replacement: 'test' }],
}));

describe('MultiQueryController', () => {
  let controller: MultiQueryController;
  let multiQueryService: jest.Mocked<MultiQueryService>;
  let expansionService: jest.Mocked<QueryExpansionService>;

  beforeEach(() => {
    jest.clearAllMocks();

    multiQueryService = {
      isEnabled: jest.fn().mockReturnValue(true),
    } as any;

    expansionService = {
      expand: jest.fn(),
    } as any;

    controller = new MultiQueryController(multiQueryService, expansionService);
  });

  // =========================================================================
  // isEnabled
  // =========================================================================
  describe('isEnabled', () => {
    it('should return enabled true when service is enabled', () => {
      const result = controller.isEnabled();
      expect(result).toEqual({ enabled: true, version: '1.0.0' });
    });

    it('should return enabled false when service is disabled', () => {
      multiQueryService.isEnabled.mockReturnValue(false);
      const result = controller.isEnabled();
      expect(result).toEqual({ enabled: false, version: '1.0.0' });
    });
  });

  // =========================================================================
  // expandQuery
  // =========================================================================
  describe('expandQuery', () => {
    const mockExpansionResult = {
      original: 'test query',
      variants: ['test query', 'test search', 'testing query'],
      sources: ['rules', 'llm'],
      timings: { totalMs: 42 },
      llmUsed: true,
    };

    it('should expand a valid query with defaults', async () => {
      expansionService.expand.mockResolvedValue(mockExpansionResult as any);

      const result = await controller.expandQuery({ query: 'test query' });

      expect(result.original).toBe('test query');
      expect(result.variants).toHaveLength(3);
      expect(result.llmUsed).toBe(true);
      expect(expansionService.expand).toHaveBeenCalledWith('test query', {
        strategy: ExpansionStrategy.HYBRID,
        maxVariants: 7,
      });
    });

    it('should use provided strategy and maxVariants', async () => {
      expansionService.expand.mockResolvedValue(mockExpansionResult as any);

      await controller.expandQuery({
        query: 'hello',
        strategy: ExpansionStrategy.RULES,
        maxVariants: 3,
      });

      expect(expansionService.expand).toHaveBeenCalledWith('hello', {
        strategy: ExpansionStrategy.RULES,
        maxVariants: 3,
      });
    });

    it('should throw BAD_REQUEST when query is empty string', async () => {
      await expect(controller.expandQuery({ query: '' })).rejects.toThrow(
        new HttpException('Query is required', HttpStatus.BAD_REQUEST),
      );
    });

    it('should throw BAD_REQUEST when query is whitespace only', async () => {
      await expect(controller.expandQuery({ query: '   ' })).rejects.toThrow(
        new HttpException('Query is required', HttpStatus.BAD_REQUEST),
      );
    });

    it('should throw INTERNAL_SERVER_ERROR when expansion fails with Error', async () => {
      expansionService.expand.mockRejectedValue(
        new Error('LLM timeout'),
      );

      await expect(
        controller.expandQuery({ query: 'valid query' }),
      ).rejects.toThrow(
        new HttpException('LLM timeout', HttpStatus.INTERNAL_SERVER_ERROR),
      );
    });

    it('should throw generic message when expansion fails with non-Error', async () => {
      expansionService.expand.mockRejectedValue('unknown error');

      await expect(
        controller.expandQuery({ query: 'valid query' }),
      ).rejects.toThrow(
        new HttpException(
          'Failed to expand query',
          HttpStatus.INTERNAL_SERVER_ERROR,
        ),
      );
    });
  });

  // =========================================================================
  // getRulesInfo
  // =========================================================================
  describe('getRulesInfo', () => {
    it('should return counts of expansion rules', () => {
      const result = controller.getRulesInfo();
      expect(result.synonymGroups).toBe(2);
      expect(result.relatedConcepts).toBe(1);
      expect(result.patternRules).toBe(1);
      expect(result.strategies).toEqual(Object.values(ExpansionStrategy));
    });
  });

  // =========================================================================
  // testExpansion
  // =========================================================================
  describe('testExpansion', () => {
    it('should throw BAD_REQUEST when query is empty', async () => {
      await expect(
        controller.testExpansion({ query: '' }),
      ).rejects.toThrow(HttpException);
    });

    it('should throw BAD_REQUEST when query is whitespace', async () => {
      await expect(
        controller.testExpansion({ query: '  ' }),
      ).rejects.toThrow(HttpException);
    });

    it('should test all strategies and return results', async () => {
      expansionService.expand.mockResolvedValue({
        original: 'test',
        variants: ['test', 'testing'],
        sources: ['rules'],
        timings: { totalMs: 10 },
        llmUsed: false,
      } as any);

      const result = await controller.testExpansion({ query: 'test' });

      expect(result.query).toBe('test');
      const strategies = Object.values(ExpansionStrategy);
      for (const strategy of strategies) {
        expect(result.results[strategy]).toBeDefined();
        expect(result.results[strategy].variants).toEqual(['test', 'testing']);
        expect(result.results[strategy].count).toBe(2);
        expect(result.results[strategy].timeMs).toBe(10);
      }
    });

    it('should handle individual strategy failures gracefully', async () => {
      let callCount = 0;
      expansionService.expand.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('LLM failed');
        }
        return {
          original: 'q',
          variants: ['q', 'query'],
          sources: ['rules'],
          timings: { totalMs: 5 },
          llmUsed: false,
        } as any;
      });

      const result = await controller.testExpansion({ query: 'q' });

      // First strategy should have fallback
      const strategies = Object.values(ExpansionStrategy);
      expect(result.results[strategies[0]].variants).toEqual(['q']);
      expect(result.results[strategies[0]].count).toBe(1);
      expect(result.results[strategies[0]].llmUsed).toBe(false);
    });
  });
});

import { MemoryAdminController } from './memory-admin.controller';
import { BackfillService } from './backfill.service';
import { ConsolidationService } from './consolidation.service';

describe('MemoryAdminController', () => {
  let controller: MemoryAdminController;
  let backfillService: jest.Mocked<BackfillService>;
  let consolidationService: jest.Mocked<ConsolidationService>;

  const userId = 'user-123';

  beforeEach(() => {
    backfillService = {
      findMemoriesNeedingBackfill: jest.fn(),
      backfillExtractions: jest.fn(),
      backfillUserIdentity: jest.fn(),
      findUserByExternalIdPattern: jest.fn(),
    } as any;

    consolidationService = {
      promoteRecurringPatterns: jest.fn(),
      getStats: jest.fn(),
    } as any;

    const prismaService = {
      user: { findMany: jest.fn().mockResolvedValue([]) },
    } as any;

    controller = new MemoryAdminController(
      backfillService,
      consolidationService,
      prismaService,
    );
  });

  describe('getBackfillStatus', () => {
    it('should return count of memories needing backfill', async () => {
      backfillService.findMemoriesNeedingBackfill.mockResolvedValue([
        {},
        {},
        {},
      ] as any);

      const result = await controller.getBackfillStatus();

      expect(result).toEqual({ needsBackfill: 3 });
    });
  });

  describe('runBackfill', () => {
    it('should run backfill with defaults', async () => {
      const expected = { processed: 10, failed: 0 };
      backfillService.backfillExtractions.mockResolvedValue(expected as any);

      const result = await controller.runBackfill();

      expect(backfillService.backfillExtractions).toHaveBeenCalledWith({
        dryRun: false,
        batchSize: 50,
        delayMs: 500,
      });
    });

    it('should pass dryRun and batchSize params', async () => {
      backfillService.backfillExtractions.mockResolvedValue({} as any);

      await controller.runBackfill('true', '25');

      expect(backfillService.backfillExtractions).toHaveBeenCalledWith({
        dryRun: true,
        batchSize: 25,
        delayMs: 500,
      });
    });
  });

  describe('backfillUserIdentity', () => {
    it('should call backfill with body params', async () => {
      backfillService.backfillUserIdentity.mockResolvedValue({} as any);

      await controller.backfillUserIdentity({
        userId: 'u1',
        actualName: 'Alice',
        dryRun: true,
        batchSize: 500,
      });

      expect(backfillService.backfillUserIdentity).toHaveBeenCalledWith(
        'u1',
        'Alice',
        { dryRun: true, batchSize: 500 },
      );
    });
  });

  describe('lookupUserForBackfill', () => {
    it('should return empty array for empty pattern', async () => {
      const result = await controller.lookupUserForBackfill('');
      expect(result).toEqual([]);
    });

    it('should search by pattern', async () => {
      const expected = [{ id: 'u1', externalId: 'beaux' }];
      backfillService.findUserByExternalIdPattern.mockResolvedValue(expected);

      const result = await controller.lookupUserForBackfill('beaux');

      expect(result).toEqual(expected);
    });
  });

  describe('consolidate', () => {
    it('should run consolidation with defaults', async () => {
      consolidationService.promoteRecurringPatterns.mockResolvedValue(
        {} as any,
      );

      await controller.consolidate(userId);

      expect(
        consolidationService.promoteRecurringPatterns,
      ).toHaveBeenCalledWith(userId, {
        dryRun: false,
        minOccurrences: undefined,
        similarityThreshold: undefined,
      });
    });

    it('should parse query params', async () => {
      consolidationService.promoteRecurringPatterns.mockResolvedValue(
        {} as any,
      );

      await controller.consolidate(userId, 'true', '5', '0.9');

      expect(
        consolidationService.promoteRecurringPatterns,
      ).toHaveBeenCalledWith(userId, {
        dryRun: true,
        minOccurrences: 5,
        similarityThreshold: 0.9,
      });
    });
  });

  describe('getConsolidationStats', () => {
    it('should return stats for user', async () => {
      const expected = {
        totalMemories: 100,
        sessionMemories: 60,
        identityMemories: 20,
        projectMemories: 15,
        consolidatedCount: 5,
        potentialClusters: 3,
      };
      consolidationService.getStats.mockResolvedValue(expected);

      const result = await controller.getConsolidationStats(userId);

      expect(result).toEqual(expected);
    });
  });
});

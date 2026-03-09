import { Test, TestingModule } from '@nestjs/testing';
import {
  AttachmentPipelineService,
  AttachmentResult,
} from './attachment-pipeline.service';
import { PrismaService } from '../prisma/prisma.service';
import { EntityMentionService } from './entity-mention.service';
import { EntitySemanticService } from './entity-semantic.service';
import { AttachMethod } from '@prisma/client';

const mockPrisma = {
  memory: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
  },
  entityProfileMemory: {
    findMany: jest.fn(),
    createMany: jest.fn(),
  },
};

const mockMentionService = {
  detectMentions: jest.fn(),
};

const mockSemanticService = {
  findSemanticMatches: jest.fn(),
};

describe('AttachmentPipelineService', () => {
  let service: AttachmentPipelineService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttachmentPipelineService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EntityMentionService, useValue: mockMentionService },
        { provide: EntitySemanticService, useValue: mockSemanticService },
      ],
    }).compile();

    service = module.get<AttachmentPipelineService>(AttachmentPipelineService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('attachMemory', () => {
    const memory = { id: 'mem-1', raw: 'Alice Smith joined the team.' };

    beforeEach(() => {
      mockPrisma.memory.findFirst.mockResolvedValue(memory);
      mockPrisma.entityProfileMemory.findMany.mockResolvedValue([]);
      mockPrisma.entityProfileMemory.createMany.mockResolvedValue({ count: 1 });
    });

    it('should return empty result when memory is not found', async () => {
      mockPrisma.memory.findFirst.mockResolvedValue(null);
      mockMentionService.detectMentions.mockResolvedValue([]);
      mockSemanticService.findSemanticMatches.mockResolvedValue([]);

      const result = await service.attachMemory('missing', 'user-1');
      expect(result.attached).toHaveLength(0);
      expect(mockMentionService.detectMentions).not.toHaveBeenCalled();
    });

    it('should attach mention-detected profiles with AUTO_MENTION', async () => {
      mockMentionService.detectMentions.mockResolvedValue([
        { profileId: 'p1', matchedText: 'Alice Smith', matchType: 'exact', confidence: 1.0 },
      ]);
      mockSemanticService.findSemanticMatches.mockResolvedValue([]);

      const result = await service.attachMemory('mem-1', 'user-1');

      expect(result.attached).toHaveLength(1);
      expect(result.attached[0].profileId).toBe('p1');
      expect(result.attached[0].attachMethod).toBe(AttachMethod.AUTO_MENTION);
      expect(result.attached[0].relevanceScore).toBe(1.0);
    });

    it('should attach semantic-matched profiles with AUTO_SEMANTIC', async () => {
      mockMentionService.detectMentions.mockResolvedValue([]);
      mockSemanticService.findSemanticMatches.mockResolvedValue([
        { profileId: 'p2', similarity: 0.85 },
      ]);

      const result = await service.attachMemory('mem-1', 'user-1');

      expect(result.attached).toHaveLength(1);
      expect(result.attached[0].profileId).toBe('p2');
      expect(result.attached[0].attachMethod).toBe(AttachMethod.AUTO_SEMANTIC);
      expect(result.attached[0].relevanceScore).toBeCloseTo(0.85);
    });

    it('should prefer AUTO_MENTION over AUTO_SEMANTIC for same profile', async () => {
      mockMentionService.detectMentions.mockResolvedValue([
        { profileId: 'p1', matchedText: 'Alice', matchType: 'alias', confidence: 0.9 },
      ]);
      mockSemanticService.findSemanticMatches.mockResolvedValue([
        { profileId: 'p1', similarity: 0.8 },
      ]);

      const result = await service.attachMemory('mem-1', 'user-1');

      expect(result.attached).toHaveLength(1);
      expect(result.attached[0].attachMethod).toBe(AttachMethod.AUTO_MENTION);
      expect(result.attached[0].relevanceScore).toBe(0.9);
    });

    it('should skip profiles that are already attached (deduplication)', async () => {
      mockMentionService.detectMentions.mockResolvedValue([
        { profileId: 'p1', matchedText: 'Alice', matchType: 'exact', confidence: 1.0 },
      ]);
      mockSemanticService.findSemanticMatches.mockResolvedValue([]);

      // p1 is already attached
      mockPrisma.entityProfileMemory.findMany.mockResolvedValue([
        { profileId: 'p1' },
      ]);

      const result = await service.attachMemory('mem-1', 'user-1');

      expect(result.attached).toHaveLength(0);
      expect(result.skipped).toBe(1);
      expect(mockPrisma.entityProfileMemory.createMany).not.toHaveBeenCalled();
    });

    it('should filter mentions below confidence threshold', async () => {
      mockMentionService.detectMentions.mockResolvedValue([
        { profileId: 'p1', matchedText: 'Alice', matchType: 'normalized', confidence: 0.5 },
      ]);
      mockSemanticService.findSemanticMatches.mockResolvedValue([]);

      const result = await service.attachMemory('mem-1', 'user-1');

      expect(result.attached).toHaveLength(0);
      expect(mockPrisma.entityProfileMemory.createMany).not.toHaveBeenCalled();
    });

    it('should handle mention detection errors gracefully', async () => {
      mockMentionService.detectMentions.mockRejectedValue(
        new Error('DB error'),
      );
      mockSemanticService.findSemanticMatches.mockResolvedValue([
        { profileId: 'p2', similarity: 0.9 },
      ]);

      const result = await service.attachMemory('mem-1', 'user-1');

      // Should still get semantic matches even if mentions failed
      expect(result.attached).toHaveLength(1);
      expect(result.attached[0].attachMethod).toBe(AttachMethod.AUTO_SEMANTIC);
    });

    it('should handle semantic matching errors gracefully', async () => {
      mockMentionService.detectMentions.mockResolvedValue([
        { profileId: 'p1', matchedText: 'Alice', matchType: 'exact', confidence: 1.0 },
      ]);
      mockSemanticService.findSemanticMatches.mockRejectedValue(
        new Error('Embed server down'),
      );

      const result = await service.attachMemory('mem-1', 'user-1');

      // Should still get mention matches even if semantic failed
      expect(result.attached).toHaveLength(1);
      expect(result.attached[0].attachMethod).toBe(AttachMethod.AUTO_MENTION);
    });

    it('should return empty result when no matches found', async () => {
      mockMentionService.detectMentions.mockResolvedValue([]);
      mockSemanticService.findSemanticMatches.mockResolvedValue([]);

      const result = await service.attachMemory('mem-1', 'user-1');

      expect(result.attached).toHaveLength(0);
      expect(result.skipped).toBe(0);
      expect(mockPrisma.entityProfileMemory.createMany).not.toHaveBeenCalled();
    });

    it('should call createMany with correct data', async () => {
      mockMentionService.detectMentions.mockResolvedValue([
        { profileId: 'p1', matchedText: 'Alice', matchType: 'exact', confidence: 1.0 },
      ]);
      mockSemanticService.findSemanticMatches.mockResolvedValue([
        { profileId: 'p2', similarity: 0.82 },
      ]);

      await service.attachMemory('mem-1', 'user-1');

      expect(mockPrisma.entityProfileMemory.createMany).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          expect.objectContaining({
            profileId: 'p1',
            memoryId: 'mem-1',
            attachMethod: AttachMethod.AUTO_MENTION,
          }),
          expect.objectContaining({
            profileId: 'p2',
            memoryId: 'mem-1',
            attachMethod: AttachMethod.AUTO_SEMANTIC,
          }),
        ]),
        skipDuplicates: true,
      });
    });
  });

  describe('attachBatch', () => {
    it('should return empty result for empty input', async () => {
      const result = await service.attachBatch([], 'user-1');
      expect(result.processed).toBe(0);
      expect(result.totalAttached).toBe(0);
      expect(result.results).toHaveLength(0);
    });

    it('should process multiple memories', async () => {
      mockPrisma.memory.findFirst
        .mockResolvedValueOnce({ id: 'mem-1', raw: 'text 1' })
        .mockResolvedValueOnce({ id: 'mem-2', raw: 'text 2' });
      mockPrisma.entityProfileMemory.findMany.mockResolvedValue([]);
      mockPrisma.entityProfileMemory.createMany.mockResolvedValue({ count: 1 });
      mockMentionService.detectMentions
        .mockResolvedValueOnce([
          { profileId: 'p1', matchedText: 'Alice', matchType: 'exact', confidence: 1.0 },
        ])
        .mockResolvedValueOnce([]);
      mockSemanticService.findSemanticMatches.mockResolvedValue([]);

      const result = await service.attachBatch(['mem-1', 'mem-2'], 'user-1');

      expect(result.processed).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.totalAttached).toBe(1);
      expect(result.results).toHaveLength(2);
    });
  });

  describe('onMemoryCreated', () => {
    it('should call attachMemory and not throw on error', async () => {
      mockPrisma.memory.findFirst.mockResolvedValue({ id: 'mem-1', raw: 'text' });
      mockMentionService.detectMentions.mockResolvedValue([]);
      mockSemanticService.findSemanticMatches.mockResolvedValue([]);

      await expect(
        service.onMemoryCreated('mem-1', 'user-1'),
      ).resolves.not.toThrow();
    });

    it('should not throw even if attachMemory throws', async () => {
      mockPrisma.memory.findFirst.mockRejectedValue(new Error('DB down'));

      await expect(
        service.onMemoryCreated('mem-1', 'user-1'),
      ).resolves.not.toThrow();
    });
  });

  describe('scanRecentUnattached', () => {
    it('should scan unattached memories and attach them', async () => {
      mockPrisma.memory.findMany.mockResolvedValue([
        { id: 'mem-1' },
        { id: 'mem-2' },
      ]);
      mockPrisma.memory.findFirst
        .mockResolvedValueOnce({ id: 'mem-1', raw: 'text 1' })
        .mockResolvedValueOnce({ id: 'mem-2', raw: 'text 2' });
      mockPrisma.entityProfileMemory.findMany.mockResolvedValue([]);
      mockPrisma.entityProfileMemory.createMany.mockResolvedValue({ count: 0 });
      mockMentionService.detectMentions.mockResolvedValue([]);
      mockSemanticService.findSemanticMatches.mockResolvedValue([]);

      const result = await service.scanRecentUnattached('user-1', 10);

      expect(mockPrisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: 'user-1',
            deletedAt: null,
            entityProfiles: { none: {} },
          }),
          take: 10,
        }),
      );
      expect(result.processed).toBe(2);
    });
  });
});

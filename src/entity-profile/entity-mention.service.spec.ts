import { Test, TestingModule } from '@nestjs/testing';
import { EntityMentionService } from './entity-mention.service';
import { PrismaService } from '../prisma/prisma.service';

const mockPrisma = {
  entityProfile: {
    findMany: jest.fn(),
  },
};

describe('EntityMentionService', () => {
  let service: EntityMentionService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EntityMentionService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<EntityMentionService>(EntityMentionService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('detectMentions', () => {
    const profiles = [
      {
        id: 'p1',
        name: 'Alice Smith',
        normalizedName: 'alice smith',
        aliases: ['Ally', 'A.S.'],
      },
      {
        id: 'p2',
        name: 'OpenAI',
        normalizedName: 'openai',
        aliases: ['Open AI'],
      },
      {
        id: 'p3',
        name: 'NestJS',
        normalizedName: 'nestjs',
        aliases: ['Nest'],
      },
    ];

    beforeEach(() => {
      mockPrisma.entityProfile.findMany.mockResolvedValue(profiles);
    });

    it('should detect exact name match', async () => {
      const result = await service.detectMentions(
        'Alice Smith sent me a message.',
        'user-1',
      );
      expect(result).toHaveLength(1);
      expect(result[0].profileId).toBe('p1');
      expect(result[0].matchType).toBe('exact');
      expect(result[0].confidence).toBe(1.0);
    });

    it('should detect alias match', async () => {
      const result = await service.detectMentions(
        'I talked to Ally today about the project.',
        'user-1',
      );
      expect(result).toHaveLength(1);
      expect(result[0].profileId).toBe('p1');
      expect(result[0].matchType).toBe('alias');
      expect(result[0].confidence).toBe(0.9);
    });

    it('should be case-insensitive for name match', async () => {
      const result = await service.detectMentions(
        'alice smith mentioned NestJS.',
        'user-1',
      );
      expect(result.map((r) => r.profileId).sort()).toEqual(['p1', 'p3'].sort());
    });

    it('should detect multiple entities in one text', async () => {
      const result = await service.detectMentions(
        'OpenAI and Alice Smith are both mentioned here.',
        'user-1',
      );
      const ids = result.map((r) => r.profileId).sort();
      expect(ids).toEqual(['p1', 'p2'].sort());
    });

    it('should return empty array when no profiles exist', async () => {
      mockPrisma.entityProfile.findMany.mockResolvedValue([]);
      const result = await service.detectMentions('Some text', 'user-1');
      expect(result).toHaveLength(0);
    });

    it('should return empty array for empty text', async () => {
      const result = await service.detectMentions('', 'user-1');
      expect(result).toHaveLength(0);
      expect(mockPrisma.entityProfile.findMany).not.toHaveBeenCalled();
    });

    it('should not match partial word substrings', async () => {
      // "Nest" should not match inside "NestJS" if "Nest" is an alias
      // but "Nest" as its own word should match
      const result = await service.detectMentions(
        'I use Nest for dependency injection.',
        'user-1',
      );
      // "Nest" is an alias for p3 (NestJS), should match
      const nestMatch = result.find((r) => r.profileId === 'p3');
      expect(nestMatch).toBeDefined();
    });

    it('should not match when name is only substring in a word', async () => {
      // "AI" should not match inside "SAIL" or "AWAIT"
      const profiles2 = [
        { id: 'px', name: 'AI', normalizedName: 'ai', aliases: [] },
      ];
      mockPrisma.entityProfile.findMany.mockResolvedValue(profiles2);
      const result = await service.detectMentions(
        'We are sailing towards AI capabilities.',
        'user-1',
      );
      // "AI" should match as a word, not inside "sailing"
      const match = result.find((r) => r.matchedText.toLowerCase() === 'ai');
      expect(match).toBeDefined();
      expect(result.length).toBe(1);
    });

    it('should detect multi-word alias match', async () => {
      const result = await service.detectMentions(
        'Open AI released a new model yesterday.',
        'user-1',
      );
      expect(result).toHaveLength(1);
      expect(result[0].profileId).toBe('p2');
      expect(result[0].matchType).toBe('alias');
    });

    it('should query prisma with correct userId', async () => {
      await service.detectMentions('some text', 'user-42');
      expect(mockPrisma.entityProfile.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-42', deletedAt: null },
        select: {
          id: true,
          name: true,
          normalizedName: true,
          aliases: true,
        },
      });
    });
  });
});

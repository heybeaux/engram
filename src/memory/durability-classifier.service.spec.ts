import { Test, TestingModule } from '@nestjs/testing';
import { DurabilityClassifierService } from './durability-classifier.service';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryDurability } from '@prisma/client';

describe('DurabilityClassifierService', () => {
  let service: DurabilityClassifierService;
  let mockPrisma: any;

  beforeEach(async () => {
    mockPrisma = {
      memory: {
        update: jest.fn().mockResolvedValue({}),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DurabilityClassifierService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get(DurabilityClassifierService);
  });

  describe('classify', () => {
    // ── DURABLE: Preference patterns ──────────────────────────────

    it('classifies "I prefer oat milk" as DURABLE', () => {
      expect(
        service.classify('I prefer oat milk in my coffee every morning'),
      ).toBe(MemoryDurability.DURABLE);
    });

    it('classifies "I like" statements as DURABLE', () => {
      expect(service.classify('I like going for walks in the evening')).toBe(
        MemoryDurability.DURABLE,
      );
    });

    it('classifies "I love" statements as DURABLE', () => {
      expect(service.classify('I love reading science fiction novels')).toBe(
        MemoryDurability.DURABLE,
      );
    });

    it('classifies "I hate" statements as DURABLE', () => {
      expect(service.classify('I hate when people chew loudly')).toBe(
        MemoryDurability.DURABLE,
      );
    });

    it('classifies "I always" statements as DURABLE', () => {
      expect(
        service.classify('I always drink water first thing in the morning'),
      ).toBe(MemoryDurability.DURABLE);
    });

    it('classifies "I never" statements as DURABLE', () => {
      expect(service.classify('I never eat breakfast before noon')).toBe(
        MemoryDurability.DURABLE,
      );
    });

    it('classifies "my favourite" (British spelling) as DURABLE', () => {
      expect(
        service.classify('My favourite color is blue and always has been'),
      ).toBe(MemoryDurability.DURABLE);
    });

    it('classifies "my favorite" (American spelling) as DURABLE', () => {
      expect(
        service.classify('My favorite food is pizza with extra cheese'),
      ).toBe(MemoryDurability.DURABLE);
    });

    it('classifies "I enjoy" statements as DURABLE', () => {
      expect(service.classify('I enjoy cooking Italian food on weekends')).toBe(
        MemoryDurability.DURABLE,
      );
    });

    // ── DURABLE: Stated fact patterns ─────────────────────────────

    it('classifies "my name is" as DURABLE', () => {
      expect(service.classify('My name is Sarah and I work in tech')).toBe(
        MemoryDurability.DURABLE,
      );
    });

    it('classifies "I work at" as DURABLE', () => {
      expect(service.classify('I work at a startup in downtown Seattle')).toBe(
        MemoryDurability.DURABLE,
      );
    });

    it('classifies "I live in" as DURABLE', () => {
      expect(
        service.classify('I live in Portland, Oregon with my family'),
      ).toBe(MemoryDurability.DURABLE);
    });

    it('classifies family member mentions as DURABLE', () => {
      expect(
        service.classify('My daughter just started kindergarten this year'),
      ).toBe(MemoryDurability.DURABLE);
      expect(service.classify('My son is learning to play the piano now')).toBe(
        MemoryDurability.DURABLE,
      );
      expect(service.classify('My wife works as a nurse at the hospital')).toBe(
        MemoryDurability.DURABLE,
      );
      expect(
        service.classify('My husband is an engineer at a tech company'),
      ).toBe(MemoryDurability.DURABLE);
      expect(service.classify('My partner and I moved here last year')).toBe(
        MemoryDurability.DURABLE,
      );
    });

    it('classifies "my dog" as DURABLE', () => {
      expect(service.classify('My dog is a golden retriever named Buddy')).toBe(
        MemoryDurability.DURABLE,
      );
    });

    it('classifies "I was born" as DURABLE', () => {
      expect(service.classify('I was born in Chicago in the early 1990s')).toBe(
        MemoryDurability.DURABLE,
      );
    });

    it('classifies "my job" as DURABLE', () => {
      expect(service.classify('My job is to manage the engineering team')).toBe(
        MemoryDurability.DURABLE,
      );
    });

    it('classifies goal statements as DURABLE', () => {
      expect(service.classify('My goal is to run a marathon this year')).toBe(
        MemoryDurability.DURABLE,
      );
    });

    it('classifies "I decided" statements as DURABLE', () => {
      expect(service.classify('I decided to switch to a vegetarian diet')).toBe(
        MemoryDurability.DURABLE,
      );
    });

    // ── DURABLE: Named entity detection ───────────────────────────

    it('classifies content with named entities as DURABLE', () => {
      expect(
        service.classify('I had a meeting with John about the project today'),
      ).toBe(MemoryDurability.DURABLE);
    });

    it('classifies content with place names as DURABLE', () => {
      expect(
        service.classify('We visited the Louvre museum during our trip'),
      ).toBe(MemoryDurability.DURABLE);
    });

    // ── DURABLE: Concrete numbers ─────────────────────────────────

    it('classifies age mentions as DURABLE', () => {
      expect(
        service.classify("I'm 32 years old and live in the city center"),
      ).toBe(MemoryDurability.DURABLE);
    });

    it('classifies birth year as DURABLE', () => {
      expect(service.classify('She was born in 1990 in a small town')).toBe(
        MemoryDurability.DURABLE,
      );
    });

    // ── EPHEMERAL: Generic filler ─────────────────────────────────

    it('classifies "Had a good day today" as EPHEMERAL', () => {
      expect(service.classify('Had a good day today at work')).toBe(
        MemoryDurability.EPHEMERAL,
      );
    });

    it('classifies "busy week" content as EPHEMERAL', () => {
      expect(service.classify('It was a really busy week at the office')).toBe(
        MemoryDurability.EPHEMERAL,
      );
    });

    it('classifies "feeling tired" as EPHEMERAL', () => {
      expect(service.classify('I am feeling tired after a long day')).toBe(
        MemoryDurability.EPHEMERAL,
      );
    });

    it('classifies generic content without signals as EPHEMERAL', () => {
      expect(service.classify('nothing special happened today at all')).toBe(
        MemoryDurability.EPHEMERAL,
      );
    });

    // ── EPHEMERAL: Short content ──────────────────────────────────

    it('classifies short content (< 30 chars) as EPHEMERAL', () => {
      expect(service.classify('ok sounds good')).toBe(
        MemoryDurability.EPHEMERAL,
      );
    });

    it('classifies very short content as EPHEMERAL', () => {
      expect(service.classify('yes')).toBe(MemoryDurability.EPHEMERAL);
    });

    // ── Edge cases ────────────────────────────────────────────────

    it('classifies empty string as EPHEMERAL', () => {
      expect(service.classify('')).toBe(MemoryDurability.EPHEMERAL);
    });

    it('classifies whitespace-only string as EPHEMERAL', () => {
      expect(service.classify('   \n\t  ')).toBe(MemoryDurability.EPHEMERAL);
    });

    it('is case-insensitive for preference patterns', () => {
      expect(
        service.classify('I PREFER dark mode for all my applications'),
      ).toBe(MemoryDurability.DURABLE);
    });

    it('does not treat start-of-sentence capitals as named entities', () => {
      expect(
        service.classify('the weather was nice and warm today outside'),
      ).toBe(MemoryDurability.EPHEMERAL);
    });

    it('does not treat common capitalised words as named entities', () => {
      // "Monday" is in the common-capitalised set
      expect(
        service.classify('it was a quiet Monday with nothing going on'),
      ).toBe(MemoryDurability.EPHEMERAL);
    });
  });

  describe('classifyBatch', () => {
    it('classifies and persists a batch of memories', async () => {
      const memories = [
        { id: 'mem-1', content: 'I prefer oat milk in my morning coffee' },
        { id: 'mem-2', content: 'Had a good day today at the office' },
      ];

      await service.classifyBatch(memories);

      expect(mockPrisma.memory.update).toHaveBeenCalledTimes(2);
      expect(mockPrisma.memory.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'mem-1' },
          data: expect.objectContaining({
            durability: MemoryDurability.DURABLE,
          }),
        }),
      );
      expect(mockPrisma.memory.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'mem-2' },
          data: expect.objectContaining({
            durability: MemoryDurability.EPHEMERAL,
          }),
        }),
      );
    });

    it('continues processing on individual failure', async () => {
      mockPrisma.memory.update
        .mockRejectedValueOnce(new Error('DB error'))
        .mockResolvedValueOnce({});

      const memories = [
        { id: 'mem-1', content: 'I prefer oat milk in my morning coffee' },
        { id: 'mem-2', content: 'My name is Sarah and I work at a startup' },
      ];

      await service.classifyBatch(memories);

      // Second call should still happen
      expect(mockPrisma.memory.update).toHaveBeenCalledTimes(2);
    });

    it('handles empty batch', async () => {
      await service.classifyBatch([]);
      expect(mockPrisma.memory.update).not.toHaveBeenCalled();
    });
  });
});

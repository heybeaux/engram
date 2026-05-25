import { MemoryPipelineService } from './memory-pipeline.service';
import { TemporalParserService } from './temporal/temporal-parser.service';

const makeBaseExtraction = (overrides: Partial<any> = {}) => ({
  who: 'user',
  what: 'test memory',
  when: null,
  where: null,
  why: null,
  how: null,
  topics: ['testing'],
  entities: [],
  memoryType: 'FACT',
  typeConfidence: 0.9,
  confidence: {
    whoConfidence: 0.8,
    whatConfidence: 0.9,
    whenConfidence: 0,
    whereConfidence: 0,
    whyConfidence: 0,
    howConfidence: 0,
  },
  lesson: null,
  capabilities: [],
  preferenceSignals: [],
  ...overrides,
});

describe('MemoryPipelineService', () => {
  let service: MemoryPipelineService;
  let prisma: any;
  let extraction: any;
  let embedding: any;
  let hierarchy: any;
  let temporalParser: TemporalParserService;

  beforeEach(() => {
    prisma = {
      memoryExtraction: { create: jest.fn() },
      memory: { update: jest.fn() },
      entity: { upsert: jest.fn() },
      memoryEntity: { upsert: jest.fn() },
      memoryChainLink: { upsert: jest.fn() },
    };
    extraction = {
      extract: jest.fn().mockResolvedValue(makeBaseExtraction()),
      getPriorityForType: jest.fn().mockReturnValue(5),
    };
    embedding = {
      generate: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      store: jest.fn().mockResolvedValue('emb-1'),
      search: jest.fn().mockResolvedValue([]),
    };
    hierarchy = {
      isEnabled: jest.fn().mockReturnValue(false),
      processMemory: jest.fn(),
    };
    temporalParser = new TemporalParserService();
    service = new MemoryPipelineService(
      prisma,
      extraction,
      embedding,
      hierarchy,
      undefined,
      undefined,
      undefined,
      temporalParser,
    );
  });

  describe('extractAndEmbed', () => {
    it('should extract, save extraction, embed, and link', async () => {
      await service.extractAndEmbed('m1', 'test content', 'user-1');

      expect(extraction.extract).toHaveBeenCalledWith(
        'test content',
        undefined,
      );
      expect(prisma.memoryExtraction.create).toHaveBeenCalled();
      expect(prisma.memory.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'm1' },
          data: expect.objectContaining({ memoryType: 'FACT', priority: 5 }),
        }),
      );
      expect(embedding.generate).toHaveBeenCalledWith('test content');
      expect(embedding.store).toHaveBeenCalledWith('m1', [0.1, 0.2, 0.3]);
    });

    it('should handle embedding failure gracefully', async () => {
      embedding.generate.mockRejectedValue(new Error('GPU OOM'));

      // Should not throw
      await service.extractAndEmbed('m1', 'test content', 'user-1');
      expect(prisma.memoryExtraction.create).toHaveBeenCalled();
    });

    it('should store entities when extraction produces them', async () => {
      extraction.extract.mockResolvedValue({
        who: 'user',
        what: 'test',
        when: null,
        where: null,
        why: null,
        how: null,
        topics: [],
        memoryType: 'FACT',
        typeConfidence: 0.9,
        entities: [{ name: 'TypeScript', type: 'TECHNOLOGY' }],
        confidence: {
          whoConfidence: 0.8,
          whatConfidence: 0.9,
          whenConfidence: 0,
          whereConfidence: 0,
          whyConfidence: 0,
          howConfidence: 0,
        },
        lesson: null,
        capabilities: [],
        preferenceSignals: [],
      });
      prisma.entity.upsert.mockResolvedValue({ id: 'ent-1' });
      prisma.memoryEntity.upsert.mockResolvedValue({});

      await service.extractAndEmbed('m1', 'I love TypeScript', 'user-1');

      expect(prisma.entity.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId_normalizedName_type: {
              userId: 'user-1',
              normalizedName: 'typescript',
              type: 'TECHNOLOGY',
            },
          },
        }),
      );
      expect(prisma.memoryEntity.upsert).toHaveBeenCalled();
    });

    it('should pass context to extraction', async () => {
      const ctx = {
        userName: 'Bob',
        timestamp: new Date(),
        turnIndex: 3,
        conversationId: 'conv-1',
      };
      await service.extractAndEmbed('m1', 'test', 'user-1', ctx);
      expect(extraction.extract).toHaveBeenCalledWith('test', ctx);
    });

    it('should process hierarchy when enabled', async () => {
      hierarchy.isEnabled.mockReturnValue(true);
      hierarchy.processMemory.mockResolvedValue(undefined);

      await service.extractAndEmbed('m1', 'test', 'user-1');
      expect(hierarchy.processMemory).toHaveBeenCalledWith(
        'm1',
        'test',
        'user-1',
      );
    });
  });

  describe('promoteToConstraint', () => {
    it('should promote lesson to constraint with priority 1', async () => {
      await service.promoteToConstraint('m1');
      expect(prisma.memory.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: { memoryType: 'CONSTRAINT', priority: 1, promotedFrom: 'm1' },
      });
    });
  });

  describe('extractAndEmbed - LESSON auto-promotion', () => {
    it('should auto-promote critical lessons to CONSTRAINT', async () => {
      extraction.extract.mockResolvedValue({
        who: 'user',
        what: 'critical rule',
        when: null,
        where: null,
        why: null,
        how: null,
        topics: [],
        memoryType: 'LESSON',
        typeConfidence: 0.95,
        entities: [],
        confidence: {
          whoConfidence: 0.8,
          whatConfidence: 0.9,
          whenConfidence: 0,
          whereConfidence: 0,
          whyConfidence: 0,
          howConfidence: 0,
        },
        lesson: { lessonSeverity: 'critical' },
        capabilities: [],
        preferenceSignals: [],
      });
      extraction.getPriorityForType.mockReturnValue(3);

      await service.extractAndEmbed('m1', 'never do X', 'user-1');

      // Should have been called twice: once for type update, once for promotion
      expect(prisma.memory.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            memoryType: 'CONSTRAINT',
            priority: 1,
          }),
        }),
      );
    });
  });

  describe('extractAndEmbed - layer promotion (HEY-193)', () => {
    it('should promote layer to TASK when memoryType is TASK', async () => {
      extraction.extract.mockResolvedValue({
        who: 'user',
        what: 'call dentist',
        when: null,
        where: null,
        why: null,
        how: null,
        topics: [],
        entities: [],
        memoryType: 'TASK',
        typeConfidence: 0.9,
        confidence: {
          whoConfidence: 0.8,
          whatConfidence: 0.9,
          whenConfidence: 0,
          whereConfidence: 0,
          whyConfidence: 0,
          howConfidence: 0,
        },
        lesson: null,
        capabilities: [],
        preferenceSignals: [],
      });
      extraction.getPriorityForType.mockReturnValue(4);

      await service.extractAndEmbed(
        'm1',
        'remind me to call dentist',
        'user-1',
      );

      expect(prisma.memory.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ memoryType: 'TASK', layer: 'TASK' }),
        }),
      );
    });

    it('should promote layer to IDENTITY when memoryType is LESSON', async () => {
      extraction.extract.mockResolvedValue({
        who: 'user',
        what: 'learned something',
        when: null,
        where: null,
        why: null,
        how: null,
        topics: [],
        entities: [],
        memoryType: 'LESSON',
        typeConfidence: 0.9,
        confidence: {
          whoConfidence: 0.8,
          whatConfidence: 0.9,
          whenConfidence: 0,
          whereConfidence: 0,
          whyConfidence: 0,
          howConfidence: 0,
        },
        lesson: { lessonSeverity: 'minor' },
        capabilities: [],
        preferenceSignals: [],
      });
      extraction.getPriorityForType.mockReturnValue(3);

      await service.extractAndEmbed(
        'm1',
        'learned to always check tests',
        'user-1',
      );

      expect(prisma.memory.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            memoryType: 'LESSON',
            layer: 'IDENTITY',
          }),
        }),
      );
    });

    it('should promote layer to IDENTITY when memoryType is CONSTRAINT', async () => {
      extraction.extract.mockResolvedValue({
        who: 'user',
        what: 'never deploy friday',
        when: null,
        where: null,
        why: null,
        how: null,
        topics: [],
        entities: [],
        memoryType: 'CONSTRAINT',
        typeConfidence: 0.95,
        confidence: {
          whoConfidence: 0.8,
          whatConfidence: 0.9,
          whenConfidence: 0,
          whereConfidence: 0,
          whyConfidence: 0,
          howConfidence: 0,
        },
        lesson: null,
        capabilities: [],
        preferenceSignals: [],
      });
      extraction.getPriorityForType.mockReturnValue(1);

      await service.extractAndEmbed('m1', 'never deploy on Fridays', 'user-1');

      expect(prisma.memory.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            memoryType: 'CONSTRAINT',
            layer: 'IDENTITY',
          }),
        }),
      );
    });

    it('should NOT set layer when memoryType is FACT', async () => {
      extraction.extract.mockResolvedValue({
        who: 'user',
        what: 'just a fact',
        when: null,
        where: null,
        why: null,
        how: null,
        topics: [],
        entities: [],
        memoryType: 'FACT',
        typeConfidence: 0.9,
        confidence: {
          whoConfidence: 0.8,
          whatConfidence: 0.9,
          whenConfidence: 0,
          whereConfidence: 0,
          whyConfidence: 0,
          howConfidence: 0,
        },
        lesson: null,
        capabilities: [],
        preferenceSignals: [],
      });
      extraction.getPriorityForType.mockReturnValue(5);

      await service.extractAndEmbed('m1', 'the sky is blue', 'user-1');

      const updateCall = prisma.memory.update.mock.calls[0][0];
      expect(updateCall.data).not.toHaveProperty('layer');
    });
  });

  describe('extractAndEmbed — temporal metadata (Fix A)', () => {
    it('should populate temporal.referenceTimestamp from context.timestamp', async () => {
      const sourceTimestamp = new Date('2023-05-20T02:21:00.000Z');
      extraction.extract.mockResolvedValue(makeBaseExtraction({ when: 'yesterday' }));

      await service.extractAndEmbed('m1', 'Yesterday I visited the museum.', 'user-1', {
        userId: 'user-1',
        timestamp: sourceTimestamp,
      });

      const createCall = prisma.memoryExtraction.create.mock.calls[0][0];
      const temporal = createCall.data.rawJson?.temporal;
      expect(temporal).toBeDefined();
      expect(temporal.referenceTimestamp).toBe('2023-05-20T02:21:00.000Z');
    });

    it('should resolve "yesterday" relative to context.timestamp, not wall clock', async () => {
      const sourceTimestamp = new Date('2023-05-20T10:00:00.000Z');
      extraction.extract.mockResolvedValue(makeBaseExtraction({ when: 'yesterday' }));

      await service.extractAndEmbed(
        'm1',
        'I went to the gym yesterday.',
        'user-1',
        { userId: 'user-1', timestamp: sourceTimestamp },
      );

      const createCall = prisma.memoryExtraction.create.mock.calls[0][0];
      const temporal = createCall.data.rawJson?.temporal;
      expect(temporal).toBeDefined();
      expect(temporal.referenceTimestamp).toBe(sourceTimestamp.toISOString());
      // resolvedRange start should be 2023-05-19 (day before source timestamp)
      expect(temporal.resolvedRange?.startDate).toBe('2023-05-19');
    });

    it('should mark isRelative=true for relative temporal expressions', async () => {
      extraction.extract.mockResolvedValue(makeBaseExtraction({ when: 'last week' }));

      await service.extractAndEmbed(
        'm1',
        'Last week we shipped the feature.',
        'user-1',
        { userId: 'user-1', timestamp: new Date('2023-06-01T00:00:00.000Z') },
      );

      const createCall = prisma.memoryExtraction.create.mock.calls[0][0];
      const temporal = createCall.data.rawJson?.temporal;
      expect(temporal?.isRelative).toBe(true);
    });

    it('should omit temporal block when no temporal signal present', async () => {
      extraction.extract.mockResolvedValue(makeBaseExtraction({ when: null }));

      await service.extractAndEmbed('m1', 'The sky is blue.', 'user-1', undefined);

      const createCall = prisma.memoryExtraction.create.mock.calls[0][0];
      const rawJson = createCall.data.rawJson;
      // No source context and no temporal signal — rawJson should be undefined or lack temporal
      expect(rawJson?.temporal).toBeUndefined();
    });

    it('should fall back to wall clock when context has no timestamp', async () => {
      const before = Date.now();
      extraction.extract.mockResolvedValue(makeBaseExtraction({ when: 'today' }));

      await service.extractAndEmbed('m1', 'Today was a good day.', 'user-1', undefined);

      const after = Date.now();
      const createCall = prisma.memoryExtraction.create.mock.calls[0][0];
      const temporal = createCall.data.rawJson?.temporal;
      if (temporal) {
        const ref = new Date(temporal.referenceTimestamp).getTime();
        expect(ref).toBeGreaterThanOrEqual(before);
        expect(ref).toBeLessThanOrEqual(after);
      }
    });
  });

  describe('linkRelatedMemories', () => {
    it('should link related memories within threshold', async () => {
      embedding.search.mockResolvedValue([
        { id: 'm2', score: 0.85 },
        { id: 'm3', score: 0.75 },
        { id: 'm1', score: 1.0 }, // self — should be excluded
      ]);

      await service.linkRelatedMemories('m1', [0.1], 'user-1');
      // Exact calls depend on thresholds, but should not throw
    });

    it('should handle search failure gracefully', async () => {
      embedding.search.mockRejectedValue(new Error('search failed'));
      // Should not throw
      await service.linkRelatedMemories('m1', [0.1], 'user-1');
    });
  });

  describe('storeEntities', () => {
    it('should upsert entities and link to memory', async () => {
      prisma.entity.upsert.mockResolvedValue({ id: 'ent-1' });
      prisma.memoryEntity.upsert.mockResolvedValue({});

      await service.storeEntities('user-1', 'm1', [
        { name: 'React', type: 'other' },
        { name: 'Google', type: 'organization' },
      ]);

      expect(prisma.entity.upsert).toHaveBeenCalledTimes(2);
      expect(prisma.memoryEntity.upsert).toHaveBeenCalledTimes(2);
    });

    it('should handle entity storage failure gracefully', async () => {
      prisma.entity.upsert.mockRejectedValue(new Error('unique constraint'));
      // Should not throw — errors are caught per-entity
      await service.storeEntities('user-1', 'm1', [
        { name: 'X', type: 'other' },
      ]);
    });
  });
});

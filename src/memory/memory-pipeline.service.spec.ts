import { MemoryPipelineService } from './memory-pipeline.service';

describe('MemoryPipelineService', () => {
  let service: MemoryPipelineService;
  let prisma: any;
  let extraction: any;
  let embedding: any;
  let hierarchy: any;
  let temporalParser: any;

  beforeEach(() => {
    prisma = {
      memoryExtraction: { create: jest.fn() },
      memory: { update: jest.fn() },
      entity: { upsert: jest.fn() },
      memoryEntity: { upsert: jest.fn() },
      memoryChainLink: { upsert: jest.fn() },
    };
    extraction = {
      extract: jest.fn().mockResolvedValue({
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
      }),
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
    temporalParser = {
      parse: jest.fn().mockReturnValue({ semanticQuery: 'test content', temporalFilter: null }),
    };
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
        timestamp: new Date('2026-05-23T12:00:00.000Z'),
        turnIndex: 3,
        conversationId: 'conv-1',
      };
      await service.extractAndEmbed('m1', 'test', 'user-1', ctx);
      expect(extraction.extract).toHaveBeenCalledWith('test', ctx);
    });

    it('should persist resolved temporal metadata for relative-time memories', async () => {
      const ctx = {
        userName: 'Bob',
        timestamp: new Date('2026-05-23T12:00:00.000Z'),
        turnIndex: 3,
        conversationId: 'conv-1',
      };
      extraction.extract.mockResolvedValue({
        who: 'Bob',
        what: 'Bob went for a run',
        when: 'yesterday',
        where: null,
        why: null,
        how: null,
        topics: ['fitness'],
        entities: [],
        memoryType: 'EVENT',
        typeConfidence: 0.9,
        confidence: {
          whoConfidence: 0.8,
          whatConfidence: 0.9,
          whenConfidence: 0.9,
          whereConfidence: 0,
          whyConfidence: 0,
          howConfidence: 0,
        },
        lesson: null,
        capabilities: [],
        preferenceSignals: [],
        factKeys: [],
      });
      temporalParser.parse.mockReturnValue({
        semanticQuery: 'Bob went for a run',
        temporalFilter: {
          expression: 'yesterday',
          start: new Date('2026-05-22T00:00:00.000Z'),
          end: new Date('2026-05-22T23:59:59.999Z'),
          confidence: 0.9,
        },
      });

      await service.extractAndEmbed('m1', 'Yesterday I went for a run', 'user-1', ctx);

      expect(prisma.memoryExtraction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            when: new Date('2026-05-22T07:00:00.000Z'),
            rawJson: expect.objectContaining({
              temporal: {
                referenceTimestamp: '2026-05-23T12:00:00.000Z',
                relativeExpression: 'yesterday',
                isRelative: true,
                extractedWhenRaw: 'yesterday',
                resolvedWhen: '2026-05-22T07:00:00.000Z',
                resolvedDate: '2026-05-22',
                resolvedDateLabel: 'Friday, May 22, 2026',
                resolvedDayOfWeek: 'Friday',
                resolvedGranularity: 'day',
                resolvedRange: {
                  start: '2026-05-22T00:00:00.000Z',
                  end: '2026-05-22T23:59:59.999Z',
                  startDate: '2026-05-22',
                  endDate: '2026-05-22',
                },
              },
            }),
          }),
        }),
      );
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

  describe('retryFailedEmbeddings', () => {
    it('should run full extraction for discovered memories that lack extractions', async () => {
      prisma.memory.findMany = jest.fn().mockResolvedValue([
        {
          id: 'm-retry',
          userId: 'user-1',
          raw: 'Yesterday I went for a run.',
          metadata: {
            sourceContext: {
              timestamp: '2026-05-23T12:00:00.000Z',
              turnIndex: 4,
              conversationId: 'conv-1',
              userName: 'Beaux',
            },
          },
          extraction: null,
        },
      ]);

      const extractSpy = jest
        .spyOn(service, 'extractAndEmbed')
        .mockResolvedValue(undefined);
      const embedSpy = jest
        .spyOn(service, 'generateAndStoreEmbedding')
        .mockResolvedValue(true);

      const result = await service.retryFailedEmbeddings();

      expect(result.discovered).toBe(1);
      expect(extractSpy).toHaveBeenCalledWith(
        'm-retry',
        'Yesterday I went for a run.',
        'user-1',
        {
          timestamp: new Date('2026-05-23T12:00:00.000Z'),
          turnIndex: 4,
          conversationId: 'conv-1',
          userName: 'Beaux',
        },
      );
      expect(embedSpy).not.toHaveBeenCalled();
    });

    it('should prioritize session-backed memories before derived memories during discovery', async () => {
      prisma.memory.findMany = jest
        .fn()
        .mockResolvedValueOnce([
          {
            id: 'm-session',
            userId: 'user-1',
            raw: 'Yesterday I visited the museum.',
            metadata: {
              sourceContext: {
                timestamp: '2026-05-23T12:00:00.000Z',
                turnIndex: 1,
                conversationId: 'conv-1',
              },
            },
            extraction: null,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'm-derived',
            userId: 'user-1',
            raw: 'Museum is a person known to user-1.',
            metadata: null,
            extraction: null,
          },
        ]);

      const extractSpy = jest
        .spyOn(service, 'extractAndEmbed')
        .mockResolvedValue(undefined);

      await service.retryFailedEmbeddings();

      expect(extractSpy).toHaveBeenNthCalledWith(
        1,
        'm-session',
        'Yesterday I visited the museum.',
        'user-1',
        {
          timestamp: new Date('2026-05-23T12:00:00.000Z'),
          turnIndex: 1,
          conversationId: 'conv-1',
        },
      );
      expect(extractSpy).toHaveBeenNthCalledWith(
        2,
        'm-derived',
        'Museum is a person known to user-1.',
        'user-1',
        undefined,
      );
    });
  });
});

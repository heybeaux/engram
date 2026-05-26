import { MemoryWriteService } from './memory-write.service';
import { PrismaService } from '../prisma/prisma.service';
import { ExtractionService } from './extraction.service';
import { EmbeddingService } from './embedding.service';
import { ImportanceService } from './importance.service';
import { MemoryPipelineService } from './memory-pipeline.service';
import { EmbeddingQueueProducer } from './embedding-queue.producer';
import {
  ImportanceHint,
  MemoryLayer,
  MemorySource,
  TemporalAnchorSource,
} from '@prisma/client';
import { ElasticsearchService } from '../search/elasticsearch.service';
import {
  TemporalWarningCode,
  TEMPORAL_WARNING_HISTORICAL_WITHOUT_ANCHOR,
} from './memory.types';

describe('MemoryWriteService', () => {
  let service: MemoryWriteService;
  let mockPrisma: any;
  let mockExtraction: any;
  let mockEmbedding: any;
  let mockImportance: any;
  let mockPipelineService: any;
  let mockEmbeddingQueue: any;
  let mockElasticsearchService: Partial<ElasticsearchService>;

  const mockMemory = {
    id: 'mem-123',
    userId: 'user-456',
    raw: 'Test memory content',
    layer: MemoryLayer.SESSION,
    source: MemorySource.EXPLICIT_STATEMENT,
    importanceHint: ImportanceHint.MEDIUM,
    importanceScore: 0.5,
    confidence: 1.0,
    retrievalCount: 0,
    usedCount: 0,
    consolidated: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  beforeEach(() => {
    mockPrisma = {
      memory: {
        create: jest.fn(),
        createMany: jest.fn(),
        findMany: jest.fn(),
      },
      session: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'new-session' }),
      },
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'user-456', externalId: 'TestUser' }),
      },
    };

    mockExtraction = {
      extract: jest.fn().mockResolvedValue({
        who: null,
        what: 'Test',
        when: null,
        where: null,
        why: null,
        how: null,
        topics: [],
        entities: [],
        memoryType: null,
        typeConfidence: null,
        confidence: {
          whoConfidence: null,
          whatConfidence: null,
          whenConfidence: null,
          whereConfidence: null,
          whyConfidence: null,
          howConfidence: null,
        },
        lesson: null,
      }),
      getPriorityForType: jest.fn().mockReturnValue(3),
      classifyLayer: jest.fn().mockReturnValue('SESSION'),
    };

    mockEmbedding = {
      generate: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      store: jest.fn().mockResolvedValue('embed-123'),
      search: jest.fn().mockResolvedValue([]),
    };

    mockImportance = {
      calculate: jest.fn(),
    };

    mockPipelineService = {
      extractAndEmbed: jest.fn().mockResolvedValue(undefined),
      storeEntities: jest.fn().mockResolvedValue(undefined),
      linkRelatedMemories: jest.fn().mockResolvedValue(undefined),
    };

    mockEmbeddingQueue = {
      enqueueEmbedding: jest.fn().mockResolvedValue(undefined),
    };

    mockElasticsearchService = {
      indexMemory: jest.fn().mockResolvedValue(undefined),
    };

    service = new MemoryWriteService(
      mockPrisma,
      mockExtraction,
      mockEmbedding,
      mockImportance,
      mockPipelineService,
      mockElasticsearchService as ElasticsearchService,
      undefined, // correctionService
      undefined, // memoryPoolService
      undefined, // memoryAccessLogService
      undefined, // eventEmitter
      mockEmbeddingQueue,
    );
  });

  describe('remember', () => {
    it('should create a memory with calculated importance', async () => {
      mockImportance.calculate.mockReturnValue(0.6);
      mockPrisma.memory.create.mockResolvedValue(mockMemory);

      const result = await service.remember('user-456', {
        raw: 'Test memory content',
        layer: MemoryLayer.SESSION,
        importanceHint: ImportanceHint.MEDIUM,
      });

      expect(mockImportance.calculate).toHaveBeenCalledWith({
        hint: ImportanceHint.MEDIUM,
        layer: MemoryLayer.SESSION,
      });
      expect(mockPrisma.memory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user-456',
          raw: 'Test memory content',
          layer: MemoryLayer.SESSION,
          source: MemorySource.EXPLICIT_STATEMENT,
          importanceHint: ImportanceHint.MEDIUM,
          importanceScore: 0.6,
        }),
      });
      expect(result).toEqual(mockMemory);
    });

    it('should default to SESSION layer when not specified', async () => {
      mockImportance.calculate.mockReturnValue(0.5);
      mockPrisma.memory.create.mockResolvedValue(mockMemory);

      await service.remember('user-456', { raw: 'Test' });

      expect(mockPrisma.memory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          layer: MemoryLayer.SESSION,
        }),
      });
    });

    it('should include project and session context when provided', async () => {
      mockImportance.calculate.mockReturnValue(0.5);
      mockPrisma.memory.create.mockResolvedValue(mockMemory);
      mockPrisma.session.findUnique.mockResolvedValue({ id: 'session-456' });

      await service.remember('user-456', {
        raw: 'Test',
        context: {
          projectId: 'project-123',
          sessionId: 'session-456',
        },
      });

      expect(mockPrisma.memory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          projectId: 'project-123',
          sessionId: 'session-456',
        }),
      });
    });

    it('should enqueue embedding via EmbeddingQueueProducer (HEY-462: async dedup)', async () => {
      mockImportance.calculate.mockReturnValue(0.5);
      mockPrisma.memory.create.mockResolvedValue(mockMemory);

      const result = await service.remember('user-456', { raw: 'Test' });

      expect(result).toEqual(mockMemory);
      expect(mockEmbeddingQueue.enqueueEmbedding).toHaveBeenCalledWith({
        memoryId: mockMemory.id,
        userId: 'user-456',
        raw: 'Test',
        runDedup: true,
      });
    });

    it('should throw when no content provided', async () => {
      await expect(service.remember('user-456', {} as any)).rejects.toThrow(
        'Memory content is required',
      );
    });

    it('should persist tags when provided (ENG-42)', async () => {
      mockImportance.calculate.mockReturnValue(0.5);
      mockPrisma.memory.create.mockResolvedValue({
        ...mockMemory,
        tags: ['google-ads', 'campaign'],
      });

      await service.remember('user-456', {
        raw: 'Campaign launched for Google Ads',
        tags: ['google-ads', 'campaign'],
      });

      expect(mockPrisma.memory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tags: ['google-ads', 'campaign'],
        }),
      });
    });

    it('should default tags to empty array when not provided (ENG-42)', async () => {
      mockImportance.calculate.mockReturnValue(0.5);
      mockPrisma.memory.create.mockResolvedValue(mockMemory);

      await service.remember('user-456', { raw: 'No tags here' });

      expect(mockPrisma.memory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tags: [],
        }),
      });
    });
  });

  // Temporal anchoring Phase 1, T5 — four-case design matrix.
  // See openspec/changes/temporal-anchoring/design.md.
  describe('temporal anchoring (T5)', () => {
    describe('resolveTemporalAnchor (pure helper)', () => {
      const now = new Date('2026-05-26T12:00:00Z');

      it('case 1: real-time, no anchor → FALLBACK_RECORDED_AT + observedAt=null (strict-null)', () => {
        const result = service.resolveTemporalAnchor({
          callerObservedAt: undefined,
          source: MemorySource.EXPLICIT_STATEMENT,
          now,
        });
        expect(result.temporalAnchorSource).toBe(
          TemporalAnchorSource.FALLBACK_RECORDED_AT,
        );
        expect(result.observedAt).toBeNull();
      });

      it('case 2: real-time, with anchor → EXPLICIT_CALLER + caller value', () => {
        const caller = '2026-05-20T08:00:00Z';
        const result = service.resolveTemporalAnchor({
          callerObservedAt: caller,
          source: MemorySource.EXPLICIT_STATEMENT,
          now,
        });
        expect(result.temporalAnchorSource).toBe(
          TemporalAnchorSource.EXPLICIT_CALLER,
        );
        expect(result.observedAt!.toISOString()).toBe(
          new Date(caller).toISOString(),
        );
      });

      it('case 3: historical, with anchor → EXPLICIT_CALLER + caller value', () => {
        const caller = '2024-01-15T14:00:00Z';
        const result = service.resolveTemporalAnchor({
          callerObservedAt: caller,
          source: MemorySource.HISTORICAL,
          now,
        });
        expect(result.temporalAnchorSource).toBe(
          TemporalAnchorSource.EXPLICIT_CALLER,
        );
        expect(result.observedAt!.toISOString()).toBe(
          new Date(caller).toISOString(),
        );
      });

      it('case 4: historical, no anchor → FALLBACK_RECORDED_AT + null + warning logged', () => {
        const warnSpy = jest
          .spyOn((service as any).logger, 'warn')
          .mockImplementation(() => {});
        const result = service.resolveTemporalAnchor({
          callerObservedAt: undefined,
          source: MemorySource.HISTORICAL,
          now,
        });
        expect(result.temporalAnchorSource).toBe(
          TemporalAnchorSource.FALLBACK_RECORDED_AT,
        );
        expect(result.observedAt).toBeNull();
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('HISTORICAL source without observedAt'),
        );
        warnSpy.mockRestore();
      });
    });

    describe('remember() integration', () => {
      it('persists observedAt + temporalAnchorSource on the created memory', async () => {
        mockImportance.calculate.mockReturnValue(0.5);
        mockPrisma.memory.create.mockResolvedValue(mockMemory);

        await service.remember('user-456', {
          raw: 'Historical note',
          source: MemorySource.HISTORICAL as any,
          observedAt: '2024-01-15T14:00:00Z',
        });

        expect(mockPrisma.memory.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            temporalAnchorSource: TemporalAnchorSource.EXPLICIT_CALLER,
            observedAt: expect.any(Date),
          }),
        });
        const createArg = mockPrisma.memory.create.mock.calls[0][0];
        expect(createArg.data.observedAt.toISOString()).toBe(
          '2024-01-15T14:00:00.000Z',
        );
      });

      it('defaults to FALLBACK_RECORDED_AT + observedAt=null when no anchor provided (T5a strict-null)', async () => {
        mockImportance.calculate.mockReturnValue(0.5);
        mockPrisma.memory.create.mockResolvedValue(mockMemory);

        await service.remember('user-456', { raw: 'Plain note' });

        expect(mockPrisma.memory.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            temporalAnchorSource: TemporalAnchorSource.FALLBACK_RECORDED_AT,
            observedAt: null,
          }),
        });
      });
    });
  });

  // Temporal anchoring Phase 1, T6 — relative_extraction_skipped warning.
  // Warning emits iff request source = HISTORICAL AND resolver falls back
  // to FALLBACK_RECORDED_AT (case 4 of the resolver matrix).
  describe('temporal anchoring (T6) — relative_extraction_skipped warning', () => {
    describe('shouldEmitRelativeExtractionSkippedWarning (pure helper)', () => {
      it('(a) HISTORICAL + FALLBACK_RECORDED_AT → true (warning emitted)', () => {
        expect(
          service.shouldEmitRelativeExtractionSkippedWarning(
            MemorySource.HISTORICAL,
            TemporalAnchorSource.FALLBACK_RECORDED_AT,
          ),
        ).toBe(true);
      });

      it('(b) HISTORICAL + EXPLICIT_CALLER → false (anchor provided, no warning)', () => {
        expect(
          service.shouldEmitRelativeExtractionSkippedWarning(
            MemorySource.HISTORICAL,
            TemporalAnchorSource.EXPLICIT_CALLER,
          ),
        ).toBe(false);
      });

      it('(c) real-time source + FALLBACK_RECORDED_AT → false (default real-time case)', () => {
        expect(
          service.shouldEmitRelativeExtractionSkippedWarning(
            MemorySource.EXPLICIT_STATEMENT,
            TemporalAnchorSource.FALLBACK_RECORDED_AT,
          ),
        ).toBe(false);
        expect(
          service.shouldEmitRelativeExtractionSkippedWarning(
            MemorySource.AGENT_OBSERVATION,
            TemporalAnchorSource.FALLBACK_RECORDED_AT,
          ),
        ).toBe(false);
      });
    });

    describe('remember() attaches warnings to response', () => {
      beforeEach(() => {
        mockImportance.calculate.mockReturnValue(0.5);
        // Silence the resolver's own logger.warn for case-4.
        jest
          .spyOn((service as any).logger, 'warn')
          .mockImplementation(() => {});
      });

      it('(a) HISTORICAL + no observedAt → warnings with HISTORICAL_WITHOUT_ANCHOR code and memoryId', async () => {
        mockPrisma.memory.create.mockResolvedValue({ ...mockMemory });

        const result = await service.remember('user-456', {
          raw: 'Old historical note',
          source: MemorySource.HISTORICAL as any,
        });

        expect(result.warnings).toHaveLength(1);
        expect(result.warnings![0].code).toBe(
          TemporalWarningCode.HISTORICAL_WITHOUT_ANCHOR,
        );
        expect(result.warnings![0].message).toBe(
          TEMPORAL_WARNING_HISTORICAL_WITHOUT_ANCHOR.message,
        );
        expect(result.warnings![0].memoryId).toBe(mockMemory.id);
      });

      it('(b) HISTORICAL + observedAt → no warnings (anchor honored)', async () => {
        mockPrisma.memory.create.mockResolvedValue({ ...mockMemory });

        const result = await service.remember('user-456', {
          raw: 'Old historical note',
          source: MemorySource.HISTORICAL as any,
          observedAt: '2024-01-15T14:00:00Z',
        });

        expect(result.warnings).toBeUndefined();
      });

      it('(c) real-time source + no observedAt → no warnings (FALLBACK is normal here)', async () => {
        mockPrisma.memory.create.mockResolvedValue({ ...mockMemory });

        const result = await service.remember('user-456', {
          raw: 'Just-now note',
          source: MemorySource.EXPLICIT_STATEMENT as any,
        });

        expect(result.warnings).toBeUndefined();
      });
    });

    describe('rememberAll() aggregates per-item warnings to top level', () => {
      beforeEach(() => {
        mockImportance.calculate.mockReturnValue(0.5);
        jest
          .spyOn((service as any).logger, 'warn')
          .mockImplementation(() => {});
      });

      it('(d) explicit non-HISTORICAL bulk source → no warnings', async () => {
        mockPrisma.memory.create.mockResolvedValue({ ...mockMemory });

        const result = await service.rememberAll('user-456', {
          memories: [
            { raw: 'A', source: MemorySource.EXPLICIT_STATEMENT },
            { raw: 'B', source: MemorySource.AGENT_OBSERVATION },
          ],
        });

        expect(result.warnings).toBeUndefined();
      });

      it('emits aggregated warning when any item is HISTORICAL-without-anchor', async () => {
        mockPrisma.memory.create.mockResolvedValue({ ...mockMemory });

        const result = await service.rememberAll('user-456', {
          memories: [
            { raw: 'A', source: MemorySource.EXPLICIT_STATEMENT },
            { raw: 'B', source: MemorySource.HISTORICAL },
          ],
        });

        expect(result.warnings).toHaveLength(1);
        expect(result.warnings![0].code).toBe(
          TemporalWarningCode.HISTORICAL_WITHOUT_ANCHOR,
        );
        // memoryId is omitted at the aggregate rememberAll level
        expect(result.warnings![0].memoryId).toBeUndefined();
      });
    });

    describe('bulkCreate() emits batch-level warning', () => {
      beforeEach(() => {
        mockImportance.calculate.mockReturnValue(0.5);
        mockPrisma.memory.createMany.mockResolvedValue({ count: 2 });
        jest
          .spyOn((service as any).logger, 'warn')
          .mockImplementation(() => {});
      });

      it('includes warnings when any item is HISTORICAL-without-anchor', async () => {
        const result = await service.bulkCreate('user-456', {
          memories: [
            { raw: 'A' },
            { raw: 'B', source: MemorySource.HISTORICAL as any },
          ],
        });

        expect(result.warnings).toHaveLength(1);
        expect(result.warnings![0].code).toBe(
          TemporalWarningCode.HISTORICAL_WITHOUT_ANCHOR,
        );
        expect(result.created).toBe(2);
      });

      it('omits warnings when all items have anchors or are real-time', async () => {
        const result = await service.bulkCreate('user-456', {
          memories: [
            { raw: 'A' },
            {
              raw: 'B',
              source: MemorySource.HISTORICAL as any,
              observedAt: '2024-01-15T14:00:00Z',
            },
          ],
        });

        expect(result.warnings).toBeUndefined();
      });
    });
  });

  describe('rememberAll', () => {
    it('should create multiple memories in batch', async () => {
      mockImportance.calculate.mockReturnValue(0.5);
      mockPrisma.memory.create.mockResolvedValue(mockMemory);

      const result = await service.rememberAll('user-456', {
        memories: [
          { raw: 'Memory 1' },
          { raw: 'Memory 2' },
          { raw: 'Memory 3' },
        ],
      });

      expect(mockPrisma.memory.create).toHaveBeenCalledTimes(3);
      expect(result).toEqual({ created: 3, failed: 0 });
    });

    it('should count failures without stopping batch', async () => {
      mockImportance.calculate.mockReturnValue(0.5);
      mockPrisma.memory.create
        .mockResolvedValueOnce(mockMemory)
        .mockRejectedValueOnce(new Error('DB error'))
        .mockResolvedValueOnce(mockMemory);

      const result = await service.rememberAll('user-456', {
        memories: [
          { raw: 'Memory 1' },
          { raw: 'Memory 2' },
          { raw: 'Memory 3' },
        ],
      });

      expect(result).toEqual({ created: 2, failed: 1 });
    });

    it('should respect individual memory settings', async () => {
      mockImportance.calculate.mockReturnValue(0.5);
      mockPrisma.memory.create.mockResolvedValue(mockMemory);

      await service.rememberAll('user-456', {
        memories: [
          {
            raw: 'Memory 1',
            layer: MemoryLayer.IDENTITY,
            importanceHint: ImportanceHint.CRITICAL,
          },
        ],
        context: { projectId: 'project-123' },
      });

      expect(mockImportance.calculate).toHaveBeenCalledWith({
        hint: ImportanceHint.CRITICAL,
        layer: MemoryLayer.IDENTITY,
      });
    });

    // T5a: rememberAll forwards observedAt + source per-item to the temporal resolver.
    it('forwards observedAt + source from HISTORICAL items through to the persisted record', async () => {
      mockImportance.calculate.mockReturnValue(0.5);
      mockPrisma.memory.create.mockResolvedValue(mockMemory);

      await service.rememberAll('user-456', {
        memories: [
          {
            raw: 'Old event',
            source: MemorySource.HISTORICAL,
            observedAt: '2024-01-15T14:00:00Z',
          },
        ],
      });

      expect(mockPrisma.memory.create).toHaveBeenCalledTimes(1);
      const createArg = mockPrisma.memory.create.mock.calls[0][0];
      expect(createArg.data.source).toBe(MemorySource.HISTORICAL);
      expect(createArg.data.temporalAnchorSource).toBe(
        TemporalAnchorSource.EXPLICIT_CALLER,
      );
      expect(createArg.data.observedAt).toBeInstanceOf(Date);
      expect(createArg.data.observedAt.toISOString()).toBe(
        '2024-01-15T14:00:00.000Z',
      );
    });
  });

  describe('chunkText', () => {
    it('should return single chunk for short text', () => {
      const result = service.chunkText('Short text.', 3500);
      expect(result).toEqual(['Short text.']);
    });

    it('should split on paragraph boundaries', () => {
      const text = 'Paragraph one.\n\nParagraph two.\n\nParagraph three.';
      const result = service.chunkText(text, 20);
      expect(result.length).toBeGreaterThan(1);
    });

    it('should split long paragraphs on sentence boundaries', () => {
      const text =
        'First sentence. Second sentence. Third sentence. Fourth sentence.';
      const result = service.chunkText(text, 30);
      expect(result.length).toBeGreaterThan(1);
    });
  });

  describe('chunkByRound', () => {
    it('should produce one chunk per exchange for a standard transcript', () => {
      const transcript = [
        'User: What is the capital of France?',
        'Assistant: Paris is the capital of France.',
        'User: And what about Germany?',
        'Assistant: Berlin is the capital of Germany.',
      ].join('\n');
      const result = service.chunkByRound(transcript);
      expect(result).toHaveLength(2);
      expect(result[0]).toContain('User: What is the capital of France?');
      expect(result[0]).toContain('Assistant: Paris');
      expect(result[1]).toContain('User: And what about Germany?');
      expect(result[1]).toContain('Assistant: Berlin');
    });

    it('should handle Human: prefix (LongMemEval format)', () => {
      const transcript = [
        'Human: Hello there.',
        'Assistant: Hi! How can I help?',
        'Human: Tell me a joke.',
        'Assistant: Why did the chicken cross the road?',
      ].join('\n');
      const result = service.chunkByRound(transcript);
      expect(result).toHaveLength(2);
      expect(result[0]).toContain('Human: Hello there.');
      expect(result[1]).toContain('Human: Tell me a joke.');
    });

    it('should handle Agent: prefix', () => {
      const transcript = [
        'User: Start task.',
        'Agent: Task started.',
        'User: Check status.',
        'Agent: Still running.',
      ].join('\n');
      const result = service.chunkByRound(transcript);
      expect(result).toHaveLength(2);
    });

    it('should handle Markdown --- separator (OpenClaw/Mastra format)', () => {
      const transcript = [
        'User: First question?',
        'Assistant: First answer.',
        '',
        '---',
        '',
        'User: Second question?',
        'Assistant: Second answer.',
      ].join('\n');
      const result = service.chunkByRound(transcript);
      expect(result).toHaveLength(2);
    });

    it('should produce 10 rounds for a 10-turn transcript', () => {
      const turns: string[] = [];
      for (let i = 0; i < 10; i++) {
        turns.push(`User: Question ${i + 1}?`);
        turns.push(`Assistant: Answer ${i + 1}.`);
      }
      const transcript = turns.join('\n');
      const result = service.chunkByRound(transcript);
      expect(result).toHaveLength(10);
    });

    it('should set correct session positions via bulkTextImport', async () => {
      const turns: string[] = [];
      for (let i = 0; i < 5; i++) {
        turns.push(`User: Q${i + 1}?`);
        turns.push(`Assistant: A${i + 1}.`);
      }
      const transcript = turns.join('\n');

      mockImportance.calculate.mockReturnValue(0.5);
      mockPrisma.memory.createMany.mockResolvedValue({ count: 5 });
      mockPrisma.memoryPool = undefined;
      mockPrisma.account = { findUnique: jest.fn().mockResolvedValue(null) };

      await service.bulkTextImport('user-456', {
        text: transcript,
        granularity: 'ROUND',
        context: { sessionId: 'sess-1' },
      });

      const createManyCall = mockPrisma.memory.createMany.mock.calls[0][0];
      const data = createManyCall.data;
      expect(data).toHaveLength(5);
      data.forEach((row: any, i: number) => {
        expect(row.sessionPosition).toBe(i);
      });
    });

    it('should default to CHUNK granularity (back-compat — no sessionPosition)', async () => {
      const text = 'Short text for testing.';

      mockImportance.calculate.mockReturnValue(0.5);
      mockPrisma.memory.createMany.mockResolvedValue({ count: 1 });
      mockPrisma.account = { findUnique: jest.fn().mockResolvedValue(null) };

      await service.bulkTextImport('user-456', { text });

      const createManyCall = mockPrisma.memory.createMany.mock.calls[0][0];
      const data = createManyCall.data;
      expect(data[0].sessionPosition).toBeNull();
    });

    it('should fall back to single chunk when no turn delimiters found', () => {
      const text = 'Just a plain paragraph with no conversation markers.';
      const result = service.chunkByRound(text);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(text.trim());
    });

    it('should handle case-insensitive turn prefixes', () => {
      const transcript = [
        'USER: First question?',
        'ASSISTANT: First answer.',
        'user: Second question?',
        'assistant: Second answer.',
      ].join('\n');
      const result = service.chunkByRound(transcript);
      expect(result).toHaveLength(2);
    });
  });

  describe('resolveSessionId', () => {
    it('should return undefined when no sessionId provided', async () => {
      const result = await service.resolveSessionId('user-456');
      expect(result).toBeUndefined();
    });

    it('should return existing session ID when found by ID', async () => {
      mockPrisma.session.findUnique.mockResolvedValue({ id: 'session-123' });

      const result = await service.resolveSessionId('user-456', 'session-123');
      expect(result).toBe('session-123');
    });

    it('should return existing session ID when found by external ID', async () => {
      mockPrisma.session.findUnique.mockResolvedValue(null);
      mockPrisma.session.findFirst.mockResolvedValue({ id: 'internal-id' });

      const result = await service.resolveSessionId('user-456', 'external-id');
      expect(result).toBe('internal-id');
    });

    it('should create new session when not found', async () => {
      mockPrisma.session.findUnique.mockResolvedValue(null);
      mockPrisma.session.findFirst.mockResolvedValue(null);
      mockPrisma.session.create.mockResolvedValue({ id: 'new-session-id' });

      const result = await service.resolveSessionId('user-456', 'new-session');
      expect(result).toBe('new-session-id');
      expect(mockPrisma.session.create).toHaveBeenCalledWith({
        data: { userId: 'user-456', externalId: 'new-session' },
      });
    });
  });
});

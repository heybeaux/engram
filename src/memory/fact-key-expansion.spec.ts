/**
 * HEY-574: Unit tests for key expansion with extracted facts (LongMemEval S2)
 *
 * Coverage:
 * 1. Extraction prompt contains fact_keys instruction
 * 2. ExtractionService parses fact_keys from LLM response
 * 3. EmbeddingQueueProcessor creates FACT_KEY child rows with correct fields
 * 4. Dedup prevents duplicate FACT_KEY rows on re-ingestion
 * 5. Feature flag off → no child row creation
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EXTRACTION_PROMPT_TEMPLATE } from './extraction-prompt';
import { ExtractionService } from './extraction.service';
import { LLMService } from '../llm/llm.service';
import { EmbeddingQueueProcessor } from './embedding-queue.processor';
import { MemoryPipelineService } from './memory-pipeline.service';
import { ServicePrismaService } from '../prisma/service-prisma.service';
import { MemoryDedupService } from './memory-dedup.service';
import { MemoryLayer, MemorySource, MemoryType } from '@prisma/client';
import { Job } from 'bullmq';
import { EmbedMemoryJobData } from './embedding.queue';

// ─── 1. Extraction prompt ────────────────────────────────────────────────────

describe('EXTRACTION_PROMPT_TEMPLATE (HEY-574)', () => {
  it('includes fact_keys instruction', () => {
    const prompt = EXTRACTION_PROMPT_TEMPLATE();
    expect(prompt).toContain('fact_keys');
    expect(prompt).toContain('declarative');
  });

  it('describes the 2-5 sentence constraint', () => {
    const prompt = EXTRACTION_PROMPT_TEMPLATE();
    expect(prompt).toMatch(/2.?5/);
  });
});

// ─── 2. ExtractionService parses fact_keys ───────────────────────────────────

describe('ExtractionService — factKeys (HEY-574)', () => {
  let service: ExtractionService;
  let mockLlm: jest.Mocked<LLMService>;

  beforeEach(async () => {
    mockLlm = {
      json: jest.fn(),
      chat: jest.fn(),
      embed: jest.fn(),
      getProvider: jest.fn(),
      listProviders: jest.fn(),
      listEmbeddingProviders: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExtractionService,
        { provide: LLMService, useValue: mockLlm },
      ],
    }).compile();

    service = module.get<ExtractionService>(ExtractionService);
  });

  it('returns non-empty factKeys when LLM provides fact_keys array', async () => {
    mockLlm.json.mockResolvedValue({
      who: 'Beaux',
      what: 'prefers dark mode',
      when: null,
      where: null,
      why: 'easier on the eyes',
      how: null,
      topics: ['preferences'],
      entities: [],
      memoryType: 'PREFERENCE',
      typeConfidence: 0.9,
      fact_keys: [
        'Beaux prefers dark mode.',
        'Dark mode is easier on the eyes.',
        'This is a preference setting.',
      ],
    });

    const result = await service.extract(
      'I prefer dark mode because it is easier on my eyes',
    );

    expect(result.factKeys).toBeDefined();
    expect(result.factKeys.length).toBeGreaterThanOrEqual(1);
    expect(result.factKeys[0]).toBe('Beaux prefers dark mode.');
  });

  it('returns empty factKeys when LLM omits fact_keys', async () => {
    mockLlm.json.mockResolvedValue({
      who: null,
      what: 'test',
      when: null,
      where: null,
      why: null,
      how: null,
      topics: [],
      entities: [],
      memoryType: 'EVENT',
      typeConfidence: 0.5,
      // no fact_keys field
    });

    const result = await service.extract('Test memory');
    expect(result.factKeys).toEqual([]);
  });

  it('returns empty factKeys when LLM returns empty array', async () => {
    mockLlm.json.mockResolvedValue({
      who: null,
      what: 'test',
      when: null,
      where: null,
      why: null,
      how: null,
      topics: [],
      entities: [],
      memoryType: 'EVENT',
      typeConfidence: 0.5,
      fact_keys: [],
    });

    const result = await service.extract('Test memory');
    expect(result.factKeys).toEqual([]);
  });

  it('filters out non-string entries from fact_keys', async () => {
    mockLlm.json.mockResolvedValue({
      who: null,
      what: 'test',
      when: null,
      where: null,
      why: null,
      how: null,
      topics: [],
      entities: [],
      memoryType: 'EVENT',
      typeConfidence: 0.5,
      fact_keys: ['Valid fact.', null, 42, '', 'Another valid fact.'],
    });

    const result = await service.extract('Test memory');
    expect(result.factKeys).toEqual(['Valid fact.', 'Another valid fact.']);
  });

  it('returns factKeys: [] on LLM failure (basicExtraction fallback)', async () => {
    mockLlm.json.mockRejectedValue(new Error('LLM unavailable'));
    const result = await service.extract('Test memory');
    expect(result.factKeys).toEqual([]);
  });
});

// ─── 3 + 4 + 5. EmbeddingQueueProcessor — FACT_KEY child rows ───────────────

describe('EmbeddingQueueProcessor — fact key expansion (HEY-574)', () => {
  let processor: EmbeddingQueueProcessor;
  let mockPipeline: jest.Mocked<
    Pick<MemoryPipelineService, 'extractAndEmbed' | 'generateAndStoreEmbedding'>
  >;
  let mockPrisma: any;
  let mockDedup: jest.Mocked<Partial<MemoryDedupService>>;

  const baseMemory = {
    id: 'mem-parent',
    embeddingStatus: 'PENDING',
    deletedAt: null,
    layer: MemoryLayer.SESSION,
    source: MemorySource.EXPLICIT_STATEMENT,
    sessionId: 'sess-1',
  };

  const baseExtraction = {
    factKeys: ['Beaux prefers dark mode.', 'Dark mode is easier on eyes.'],
  };

  function makeJob(
    overrides: Partial<EmbedMemoryJobData> = {},
  ): Job<EmbedMemoryJobData> {
    return {
      data: {
        memoryId: 'mem-parent',
        userId: 'user-1',
        raw: 'I prefer dark mode',
        runDedup: false,
        ...overrides,
      },
    } as Job<EmbedMemoryJobData>;
  }

  beforeEach(async () => {
    mockPipeline = {
      extractAndEmbed: jest.fn().mockResolvedValue(undefined),
      generateAndStoreEmbedding: jest.fn().mockResolvedValue(true),
    };

    mockPrisma = {
      memory: {
        findUnique: jest.fn().mockResolvedValue(baseMemory),
        findFirst: jest.fn().mockResolvedValue(null), // no existing FACT_KEY child
        create: jest.fn().mockImplementation((args: any) =>
          Promise.resolve({ id: `child-${Math.random()}`, ...args.data }),
        ),
        update: jest.fn().mockResolvedValue({}),
      },
      memoryExtraction: {
        findUnique: jest.fn().mockResolvedValue(baseExtraction),
      },
    };

    mockDedup = {
      findDuplicateV2: jest.fn().mockResolvedValue({ action: 'create' }),
      autoMergeMemory: jest.fn().mockResolvedValue(undefined),
      reinforceMemory: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmbeddingQueueProcessor,
        { provide: MemoryPipelineService, useValue: mockPipeline },
        { provide: ServicePrismaService, useValue: mockPrisma },
        { provide: MemoryDedupService, useValue: mockDedup },
      ],
    }).compile();

    processor = module.get<EmbeddingQueueProcessor>(EmbeddingQueueProcessor);
  });

  afterEach(() => {
    delete process.env.ENABLE_FACT_KEY_EXPANSION;
  });

  it('creates FACT_KEY child rows when flag is on', async () => {
    process.env.ENABLE_FACT_KEY_EXPANSION = 'true';

    // parent lookup
    mockPrisma.memory.findUnique
      .mockResolvedValueOnce(baseMemory) // job lookup
      .mockResolvedValueOnce({ layer: MemoryLayer.SESSION, sessionId: 'sess-1' }); // parent lookup inside createFactKeyChildren

    await processor.process(makeJob());

    expect(mockPrisma.memory.create).toHaveBeenCalledTimes(
      baseExtraction.factKeys.length,
    );
    const firstCall = mockPrisma.memory.create.mock.calls[0][0];
    expect(firstCall.data.memoryType).toBe(MemoryType.FACT_KEY);
    expect(firstCall.data.searchable).toBe(true);
    expect(firstCall.data.parentMemoryId).toBe('mem-parent');
    expect(firstCall.data.raw).toBe('Beaux prefers dark mode.');
  });

  it('embeds each created FACT_KEY child row', async () => {
    process.env.ENABLE_FACT_KEY_EXPANSION = 'true';

    mockPrisma.memory.findUnique
      .mockResolvedValueOnce(baseMemory)
      .mockResolvedValueOnce({ layer: MemoryLayer.SESSION, sessionId: 'sess-1' });

    await processor.process(makeJob());

    expect(mockPipeline.generateAndStoreEmbedding).toHaveBeenCalledTimes(
      baseExtraction.factKeys.length,
    );
  });

  it('skips duplicate FACT_KEY rows (dedup by contentHash)', async () => {
    process.env.ENABLE_FACT_KEY_EXPANSION = 'true';

    mockPrisma.memory.findUnique
      .mockResolvedValueOnce(baseMemory)
      .mockResolvedValueOnce({ layer: MemoryLayer.SESSION, sessionId: 'sess-1' });

    // Simulate existing child row for first fact key
    mockPrisma.memory.findFirst
      .mockResolvedValueOnce({ id: 'existing-child' }) // first factKey → already exists
      .mockResolvedValueOnce(null); // second factKey → new

    await processor.process(makeJob());

    // Only the second fact key should create a new row
    expect(mockPrisma.memory.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.memory.create.mock.calls[0][0].data.raw).toBe(
      'Dark mode is easier on eyes.',
    );
  });

  it('does not create FACT_KEY rows when flag is off', async () => {
    // ENABLE_FACT_KEY_EXPANSION not set (undefined → off)
    await processor.process(makeJob());

    expect(mockPrisma.memoryExtraction.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.memory.create).not.toHaveBeenCalled();
  });

  it('does not create FACT_KEY rows when flag is "false"', async () => {
    process.env.ENABLE_FACT_KEY_EXPANSION = 'false';
    await processor.process(makeJob());

    expect(mockPrisma.memory.create).not.toHaveBeenCalled();
  });

  it('does not fail the job when fact key expansion throws', async () => {
    process.env.ENABLE_FACT_KEY_EXPANSION = 'true';

    mockPrisma.memory.findUnique
      .mockResolvedValueOnce(baseMemory)
      .mockResolvedValueOnce({ layer: MemoryLayer.SESSION, sessionId: 'sess-1' });

    mockPrisma.memoryExtraction.findUnique.mockRejectedValue(
      new Error('DB error'),
    );

    await expect(processor.process(makeJob())).resolves.toBeUndefined();
    expect(mockPipeline.extractAndEmbed).toHaveBeenCalled();
  });

  it('does nothing when extraction has no factKeys', async () => {
    process.env.ENABLE_FACT_KEY_EXPANSION = 'true';

    mockPrisma.memory.findUnique
      .mockResolvedValueOnce(baseMemory)
      .mockResolvedValueOnce({ layer: MemoryLayer.SESSION, sessionId: 'sess-1' });

    mockPrisma.memoryExtraction.findUnique.mockResolvedValue({ factKeys: [] });

    await processor.process(makeJob());

    expect(mockPrisma.memory.create).not.toHaveBeenCalled();
  });
});

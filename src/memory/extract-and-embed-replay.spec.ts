import { Prisma } from '@prisma/client';
import { MemoryPipelineService } from './memory-pipeline.service';
import { EmbeddingQueueProcessor } from './embedding-queue.processor';
import { EntityMemoryService } from './entity-memory.service';

/**
 * ENG-62: replaying an `extractAndEmbed` job for a memory that already has a
 * MemoryExtraction row (e.g. a FAILED memory requeued on `memory-embedding`)
 * must embed it without tripping the `memory_id` unique constraint and
 * without writing a second set of derived rows.
 *
 * The fake Prisma below keeps rows in maps and enforces the unique keys the
 * pipeline relies on, so the assertions count rows rather than mock calls.
 */

const USER = 'user-1';
const MEMORY_ID = 'mem-1';
const RAW = 'Alice from Acme said the launch moved to Friday';

function makeDb() {
  const memories = new Map<string, any>();
  const extractions = new Map<string, any>();
  const entities = new Map<string, any>();
  const memoryEntities = new Set<string>();
  const graphEntities = new Map<string, any>();
  const graphMentions = new Set<string>();
  let nextId = 1;

  memories.set(MEMORY_ID, {
    id: MEMORY_ID,
    userId: USER,
    raw: RAW,
    layer: 'SESSION',
    source: 'EXPLICIT_STATEMENT',
    sessionId: null,
    deletedAt: null,
    embeddingId: null,
    embeddingStatus: 'PENDING',
    metadata: {},
    tags: [],
  });

  const prisma: any = {
    memory: {
      findUnique: jest.fn(
        async ({ where }: any) => memories.get(where.id) ?? null,
      ),
      findFirst: jest.fn(
        async ({ where }: any) =>
          [...memories.values()].find(
            (m) =>
              m.userId === where.userId &&
              m.layer === where.layer &&
              m.tags?.includes(where.tags?.has) &&
              !m.deletedAt,
          ) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `stub-${nextId++}`, deletedAt: null, ...data };
        memories.set(row.id, row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) =>
        Object.assign(memories.get(where.id), data),
      ),
    },
    memoryExtraction: {
      findUnique: jest.fn(
        async ({ where }: any) => extractions.get(where.memoryId) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => {
        if (extractions.has(data.memoryId)) {
          throw new Prisma.PrismaClientKnownRequestError(
            'Unique constraint failed on the fields: (`memory_id`)',
            {
              code: 'P2002',
              clientVersion: 'test',
              meta: { target: ['memory_id'] },
            },
          );
        }
        const row = { id: `ext-${nextId++}`, ...data };
        extractions.set(data.memoryId, row);
        return row;
      }),
    },
    entity: {
      upsert: jest.fn(async ({ where, create }: any) => {
        const k = where.userId_normalizedName_type;
        const key = `${k.userId}|${k.normalizedName}|${k.type}`;
        if (!entities.has(key)) {
          entities.set(key, { id: `ent-${nextId++}`, ...create });
        }
        return entities.get(key);
      }),
    },
    memoryEntity: {
      upsert: jest.fn(async ({ where }: any) => {
        const k = where.memoryId_entityId;
        memoryEntities.add(`${k.memoryId}|${k.entityId}`);
        return {};
      }),
    },
    graphEntity: {
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const k = where.userId_name_type;
        const key = `${k.userId}|${k.name}|${k.type}`;
        const existing = graphEntities.get(key);
        if (!existing) {
          graphEntities.set(key, { id: `ge-${nextId++}`, ...create });
        } else if (update.mentionCount?.increment) {
          existing.mentionCount += update.mentionCount.increment;
        }
        return graphEntities.get(key);
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        const k = where.userId_name_type;
        return graphEntities.get(`${k.userId}|${k.name}|${k.type}`) ?? null;
      }),
    },
    graphEntityMention: {
      upsert: jest.fn(async ({ where }: any) => {
        const k = where.entityId_memoryId;
        graphMentions.add(`${k.entityId}|${k.memoryId}`);
        return {};
      }),
    },
    memoryChainLink: { upsert: jest.fn().mockResolvedValue({}) },
  };

  const identityStubs = () =>
    [...memories.values()].filter((m) => m.layer === 'IDENTITY');

  return {
    prisma,
    memories,
    extractions,
    entities,
    memoryEntities,
    graphEntities,
    graphMentions,
    identityStubs,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('extractAndEmbed replay (ENG-62)', () => {
  let db: ReturnType<typeof makeDb>;
  let extraction: any;
  let embedding: any;
  let graphExtraction: any;
  let hierarchy: any;
  let pipeline: MemoryPipelineService;
  let processor: EmbeddingQueueProcessor;
  let dedup: any;

  beforeEach(() => {
    db = makeDb();
    extraction = {
      extract: jest.fn().mockResolvedValue({
        who: 'Alice',
        what: 'launch moved to Friday',
        when: null,
        where: null,
        why: null,
        how: null,
        topics: ['launch'],
        factKeys: [],
        entities: [
          { name: 'Alice', type: 'PERSON' },
          { name: 'Acme', type: 'ORGANIZATION' },
        ],
        memoryType: 'FACT',
        typeConfidence: 0.9,
        confidence: {
          whoConfidence: 0.9,
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
    graphExtraction = {
      processMemory: jest.fn().mockResolvedValue({
        entitiesCreated: 0,
        entitiesUpdated: 0,
        relationshipsCreated: 0,
        mentionsCreated: 0,
        processingTimeMs: 0,
      }),
    };
    hierarchy = {
      isEnabled: jest.fn().mockReturnValue(true),
      processMemory: jest.fn().mockResolvedValue(undefined),
    };
    pipeline = new MemoryPipelineService(
      db.prisma,
      extraction,
      embedding,
      hierarchy,
      graphExtraction,
      undefined,
      new EntityMemoryService(db.prisma),
    );
    dedup = {
      findDuplicateV2: jest.fn().mockResolvedValue({ action: 'create' }),
    };
    processor = new EmbeddingQueueProcessor(pipeline, db.prisma, dedup);
  });

  /** First run: extraction succeeds, embedding fails → memory left FAILED. */
  async function firstRunWithEmbedFailure() {
    embedding.generate.mockRejectedValue(
      new Error('Local embedding admission timed out'),
    );
    await processor.process({
      data: { memoryId: MEMORY_ID, userId: USER, raw: RAW, runDedup: true },
    } as any);
    await flush();
    embedding.generate.mockResolvedValue([0.1, 0.2, 0.3]);
  }

  function snapshot() {
    return {
      extractions: db.extractions.size,
      entities: db.entities.size,
      memoryEntities: db.memoryEntities.size,
      graphEntities: db.graphEntities.size,
      graphMentions: db.graphMentions.size,
      mentionCounts: [...db.graphEntities.values()].map((g) => g.mentionCount),
      identityStubs: db.identityStubs().length,
      memoryRows: db.memories.size,
    };
  }

  it('first run leaves the memory FAILED with its derived rows written', async () => {
    await firstRunWithEmbedFailure();

    expect(db.memories.get(MEMORY_ID).embeddingStatus).toBe('FAILED');
    expect(db.memories.get(MEMORY_ID).embeddingId).toBeNull();
    expect(snapshot()).toEqual({
      extractions: 1,
      entities: 2,
      memoryEntities: 2,
      graphEntities: 2,
      graphMentions: 2,
      mentionCounts: [1, 1],
      identityStubs: 2, // Alice (person) + Acme (organization)
      memoryRows: 3,
    });
  });

  it('replaying the standard memory-embedding job does not throw and embeds the memory', async () => {
    await firstRunWithEmbedFailure();

    await expect(
      processor.process({
        data: { memoryId: MEMORY_ID, userId: USER, raw: RAW, runDedup: true },
      } as any),
    ).resolves.toBeUndefined();
    await flush();

    expect(embedding.store).toHaveBeenCalledWith(MEMORY_ID, [0.1, 0.2, 0.3]);
    expect(db.memories.get(MEMORY_ID)).toMatchObject({
      embeddingId: 'emb-1',
      embeddingStatus: 'COMPLETE',
    });
    // Dedup still runs on the replay now that a vector exists
    expect(dedup.findDuplicateV2).toHaveBeenCalledTimes(2);
  });

  it('replay creates no duplicate derived rows and does not re-run LLM side effects', async () => {
    await firstRunWithEmbedFailure();
    const before = snapshot();

    await processor.process({
      data: { memoryId: MEMORY_ID, userId: USER, raw: RAW, runDedup: true },
    } as any);
    await flush();

    expect(snapshot()).toEqual(before);
    expect(db.prisma.memoryExtraction.create).toHaveBeenCalledTimes(1);
    expect(extraction.extract).toHaveBeenCalledTimes(1);
    expect(graphExtraction.processMemory).toHaveBeenCalledTimes(1);
    expect(hierarchy.processMemory).toHaveBeenCalledTimes(1);
  });

  it('replaying extractAndEmbed twice more is still a no-op for derived rows', async () => {
    await firstRunWithEmbedFailure();
    const before = snapshot();

    await pipeline.extractAndEmbed(MEMORY_ID, RAW, USER);
    await pipeline.extractAndEmbed(MEMORY_ID, RAW, USER);
    await flush();

    expect(snapshot()).toEqual(before);
    expect(embedding.store).toHaveBeenCalledTimes(2);
  });

  it('a memory with no extraction yet still runs the full pipeline', async () => {
    await pipeline.extractAndEmbed(MEMORY_ID, RAW, USER);
    await flush();

    expect(extraction.extract).toHaveBeenCalledTimes(1);
    expect(db.extractions.size).toBe(1);
    expect(db.identityStubs()).toHaveLength(2);
    expect(db.memories.get(MEMORY_ID).embeddingStatus).toBe('COMPLETE');
  });
});

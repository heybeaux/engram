import { InsightInjectionStrategy } from './insight-injection.strategy';
import { ContextSignals } from './strategy.interface';

describe('InsightInjectionStrategy', () => {
  let strategy: InsightInjectionStrategy;
  let mockPrisma: any;

  const NOW = 1740000000000; // fixed timestamp

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);

    mockPrisma = {
      memory: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    strategy = new InsightInjectionStrategy(mockPrisma);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function makeSignals(overrides: Partial<ContextSignals> = {}): ContextSignals {
    return {
      query: 'test query',
      userId: 'user1',
      entities: [],
      topics: [],
      hourOfDay: 12,
      dayOfWeek: 1,
      excludeMemoryIds: new Set(),
      ...overrides,
    };
  }

  function makeInsight(overrides: Partial<any> = {}) {
    return {
      id: 'insight-1',
      raw: 'User prefers morning meetings about project alpha',
      layer: 'INSIGHT',
      confidence: 0.8,
      createdAt: new Date(NOW - 2 * 24 * 60 * 60 * 1000), // 2 days ago
      metadata: {},
      extraction: { topics: ['meetings', 'project alpha'] },
      ...overrides,
    };
  }

  // --- Happy paths ---

  it('should have name "insight_injection"', () => {
    expect(strategy.name).toBe('insight_injection');
  });

  it('should return empty when no topics or entities', async () => {
    const result = await strategy.execute(makeSignals(), { maxResults: 5, timeoutMs: 1000 });
    expect(result).toEqual([]);
    expect(mockPrisma.memory.findMany).not.toHaveBeenCalled();
  });

  it('should query and return scored insights matching topics', async () => {
    const insight = makeInsight();
    mockPrisma.memory.findMany.mockResolvedValue([insight]);

    const result = await strategy.execute(
      makeSignals({ topics: ['project alpha'] }),
      { maxResults: 5, timeoutMs: 5000 },
    );

    expect(mockPrisma.memory.findMany).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0].meta.strategy).toBe('insight_injection');
    expect(result[0].memory.score).toBeGreaterThan(0);
  });

  it('should query insights when entities are provided', async () => {
    const insight = makeInsight({ raw: 'Insight about Engram architecture' });
    mockPrisma.memory.findMany.mockResolvedValue([insight]);

    const result = await strategy.execute(
      makeSignals({ entities: ['Engram'] }),
      { maxResults: 5, timeoutMs: 5000 },
    );

    expect(result).toHaveLength(1);
  });

  it('should filter by userId and layer INSIGHT', async () => {
    mockPrisma.memory.findMany.mockResolvedValue([]);

    await strategy.execute(
      makeSignals({ topics: ['test'], userId: 'user42' }),
      { maxResults: 5, timeoutMs: 5000 },
    );

    const where = mockPrisma.memory.findMany.mock.calls[0][0].where;
    expect(where.userId).toBe('user42');
    expect(where.layer).toBe('INSIGHT');
    expect(where.deletedAt).toBeNull();
    expect(where.supersededById).toBeNull();
  });

  it('should exclude memory IDs from signals', async () => {
    mockPrisma.memory.findMany.mockResolvedValue([]);

    await strategy.execute(
      makeSignals({ topics: ['test'], excludeMemoryIds: new Set(['m1', 'm2']) }),
      { maxResults: 5, timeoutMs: 5000 },
    );

    const where = mockPrisma.memory.findMany.mock.calls[0][0].where;
    expect(where.id.notIn).toEqual(expect.arrayContaining(['m1', 'm2']));
  });

  it('should limit results to maxResults', async () => {
    const insights = Array.from({ length: 5 }, (_, i) =>
      makeInsight({ id: `insight-${i}`, raw: `Insight about topic${i} details` }),
    );
    mockPrisma.memory.findMany.mockResolvedValue(insights);

    const result = await strategy.execute(
      makeSignals({ topics: ['topic0', 'topic1', 'topic2', 'topic3', 'topic4'] }),
      { maxResults: 2, timeoutMs: 5000 },
    );

    expect(result.length).toBeLessThanOrEqual(2);
  });

  it('should mark surfaced insights via prisma update', async () => {
    const insight = makeInsight();
    mockPrisma.memory.findMany.mockResolvedValue([insight]);

    await strategy.execute(
      makeSignals({ topics: ['project alpha'] }),
      { maxResults: 5, timeoutMs: 5000 },
    );

    // markSurfaced is fire-and-forget, give it a tick
    await new Promise((r) => setTimeout(r, 10));

    expect(mockPrisma.memory.update).toHaveBeenCalledWith({
      where: { id: 'insight-1' },
      data: {
        metadata: expect.objectContaining({
          surfacedCount: 1,
          lastSurfacedAt: expect.any(String),
        }),
      },
    });
  });

  // --- Scoring ---

  it('should score higher for content match than topic-only match', async () => {
    const contentMatch = makeInsight({
      id: 'content',
      raw: 'Details about deployment pipeline',
      extraction: { topics: ['unrelated'] },
    });
    const topicMatch = makeInsight({
      id: 'topic',
      raw: 'Something else entirely',
      extraction: { topics: ['deployment'] },
    });
    mockPrisma.memory.findMany.mockResolvedValue([contentMatch, topicMatch]);

    const result = await strategy.execute(
      makeSignals({ topics: ['deployment'] }),
      { maxResults: 5, timeoutMs: 5000 },
    );

    const contentResult = result.find((r) => r.memory.id === 'content');
    const topicResult = result.find((r) => r.memory.id === 'topic');
    expect(contentResult!.meta.salience).toBeGreaterThan(topicResult!.meta.salience);
  });

  it('should apply freshness boost (newer = higher score)', async () => {
    const newer = makeInsight({
      id: 'newer',
      raw: 'Topic about alpha',
      createdAt: new Date(NOW - 1 * 24 * 60 * 60 * 1000), // 1 day
    });
    const older = makeInsight({
      id: 'older',
      raw: 'Topic about alpha',
      createdAt: new Date(NOW - 13 * 24 * 60 * 60 * 1000), // 13 days
    });
    mockPrisma.memory.findMany.mockResolvedValue([newer, older]);

    const result = await strategy.execute(
      makeSignals({ topics: ['alpha'] }),
      { maxResults: 5, timeoutMs: 5000 },
    );

    const newerResult = result.find((r) => r.memory.id === 'newer');
    const olderResult = result.find((r) => r.memory.id === 'older');
    expect(newerResult!.meta.salience).toBeGreaterThan(olderResult!.meta.salience);
  });

  it('should apply surfacing decay (more surfaced = lower score)', async () => {
    const fresh = makeInsight({
      id: 'fresh',
      raw: 'Topic about beta',
      metadata: { surfacedCount: 0 },
    });
    const stale = makeInsight({
      id: 'stale',
      raw: 'Topic about beta',
      metadata: { surfacedCount: 4 },
    });
    mockPrisma.memory.findMany.mockResolvedValue([fresh, stale]);

    const result = await strategy.execute(
      makeSignals({ topics: ['beta'] }),
      { maxResults: 5, timeoutMs: 5000 },
    );

    const freshResult = result.find((r) => r.memory.id === 'fresh');
    const staleResult = result.find((r) => r.memory.id === 'stale');
    expect(freshResult!.meta.salience).toBeGreaterThan(staleResult!.meta.salience);
  });

  // --- Cooldown ---

  it('should filter out insights within cooldown period', async () => {
    const recentlySurfaced = makeInsight({
      raw: 'Topic about gamma',
      metadata: {
        lastSurfacedAt: new Date(NOW - 1 * 60 * 60 * 1000).toISOString(), // 1 hour ago
        surfacedCount: 1,
      },
    });
    mockPrisma.memory.findMany.mockResolvedValue([recentlySurfaced]);

    const result = await strategy.execute(
      makeSignals({ topics: ['gamma'] }),
      { maxResults: 5, timeoutMs: 5000 },
    );

    expect(result).toHaveLength(0);
  });

  it('should include insights past cooldown period', async () => {
    const pastCooldown = makeInsight({
      raw: 'Topic about delta',
      metadata: {
        lastSurfacedAt: new Date(NOW - 5 * 60 * 60 * 1000).toISOString(), // 5 hours ago
        surfacedCount: 1,
      },
    });
    mockPrisma.memory.findMany.mockResolvedValue([pastCooldown]);

    const result = await strategy.execute(
      makeSignals({ topics: ['delta'] }),
      { maxResults: 5, timeoutMs: 5000 },
    );

    expect(result).toHaveLength(1);
  });

  // --- Edge cases ---

  it('should handle insights with null confidence', async () => {
    const insight = makeInsight({ confidence: null, raw: 'Topic about epsilon' });
    mockPrisma.memory.findMany.mockResolvedValue([insight]);

    const result = await strategy.execute(
      makeSignals({ topics: ['epsilon'] }),
      { maxResults: 5, timeoutMs: 5000 },
    );

    expect(result).toHaveLength(1);
    expect(result[0].meta.salience).toBeGreaterThan(0);
  });

  it('should handle insights with null metadata', async () => {
    const insight = makeInsight({ metadata: null, raw: 'Topic about zeta' });
    mockPrisma.memory.findMany.mockResolvedValue([insight]);

    const result = await strategy.execute(
      makeSignals({ topics: ['zeta'] }),
      { maxResults: 5, timeoutMs: 5000 },
    );

    expect(result).toHaveLength(1);
  });

  it('should handle insights with no extraction', async () => {
    const insight = makeInsight({ extraction: null, raw: 'Topic about eta' });
    mockPrisma.memory.findMany.mockResolvedValue([insight]);

    const result = await strategy.execute(
      makeSignals({ topics: ['eta'] }),
      { maxResults: 5, timeoutMs: 5000 },
    );

    expect(result).toHaveLength(1);
  });

  it('should filter out insights with zero relevance score', async () => {
    const irrelevant = makeInsight({ raw: 'completely unrelated content', extraction: { topics: [] } });
    mockPrisma.memory.findMany.mockResolvedValue([irrelevant]);

    const result = await strategy.execute(
      makeSignals({ topics: ['quantum physics'] }),
      { maxResults: 5, timeoutMs: 5000 },
    );

    expect(result).toHaveLength(0);
  });

  it('should include insightType in meta from metadata', async () => {
    const insight = makeInsight({
      raw: 'Topic about theta',
      metadata: { insightType: 'behavioral_pattern' },
    });
    mockPrisma.memory.findMany.mockResolvedValue([insight]);

    const result = await strategy.execute(
      makeSignals({ topics: ['theta'] }),
      { maxResults: 5, timeoutMs: 5000 },
    );

    expect(result[0].meta.insightType).toBe('behavioral_pattern');
  });

  it('should default insightType to "unknown"', async () => {
    const insight = makeInsight({ raw: 'Topic about iota' });
    mockPrisma.memory.findMany.mockResolvedValue([insight]);

    const result = await strategy.execute(
      makeSignals({ topics: ['iota'] }),
      { maxResults: 5, timeoutMs: 5000 },
    );

    expect(result[0].meta.insightType).toBe('unknown');
  });

  // --- Error handling ---

  it('should return empty on prisma error', async () => {
    mockPrisma.memory.findMany.mockRejectedValue(new Error('DB down'));

    const result = await strategy.execute(
      makeSignals({ topics: ['test'] }),
      { maxResults: 5, timeoutMs: 5000 },
    );

    expect(result).toEqual([]);
  });

  it('should not throw if markSurfaced fails', async () => {
    const insight = makeInsight({ raw: 'Topic about kappa' });
    mockPrisma.memory.findMany.mockResolvedValue([insight]);
    mockPrisma.memory.update.mockRejectedValue(new Error('update failed'));

    const result = await strategy.execute(
      makeSignals({ topics: ['kappa'] }),
      { maxResults: 5, timeoutMs: 5000 },
    );

    expect(result).toHaveLength(1);

    // Let fire-and-forget settle
    await new Promise((r) => setTimeout(r, 10));
    // Should not throw — just logs warning
  });

  // --- Timeout ---

  it('should return empty if timeout exceeded after query', async () => {
    let callCount = 0;
    jest.spyOn(Date, 'now')
      .mockImplementation(() => {
        callCount++;
        // First call: start, sets deadline. After findMany returns, exceed deadline.
        if (callCount <= 2) return NOW;
        return NOW + 10000; // way past deadline
      });

    mockPrisma.memory.findMany.mockResolvedValue([makeInsight({ raw: 'Topic about lambda' })]);

    const result = await strategy.execute(
      makeSignals({ topics: ['lambda'] }),
      { maxResults: 5, timeoutMs: 100 },
    );

    expect(result).toEqual([]);
  });
});

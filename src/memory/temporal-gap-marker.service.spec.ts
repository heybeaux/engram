import { TemporalGapMarkerService } from './temporal-gap-marker.service';

describe('TemporalGapMarkerService', () => {
  let service: TemporalGapMarkerService;
  let mockPrisma: any;
  // Snapshot env vars we touch so we can restore them after each test.
  const ORIGINAL_ENV = {
    ENABLE_TEMPORAL_GAP_MARKERS: process.env.ENABLE_TEMPORAL_GAP_MARKERS,
    GAP_MARKER_THRESHOLD_SECONDS: process.env.GAP_MARKER_THRESHOLD_SECONDS,
  };

  beforeEach(() => {
    mockPrisma = {
      memory: {
        findFirst: jest.fn(),
        create: jest.fn(),
      },
    };
    service = new TemporalGapMarkerService(mockPrisma);
    delete process.env.ENABLE_TEMPORAL_GAP_MARKERS;
    delete process.env.GAP_MARKER_THRESHOLD_SECONDS;
  });

  afterAll(() => {
    if (ORIGINAL_ENV.ENABLE_TEMPORAL_GAP_MARKERS === undefined) {
      delete process.env.ENABLE_TEMPORAL_GAP_MARKERS;
    } else {
      process.env.ENABLE_TEMPORAL_GAP_MARKERS =
        ORIGINAL_ENV.ENABLE_TEMPORAL_GAP_MARKERS;
    }
    if (ORIGINAL_ENV.GAP_MARKER_THRESHOLD_SECONDS === undefined) {
      delete process.env.GAP_MARKER_THRESHOLD_SECONDS;
    } else {
      process.env.GAP_MARKER_THRESHOLD_SECONDS =
        ORIGINAL_ENV.GAP_MARKER_THRESHOLD_SECONDS;
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // Configuration
  // ────────────────────────────────────────────────────────────────────────
  describe('isEnabled', () => {
    it('defaults to true when env not set', () => {
      expect(service.isEnabled()).toBe(true);
    });
    it('returns true when env is "true"', () => {
      process.env.ENABLE_TEMPORAL_GAP_MARKERS = 'true';
      expect(service.isEnabled()).toBe(true);
    });
    it('returns false when env is "false"', () => {
      process.env.ENABLE_TEMPORAL_GAP_MARKERS = 'false';
      expect(service.isEnabled()).toBe(false);
    });
    it('returns false when env is "FALSE" (case-insensitive)', () => {
      process.env.ENABLE_TEMPORAL_GAP_MARKERS = 'FALSE';
      expect(service.isEnabled()).toBe(false);
    });
    it('returns false when env is "0"', () => {
      process.env.ENABLE_TEMPORAL_GAP_MARKERS = '0';
      expect(service.isEnabled()).toBe(false);
    });
  });

  describe('thresholdSeconds', () => {
    it('defaults to 600 when env not set', () => {
      expect(service.thresholdSeconds()).toBe(600);
    });
    it('parses positive integers from env', () => {
      process.env.GAP_MARKER_THRESHOLD_SECONDS = '1800';
      expect(service.thresholdSeconds()).toBe(1800);
    });
    it('falls back to 600 on garbage env', () => {
      process.env.GAP_MARKER_THRESHOLD_SECONDS = 'not-a-number';
      expect(service.thresholdSeconds()).toBe(600);
    });
    it('falls back to 600 on non-positive env', () => {
      process.env.GAP_MARKER_THRESHOLD_SECONDS = '0';
      expect(service.thresholdSeconds()).toBe(600);
      process.env.GAP_MARKER_THRESHOLD_SECONDS = '-5';
      expect(service.thresholdSeconds()).toBe(600);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // shouldInsertMarker — boundary cases per ticket acceptance
  // ────────────────────────────────────────────────────────────────────────
  describe('shouldInsertMarker (boundary cases)', () => {
    const threshold = 600; // 10 minutes
    const now = new Date('2026-05-21T12:00:00.000Z');

    it('returns false when there is no prior memory', () => {
      expect(service.shouldInsertMarker(null, now, threshold)).toBe(false);
      expect(service.shouldInsertMarker(undefined, now, threshold)).toBe(false);
    });

    it('returns false for a sub-threshold gap (5 minutes)', () => {
      const prev = new Date(now.getTime() - 5 * 60 * 1000);
      expect(service.shouldInsertMarker(prev, now, threshold)).toBe(false);
    });

    it('returns false when gap is exactly at threshold (600s)', () => {
      const prev = new Date(now.getTime() - 600 * 1000);
      expect(service.shouldInsertMarker(prev, now, threshold)).toBe(false);
    });

    it('returns true when gap is just over threshold (601s)', () => {
      const prev = new Date(now.getTime() - 601 * 1000);
      expect(service.shouldInsertMarker(prev, now, threshold)).toBe(true);
    });

    it('returns true for a multi-hour gap (2h 14m)', () => {
      const prev = new Date(
        now.getTime() - (2 * 3600 + 14 * 60) * 1000,
      );
      expect(service.shouldInsertMarker(prev, now, threshold)).toBe(true);
    });

    it('returns false when prev is in the future (clock skew)', () => {
      const prev = new Date(now.getTime() + 60 * 1000);
      expect(service.shouldInsertMarker(prev, now, threshold)).toBe(false);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // formatGap
  // ────────────────────────────────────────────────────────────────────────
  describe('formatGap', () => {
    it('renders sub-minute gaps in seconds (singular/plural)', () => {
      expect(service.formatGap(1)).toBe('1 second');
      expect(service.formatGap(45)).toBe('45 seconds');
    });
    it('renders minutes-only gaps', () => {
      expect(service.formatGap(60)).toBe('1 minute');
      expect(service.formatGap(15 * 60)).toBe('15 minutes');
    });
    it('renders hours + minutes', () => {
      const gap = 2 * 3600 + 14 * 60;
      expect(service.formatGap(gap)).toBe('2 hours 14 minutes');
    });
    it('renders days + hours + minutes', () => {
      const gap = 1 * 86400 + 3 * 3600 + 7 * 60;
      expect(service.formatGap(gap)).toBe('1 day 3 hours 7 minutes');
    });
    it('omits empty segments', () => {
      expect(service.formatGap(3600)).toBe('1 hour');
      expect(service.formatGap(86400)).toBe('1 day');
    });
    it('handles 0 / negative defensively', () => {
      expect(service.formatGap(0)).toBe('0 seconds');
      expect(service.formatGap(-5)).toBe('0 seconds');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // findLastMemoryTimestamp — scoping
  // ────────────────────────────────────────────────────────────────────────
  describe('findLastMemoryTimestamp', () => {
    it('returns null when neither agentId nor sessionId is provided', async () => {
      const result = await service.findLastMemoryTimestamp({ userId: 'u1' });
      expect(result).toBeNull();
      expect(mockPrisma.memory.findFirst).not.toHaveBeenCalled();
    });

    it('queries by userId + agentId, excluding TEMPORAL_GAP markers', async () => {
      mockPrisma.memory.findFirst.mockResolvedValue({
        createdAt: new Date('2026-05-21T10:00:00.000Z'),
      });

      const result = await service.findLastMemoryTimestamp({
        userId: 'u1',
        agentId: 'agent-a',
      });

      expect(result).toEqual(new Date('2026-05-21T10:00:00.000Z'));
      expect(mockPrisma.memory.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: 'u1',
            agentId: 'agent-a',
            deletedAt: null,
            NOT: { memoryType: 'TEMPORAL_GAP' },
          }),
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        }),
      );
    });

    it('scopes to sessionId when provided', async () => {
      mockPrisma.memory.findFirst.mockResolvedValue(null);

      await service.findLastMemoryTimestamp({
        userId: 'u1',
        agentId: 'agent-a',
        sessionId: 'sess-1',
      });

      expect(mockPrisma.memory.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: 'u1',
            agentId: 'agent-a',
            sessionId: 'sess-1',
          }),
        }),
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // maybeInsertMarker — end-to-end behavior
  // ────────────────────────────────────────────────────────────────────────
  describe('maybeInsertMarker', () => {
    const now = new Date('2026-05-21T12:00:00.000Z');

    it('returns null and writes nothing when feature flag is off', async () => {
      process.env.ENABLE_TEMPORAL_GAP_MARKERS = 'false';

      const result = await service.maybeInsertMarker({
        userId: 'u1',
        agentId: 'a1',
        nowTimestamp: now,
      });

      expect(result).toBeNull();
      expect(mockPrisma.memory.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.memory.create).not.toHaveBeenCalled();
    });

    it('returns null when there is no prior memory', async () => {
      mockPrisma.memory.findFirst.mockResolvedValue(null);

      const result = await service.maybeInsertMarker({
        userId: 'u1',
        agentId: 'a1',
        nowTimestamp: now,
      });

      expect(result).toBeNull();
      expect(mockPrisma.memory.create).not.toHaveBeenCalled();
    });

    it('returns null when gap is sub-threshold', async () => {
      mockPrisma.memory.findFirst.mockResolvedValue({
        createdAt: new Date(now.getTime() - 5 * 60 * 1000), // 5 min
      });

      const result = await service.maybeInsertMarker({
        userId: 'u1',
        agentId: 'a1',
        nowTimestamp: now,
      });

      expect(result).toBeNull();
      expect(mockPrisma.memory.create).not.toHaveBeenCalled();
    });

    it('inserts a marker with structured metadata when gap > threshold', async () => {
      const prev = new Date(now.getTime() - (2 * 3600 + 14 * 60) * 1000);
      mockPrisma.memory.findFirst.mockResolvedValue({ createdAt: prev });
      mockPrisma.memory.create.mockResolvedValue({ id: 'mem-gap-1' });

      const enqueueEmbedding = jest.fn().mockResolvedValue(undefined);

      const result = await service.maybeInsertMarker({
        userId: 'u1',
        agentId: 'a1',
        sessionId: 'sess-1',
        nowTimestamp: now,
        enqueueEmbedding,
      });

      expect(result).toEqual({
        id: 'mem-gap-1',
        raw: expect.stringContaining('2 hours 14 minutes'),
        gapSeconds: 2 * 3600 + 14 * 60,
      });

      expect(mockPrisma.memory.create).toHaveBeenCalledTimes(1);
      const call = mockPrisma.memory.create.mock.calls[0][0];
      expect(call.data).toMatchObject({
        userId: 'u1',
        agentId: 'a1',
        sessionId: 'sess-1',
        memoryType: 'TEMPORAL_GAP',
        searchable: false,
        priority: 4,
        tags: ['temporal_gap'],
      });
      expect(call.data.metadata).toMatchObject({
        kind: 'temporal_gap',
        gap_seconds: 2 * 3600 + 14 * 60,
        prev_timestamp: prev.toISOString(),
        curr_timestamp: now.toISOString(),
        threshold_seconds: 600,
        human_readable: '2 hours 14 minutes',
      });

      // ISO timestamps appear in the human-readable raw content
      expect(call.data.raw).toContain(prev.toISOString());
      expect(call.data.raw).toContain(now.toISOString());

      // Markers are searchable=false — embedding queue must NOT be called
      expect(enqueueEmbedding).not.toHaveBeenCalled();
    });

    it('respects a custom threshold from env', async () => {
      process.env.GAP_MARKER_THRESHOLD_SECONDS = '60';
      mockPrisma.memory.findFirst.mockResolvedValue({
        createdAt: new Date(now.getTime() - 90 * 1000), // 90s
      });
      mockPrisma.memory.create.mockResolvedValue({ id: 'mem-gap-2' });

      const result = await service.maybeInsertMarker({
        userId: 'u1',
        agentId: 'a1',
        nowTimestamp: now,
      });

      expect(result).not.toBeNull();
      expect(result?.gapSeconds).toBe(90);
    });

    it('returns null and swallows the error if the lookup fails', async () => {
      mockPrisma.memory.findFirst.mockRejectedValue(new Error('boom'));

      const result = await service.maybeInsertMarker({
        userId: 'u1',
        agentId: 'a1',
        nowTimestamp: now,
      });

      expect(result).toBeNull();
      expect(mockPrisma.memory.create).not.toHaveBeenCalled();
    });
  });
});

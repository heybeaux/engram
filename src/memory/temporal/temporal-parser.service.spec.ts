import { TemporalParserService } from './temporal-parser.service';

describe('TemporalParserService', () => {
  let service: TemporalParserService;

  // Fixed "now" for deterministic tests: 2026-02-05 10:00:00 UTC (Wednesday)
  const NOW = new Date('2026-02-05T10:00:00.000Z');

  beforeEach(() => {
    service = new TemporalParserService();
  });

  describe('parse', () => {
    it('should detect "yesterday" and filter to that day', () => {
      const result = service.parse('What did we discuss yesterday?', NOW);

      expect(result.temporalFilter).not.toBeNull();
      expect(result.temporalFilter!.expression).toBe('yesterday');
      expect(result.temporalFilter!.start.getDate()).toBe(4); // Feb 4
      expect(result.temporalFilter!.end.getDate()).toBe(4);
      expect(result.semanticQuery).toContain('What did we discuss');
    });

    it('should detect "today" and filter to current day', () => {
      const result = service.parse('What happened today?', NOW);

      expect(result.temporalFilter).not.toBeNull();
      expect(result.temporalFilter!.expression).toBe('today');
      expect(result.temporalFilter!.start.getDate()).toBe(5); // Feb 5
      expect(result.temporalFilter!.end.getDate()).toBe(5);
    });

    it('should detect "last week"', () => {
      const result = service.parse('Show me last week decisions', NOW);

      expect(result.temporalFilter).not.toBeNull();
      expect(result.temporalFilter!.expression).toBe('last week');
      // last week = 7 days before now
      const start = result.temporalFilter!.start;
      const daysDiff = Math.round(
        (NOW.getTime() - start.getTime()) / (24 * 60 * 60 * 1000),
      );
      expect(daysDiff).toBe(7);
    });

    it('should detect "2 hours ago"', () => {
      const result = service.parse('What was discussed 2 hours ago?', NOW);

      expect(result.temporalFilter).not.toBeNull();
      expect(result.temporalFilter!.expression).toBe('2 hours ago');
      const expectedStart = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
      expect(result.temporalFilter!.start.getTime()).toBe(
        expectedStart.getTime(),
      );
      expect(result.temporalFilter!.end.getTime()).toBe(NOW.getTime());
    });

    it('should detect "30 minutes ago"', () => {
      const result = service.parse('What happened 30 minutes ago?', NOW);

      expect(result.temporalFilter).not.toBeNull();
      expect(result.temporalFilter!.expression).toBe('30 minutes ago');
      const expectedStart = new Date(NOW.getTime() - 30 * 60 * 1000);
      expect(result.temporalFilter!.start.getTime()).toBe(
        expectedStart.getTime(),
      );
    });

    it('should detect "3 days ago"', () => {
      const result = service.parse('What did we decide 3 days ago?', NOW);

      expect(result.temporalFilter).not.toBeNull();
      expect(result.temporalFilter!.start.getDate()).toBe(2); // Feb 2
    });

    it('should detect "last 5 days"', () => {
      const result = service.parse('Memories from the last 5 days', NOW);

      expect(result.temporalFilter).not.toBeNull();
      expect(result.temporalFilter!.expression).toBe('last 5 days');
      const start = result.temporalFilter!.start;
      const daysDiff = Math.round(
        (NOW.getTime() - start.getTime()) / (24 * 60 * 60 * 1000),
      );
      expect(daysDiff).toBe(5);
    });

    it('should detect "this week"', () => {
      const result = service.parse('What have we done this week?', NOW);

      expect(result.temporalFilter).not.toBeNull();
      expect(result.temporalFilter!.expression).toBe('this week');
      // This week should start on Monday — exact date depends on timezone
      // Just verify it's within reasonable range (2-4 days before Wednesday Feb 5)
      const daysBefore = Math.round(
        (NOW.getTime() - result.temporalFilter!.start.getTime()) /
          (24 * 60 * 60 * 1000),
      );
      expect(daysBefore).toBeGreaterThanOrEqual(1);
      expect(daysBefore).toBeLessThanOrEqual(4);
    });

    it('should detect "this month"', () => {
      const result = service.parse('What happened this month?', NOW);

      expect(result.temporalFilter).not.toBeNull();
      expect(result.temporalFilter!.start.getDate()).toBe(1); // Feb 1
      expect(result.temporalFilter!.start.getMonth()).toBe(1); // February (0-indexed)
    });

    it('should detect "recently"', () => {
      const result = service.parse('What have we recently discussed?', NOW);

      expect(result.temporalFilter).not.toBeNull();
      expect(result.temporalFilter!.expression).toBe('recently');
      // "recently" = last 3 days
      const daysDiff = Math.round(
        (NOW.getTime() - result.temporalFilter!.start.getTime()) /
          (24 * 60 * 60 * 1000),
      );
      expect(daysDiff).toBe(3);
    });

    it('should detect "recent" (adjective form) and filter to last 3 days', () => {
      const result = service.parse('recent conversations about work', NOW);

      expect(result.temporalFilter).not.toBeNull();
      expect(result.temporalFilter!.expression).toBe('recent');
      // "recent" = last 3 days (same window as "recently")
      const daysDiff = Math.round(
        (NOW.getTime() - result.temporalFilter!.start.getTime()) /
          (24 * 60 * 60 * 1000),
      );
      expect(daysDiff).toBe(3);
      // "recent" should be stripped from the semantic query
      expect(result.semanticQuery).toBe('conversations about work');
    });

    it('should detect case-insensitive "Recent" at start of query', () => {
      const result = service.parse('Recent standup notes', NOW);

      expect(result.temporalFilter).not.toBeNull();
      expect(result.temporalFilter!.expression).toBe('Recent');
      expect(result.semanticQuery).toBe('standup notes');
    });

    it('should detect "earlier today"', () => {
      const result = service.parse(
        'What did we talk about earlier today?',
        NOW,
      );

      expect(result.temporalFilter).not.toBeNull();
      expect(result.temporalFilter!.start.getDate()).toBe(5);
    });

    it('should return null filter for non-temporal queries', () => {
      const result = service.parse('What are my coffee preferences?', NOW);

      expect(result.temporalFilter).toBeNull();
      expect(result.semanticQuery).toBe('What are my coffee preferences?');
    });

    it('should strip temporal expression from semantic query', () => {
      const result = service.parse(
        'Show me yesterday conversations about Engram',
        NOW,
      );

      expect(result.semanticQuery).toBe('Show me conversations about Engram');
    });

    it('should handle query that is ONLY a temporal expression', () => {
      const result = service.parse('yesterday', NOW);

      expect(result.temporalFilter).not.toBeNull();
      // Should fall back to the original query for semantic search
      expect(result.semanticQuery).toBe('yesterday');
    });
  });

  describe('calculateTemporalRelevance', () => {
    it('should return 1.0 for memories within the filter range', () => {
      const filter = {
        start: new Date('2026-02-04T00:00:00Z'),
        end: new Date('2026-02-04T23:59:59Z'),
        expression: 'yesterday',
        confidence: 0.9,
      };

      const memoryDate = new Date('2026-02-04T15:30:00Z'); // Within range
      expect(service.calculateTemporalRelevance(memoryDate, filter)).toBe(1.0);
    });

    it('should return 0.7 for memories within 1 day of range', () => {
      const filter = {
        start: new Date('2026-02-04T00:00:00Z'),
        end: new Date('2026-02-04T23:59:59Z'),
        expression: 'yesterday',
        confidence: 0.9,
      };

      const memoryDate = new Date('2026-02-05T12:00:00Z'); // ~12h after end
      expect(service.calculateTemporalRelevance(memoryDate, filter)).toBe(0.7);
    });

    it('should return 0.0 for memories more than a week away', () => {
      const filter = {
        start: new Date('2026-02-04T00:00:00Z'),
        end: new Date('2026-02-04T23:59:59Z'),
        expression: 'yesterday',
        confidence: 0.9,
      };

      const memoryDate = new Date('2026-01-20T12:00:00Z'); // 15 days before
      expect(service.calculateTemporalRelevance(memoryDate, filter)).toBe(0.0);
    });

    it('should return 0.5 (neutral) when no temporal filter', () => {
      const memoryDate = new Date('2026-02-04T15:30:00Z');
      expect(service.calculateTemporalRelevance(memoryDate, null)).toBe(0.5);
    });
  });

  describe('blendScores', () => {
    it('should weight temporal heavily when temporal intent detected', () => {
      // High semantic, high temporal, medium importance
      const score = service.blendScores(0.9, 1.0, 0.5, true);
      // 0.9*0.30 + 1.0*0.50 + 0.5*0.20 = 0.27 + 0.50 + 0.10 = 0.87
      expect(score).toBeCloseTo(0.87, 2);
    });

    it('should ignore temporal when no temporal intent', () => {
      const score = service.blendScores(0.9, 0.0, 0.5, false);
      // 0.9*0.85 + 0.5*0.15 = 0.765 + 0.075 = 0.84
      expect(score).toBeCloseTo(0.84, 2);
    });

    it('should rank temporally relevant memories higher', () => {
      // Memory A: high semantic, low temporal
      const scoreA = service.blendScores(0.9, 0.1, 0.5, true);
      // Memory B: medium semantic, high temporal
      const scoreB = service.blendScores(0.6, 1.0, 0.5, true);

      // B should rank higher because temporal intent matters
      // A: 0.9*0.30 + 0.1*0.50 + 0.5*0.20 = 0.27 + 0.05 + 0.10 = 0.42
      // B: 0.6*0.30 + 1.0*0.50 + 0.5*0.20 = 0.18 + 0.50 + 0.10 = 0.78
      expect(scoreB).toBeGreaterThan(scoreA);
    });
  });

  // HEY-575: Adaptive window expansion
  describe('expandWindow', () => {
    it('should double the span when multiplier=2', () => {
      const filter = {
        start: new Date('2026-02-04T00:00:00.000Z'),
        end: new Date('2026-02-05T00:00:00.000Z'), // 1 day span
        expression: 'yesterday',
        confidence: 0.9,
      };

      const expanded = service.expandWindow(filter, 2.0);

      const originalSpan = filter.end.getTime() - filter.start.getTime();
      const expandedSpan = expanded.end.getTime() - expanded.start.getTime();
      expect(expandedSpan).toBeCloseTo(originalSpan * 2, -3);
    });

    it('should preserve the midpoint when expanding', () => {
      const filter = {
        start: new Date('2026-02-04T00:00:00.000Z'),
        end: new Date('2026-02-06T00:00:00.000Z'), // 2 day span, mid = Feb 5
        expression: 'last 2 days',
        confidence: 0.85,
      };
      const mid = (filter.start.getTime() + filter.end.getTime()) / 2;

      const expanded = service.expandWindow(filter, 3.0);

      const expandedMid = (expanded.start.getTime() + expanded.end.getTime()) / 2;
      expect(expandedMid).toBeCloseTo(mid, -3);
    });

    it('should preserve expression and confidence', () => {
      const filter = {
        start: new Date('2026-02-04T00:00:00.000Z'),
        end: new Date('2026-02-05T00:00:00.000Z'),
        expression: 'yesterday',
        confidence: 0.9,
      };

      const expanded = service.expandWindow(filter, 2.0);

      expect(expanded.expression).toBe('yesterday');
      expect(expanded.confidence).toBe(0.9);
    });

    it('should expand start earlier than original start', () => {
      const filter = {
        start: new Date('2026-02-04T00:00:00.000Z'),
        end: new Date('2026-02-05T00:00:00.000Z'),
        expression: 'yesterday',
        confidence: 0.9,
      };

      const expanded = service.expandWindow(filter, 2.0);

      expect(expanded.start.getTime()).toBeLessThan(filter.start.getTime());
      expect(expanded.end.getTime()).toBeGreaterThan(filter.end.getTime());
    });

    it('should halt at MAX_EXPAND passes — 3 expansions produce 8x window', () => {
      const filter = {
        start: new Date('2026-02-04T00:00:00.000Z'),
        end: new Date('2026-02-05T00:00:00.000Z'), // 1 day
        expression: 'yesterday',
        confidence: 0.9,
      };
      const originalSpan = filter.end.getTime() - filter.start.getTime();

      let current = filter;
      for (let i = 0; i < 3; i++) {
        current = service.expandWindow(current, 2.0);
      }

      const finalSpan = current.end.getTime() - current.start.getTime();
      // After 3 doublings: 2^3 = 8x original span
      expect(finalSpan).toBeCloseTo(originalSpan * 8, -3);
    });
  });

  describe('month/year temporal patterns', () => {
    it('should detect "6 months ago"', () => {
      const result = service.parse('standup notes from 6 months ago', NOW);
      expect(result.temporalFilter).not.toBeNull();
      expect(result.temporalFilter!.expression).toBe('6 months ago');
      // Window should be 6 months back from NOW
      const sixMonthsAgo = new Date(NOW);
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
      expect(result.temporalFilter!.start.getMonth()).toBe(
        sixMonthsAgo.getMonth(),
      );
    });

    it('should detect "2 years ago"', () => {
      const result = service.parse('standup notes from 2 years ago', NOW);
      expect(result.temporalFilter).not.toBeNull();
      expect(result.temporalFilter!.expression).toBe('2 years ago');
      const twoYearsAgo = new Date(NOW);
      twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
      expect(result.temporalFilter!.start.getFullYear()).toBe(
        twoYearsAgo.getFullYear(),
      );
    });

    it('should detect "years ago" without number', () => {
      const result = service.parse('standup notes from years ago', NOW);
      expect(result.temporalFilter).not.toBeNull();
      expect(result.temporalFilter!.expression).toBe('years ago');
      // Should cover 1-3 years range
      const threeYearsAgo = new Date(NOW);
      threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);
      expect(result.temporalFilter!.start.getFullYear()).toBe(
        threeYearsAgo.getFullYear(),
      );
    });

    it('should detect "3 weeks ago"', () => {
      const result = service.parse('messages from 3 weeks ago', NOW);
      expect(result.temporalFilter).not.toBeNull();
      expect(result.temporalFilter!.expression).toBe('3 weeks ago');
      const daysDiff = Math.round(
        (NOW.getTime() - result.temporalFilter!.start.getTime()) /
          (24 * 60 * 60 * 1000),
      );
      expect(daysDiff).toBe(21);
    });
  });
});

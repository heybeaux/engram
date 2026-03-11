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
      // 0.9*0.45 + 0.5*0.55 = 0.405 + 0.275 = 0.68
      expect(score).toBeCloseTo(0.68, 2);
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
});

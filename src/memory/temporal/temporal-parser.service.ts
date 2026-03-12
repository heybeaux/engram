import { Injectable, Logger } from '@nestjs/common';

/**
 * A resolved time range for filtering memories
 */
export interface TemporalFilter {
  start: Date;
  end: Date;
  expression: string; // Original temporal phrase matched
  confidence: number; // How confident we are in the parse (0-1)
}

/**
 * Result of parsing a query for temporal intent
 */
export interface ParsedQuery {
  semanticQuery: string; // Query with temporal parts stripped (for embedding search)
  temporalFilter: TemporalFilter | null; // Time range filter (if temporal intent detected)
}

interface TemporalPattern {
  regex: RegExp;
  resolve: (match: RegExpMatchArray, now: Date) => TemporalFilter;
}

/**
 * Parses temporal expressions from recall queries and resolves them to date ranges.
 *
 * This is the core of P6-006: Temporal Memory Context.
 *
 * Examples:
 *   "What did we discuss yesterday?" → filter to yesterday, search "What did we discuss"
 *   "Show me last week's decisions" → filter to last 7 days, search "decisions"
 *   "What happened 2 hours ago?" → filter to 2h window, search "What happened"
 */
@Injectable()
export class TemporalParserService {
  private readonly logger = new Logger(TemporalParserService.name);
  /**
   * Parse a query for temporal intent
   *
   * @param query - The recall query from the user/agent
   * @param now - Current timestamp (injectable for testing)
   * @param timezone - IANA timezone string (e.g., 'America/Vancouver')
   * @returns ParsedQuery with semantic query + optional temporal filter
   */
  parse(
    query: string,
    now: Date = new Date(),
    timezone: string = 'UTC',
  ): ParsedQuery {
    // Try fast pattern matching
    const result = this.patternMatch(query, now);
    if (result) {
      this.logger.log('[TemporalParser] Detected temporal intent:', {
        expression: result.temporalFilter?.expression,
        start: result.temporalFilter?.start.toISOString(),
        end: result.temporalFilter?.end.toISOString(),
        semanticQuery: result.semanticQuery,
      });
      return result;
    }

    // No temporal intent detected
    return { semanticQuery: query, temporalFilter: null };
  }

  /**
   * Calculate temporal relevance score for a memory given a temporal filter.
   *
   * @param memoryDate - When the memory was created
   * @param filter - The temporal filter from query parsing
   * @returns Score 0.0-1.0 indicating temporal relevance
   */
  calculateTemporalRelevance(
    memoryDate: Date,
    filter: TemporalFilter | null,
  ): number {
    if (!filter) return 0.5; // Neutral when no temporal intent

    const memoryMs = memoryDate.getTime();
    const startMs = filter.start.getTime();
    const endMs = filter.end.getTime();

    // Exact match: memory falls within the filter range
    if (memoryMs >= startMs && memoryMs <= endMs) {
      return 1.0;
    }

    // Calculate distance from the nearest edge of the range
    const distanceMs =
      memoryMs < startMs ? startMs - memoryMs : memoryMs - endMs;

    const ONE_DAY = 24 * 60 * 60 * 1000;
    const ONE_WEEK = 7 * ONE_DAY;

    // Close: within 1 day of the range
    if (distanceMs <= ONE_DAY) {
      return 0.7;
    }

    // Nearby: within 1 week
    if (distanceMs <= ONE_WEEK) {
      // Linear decay from 0.5 to 0.1 over the week
      const weekFraction = distanceMs / ONE_WEEK;
      return 0.5 - weekFraction * 0.4;
    }

    // Distant: more than a week away
    return 0.0;
  }

  /**
   * Blend semantic similarity with temporal relevance and importance.
   *
   * @param semanticScore - Vector similarity score (0-1)
   * @param temporalScore - Temporal relevance score (0-1)
   * @param importanceScore - effectiveScore from the memory (0-1)
   * @param hasTemporalIntent - Whether the query had temporal intent
   * @returns Blended final score
   */
  blendScores(
    semanticScore: number,
    temporalScore: number,
    importanceScore: number,
    hasTemporalIntent: boolean,
  ): number {
    if (hasTemporalIntent) {
      // When temporal intent detected, give time significant weight
      return (
        semanticScore * 0.30 + temporalScore * 0.50 + importanceScore * 0.20
      );
    } else {
      // No temporal intent — cosine-first weighting (mirrors post-reranker final blend)
      return semanticScore * 0.85 + importanceScore * 0.15;
    }
  }

  // ===========================================================================
  // Pattern Matching
  // ===========================================================================

  private patternMatch(query: string, now: Date): ParsedQuery | null {
    const patterns = this.getPatterns(now);

    for (const { regex, resolve } of patterns) {
      const match = query.match(regex);
      if (match) {
        const filter = resolve(match, now);
        // Strip the temporal expression from the query for embedding search
        const semanticQuery = query
          .replace(match[0], '')
          .replace(/\s+/g, ' ')
          .trim();
        return {
          semanticQuery: semanticQuery || query, // Fallback to original if stripping leaves nothing
          temporalFilter: filter,
        };
      }
    }

    return null;
  }

  private getPatterns(now: Date): TemporalPattern[] {
    return [
      // "today", "this morning", "this afternoon", "tonight"
      {
        regex: /\b(today|this morning|this afternoon|this evening|tonight)\b/i,
        resolve: (m) => this.dayRange(now, 0, m[0]),
      },
      // "yesterday"
      {
        regex: /\byesterday\b/i,
        resolve: (m) => this.dayRange(now, -1, 'yesterday'),
      },
      // "day before yesterday"
      {
        regex: /\b(day before yesterday|two days ago|2 days ago)\b/i,
        resolve: (m) => this.dayRange(now, -2, m[0]),
      },
      // "N hours ago"
      {
        regex: /\b(\d+)\s+(hours?)\s+ago\b/i,
        resolve: (m) => this.hoursAgo(now, parseInt(m[1]), m[0]),
      },
      // "N minutes ago"
      {
        regex: /\b(\d+)\s+(minutes?)\s+ago\b/i,
        resolve: (m) => this.minutesAgo(now, parseInt(m[1]), m[0]),
      },
      // "N days ago"
      {
        regex: /\b(\d+)\s+(days?)\s+ago\b/i,
        resolve: (m) => this.dayRange(now, -parseInt(m[1]), m[0]),
      },
      // "N weeks ago"
      {
        regex: /\b(\d+)\s+(weeks?)\s+ago\b/i,
        resolve: (m) => this.dayRange(now, -parseInt(m[1]) * 7, m[0]),
      },
      // "N months ago"
      {
        regex: /\b(\d+)\s+(months?)\s+ago\b/i,
        resolve: (m) => {
          const d = new Date(now);
          d.setMonth(d.getMonth() - parseInt(m[1]));
          const start = new Date(d);
          start.setDate(1);
          start.setHours(0, 0, 0, 0);
          const end = new Date(d);
          end.setMonth(end.getMonth() + 1);
          end.setDate(0);
          end.setHours(23, 59, 59, 999);
          return { start, end, expression: m[0], confidence: 0.85 };
        },
      },
      // "N years ago"
      {
        regex: /\b(\d+)\s+(years?)\s+ago\b/i,
        resolve: (m) => {
          const d = new Date(now);
          d.setFullYear(d.getFullYear() - parseInt(m[1]));
          const start = new Date(d.getFullYear(), 0, 1);
          const end = new Date(d.getFullYear(), 11, 31, 23, 59, 59, 999);
          return { start, end, expression: m[0], confidence: 0.85 };
        },
      },
      // "years ago" (no number — treat as 1-3 years range)
      {
        regex: /\b(years)\s+ago\b/i,
        resolve: (_m) => {
          const start = new Date(now);
          start.setFullYear(start.getFullYear() - 3);
          start.setMonth(0, 1);
          start.setHours(0, 0, 0, 0);
          const end = new Date(now);
          end.setFullYear(end.getFullYear() - 1);
          end.setMonth(0, 1);
          end.setHours(0, 0, 0, 0);
          return { start, end, expression: 'years ago', confidence: 0.7 };
        },
      },
      // "last/past N days"
      {
        regex: /\b(?:last|past)\s+(\d+)\s+days?\b/i,
        resolve: (m) => this.lastNDays(now, parseInt(m[1]), m[0]),
      },
      // "last week" / "past week"
      {
        regex: /\b(?:last|past)\s+week\b/i,
        resolve: (m) => this.lastNDays(now, 7, m[0]),
      },
      // "this week"
      {
        regex: /\bthis\s+week\b/i,
        resolve: (m) => this.thisWeek(now, m[0]),
      },
      // "last month" / "past month"
      {
        regex: /\b(?:last|past)\s+month\b/i,
        resolve: (m) => this.lastNDays(now, 30, m[0]),
      },
      // "this month"
      {
        regex: /\bthis\s+month\b/i,
        resolve: (m) => this.thisMonth(now, m[0]),
      },
      // "recently" / "lately" / "recent"
      {
        regex: /\b(recently|lately|recent)\b/i,
        resolve: (m) => this.lastNDays(now, 3, m[0]),
      },
      // "earlier today" / "earlier"
      {
        regex: /\b(earlier today|earlier)\b/i,
        resolve: (m) => this.dayRange(now, 0, m[0]),
      },
    ];
  }

  // ===========================================================================
  // Date Range Builders
  // ===========================================================================

  private dayRange(
    now: Date,
    offsetDays: number,
    expression: string,
  ): TemporalFilter {
    const target = new Date(now);
    target.setDate(target.getDate() + offsetDays);

    const start = new Date(target);
    start.setHours(0, 0, 0, 0);

    const end = new Date(target);
    end.setHours(23, 59, 59, 999);

    return { start, end, expression, confidence: 0.9 };
  }

  private lastNDays(
    now: Date,
    days: number,
    expression: string,
  ): TemporalFilter {
    const start = new Date(now);
    start.setDate(start.getDate() - days);
    start.setHours(0, 0, 0, 0);

    return { start, end: now, expression, confidence: 0.85 };
  }

  private thisWeek(now: Date, expression: string): TemporalFilter {
    const start = new Date(now);
    const day = start.getDay(); // 0=Sun, 1=Mon
    const diff = day === 0 ? 6 : day - 1; // Adjust to Monday start
    start.setDate(start.getDate() - diff);
    start.setHours(0, 0, 0, 0);

    return { start, end: now, expression, confidence: 0.85 };
  }

  private thisMonth(now: Date, expression: string): TemporalFilter {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return { start, end: now, expression, confidence: 0.85 };
  }

  private hoursAgo(
    now: Date,
    hours: number,
    expression: string,
  ): TemporalFilter {
    const start = new Date(now.getTime() - hours * 60 * 60 * 1000);
    return { start, end: now, expression, confidence: 0.9 };
  }

  private minutesAgo(
    now: Date,
    minutes: number,
    expression: string,
  ): TemporalFilter {
    const start = new Date(now.getTime() - minutes * 60 * 1000);
    return { start, end: now, expression, confidence: 0.9 };
  }
}

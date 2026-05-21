import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryLayer, MemorySource } from '@prisma/client';
import { generateContentHash } from '../common/content-hash.util';

/**
 * ENG-131: Temporal gap markers on session resume.
 *
 * When ingest resumes after an extended quiet period, insert a "temporal_gap"
 * memory record BEFORE the new memory. The marker is a normal memory row
 * (so it embeds and surfaces in retrieval) but is typed `TEMPORAL_GAP`.
 *
 * Behavior gates / configuration:
 *   ENABLE_TEMPORAL_GAP_MARKERS   default "true"  - disable to keep benchmarks clean
 *   GAP_MARKER_THRESHOLD_SECONDS  default 600     - minimum gap to fire a marker
 *
 * Inspired by Mastra OM "time passed" markers (anchors observations temporally).
 *
 * NOTE: `TEMPORAL_GAP` is added to the Prisma `MemoryType` enum in the
 * accompanying migration (20260521_add_temporal_gap_memory_type). Until
 * `prisma generate` runs, the typed enum reference is widened via `as any`.
 */
const TEMPORAL_GAP_TYPE = 'TEMPORAL_GAP' as any;

@Injectable()
export class TemporalGapMarkerService {
  private readonly logger = new Logger(TemporalGapMarkerService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Is the marker feature enabled at all? */
  isEnabled(): boolean {
    const raw = process.env.ENABLE_TEMPORAL_GAP_MARKERS;
    if (raw === undefined || raw === null || raw === '') return true;
    return raw.toLowerCase() !== 'false' && raw !== '0';
  }

  /** Threshold (in seconds) for a "gap" to be marker-worthy. */
  thresholdSeconds(): number {
    const raw = process.env.GAP_MARKER_THRESHOLD_SECONDS;
    if (!raw) return 600;
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 600;
    return parsed;
  }

  /**
   * Pure helper: should we insert a gap marker given the prior + current
   * timestamps? Exposed for unit testing of boundary cases.
   *
   * Semantics:
   *   - No prior memory       -> no marker (nothing to bridge from)
   *   - gap < threshold       -> no marker
   *   - gap === threshold     -> no marker (strictly greater than threshold)
   *   - gap > threshold       -> marker
   */
  shouldInsertMarker(
    prevTimestamp: Date | null | undefined,
    currTimestamp: Date,
    thresholdSeconds: number,
  ): boolean {
    if (!prevTimestamp) return false;
    const gapMs = currTimestamp.getTime() - prevTimestamp.getTime();
    if (gapMs <= 0) return false;
    return gapMs / 1000 > thresholdSeconds;
  }

  /**
   * Pure helper: format gap_seconds as "2 hours 14 minutes" / "45 seconds".
   * Public for testing.
   */
  formatGap(gapSeconds: number): string {
    const total = Math.max(0, Math.floor(gapSeconds));
    if (total < 60) {
      return `${total} ${total === 1 ? 'second' : 'seconds'}`;
    }

    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);

    const parts: string[] = [];
    if (days > 0) parts.push(`${days} ${days === 1 ? 'day' : 'days'}`);
    if (hours > 0) parts.push(`${hours} ${hours === 1 ? 'hour' : 'hours'}`);
    if (minutes > 0)
      parts.push(`${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`);

    // Sub-minute remainder is intentionally elided once we are above 1 minute -
    // we want "2 hours 14 minutes" not "2 hours 14 minutes 6 seconds".
    return parts.join(' ') || `${total} seconds`;
  }

  /**
   * Look up the most recent prior memory for this agent (+session if given),
   * excluding gap markers themselves and soft-deleted rows.
   *
   * Returns null when there is no prior memory (first write in this scope).
   */
  async findLastMemoryTimestamp(opts: {
    userId: string;
    agentId?: string | null;
    sessionId?: string | null;
  }): Promise<Date | null> {
    // We require at least an agentId scope - userId-only would be far too broad
    // and would not match the spec ("last memory for that agent_id"). If no
    // agentId, we can still scope by sessionId alone.
    if (!opts.agentId && !opts.sessionId) {
      return null;
    }

    const where: any = {
      userId: opts.userId,
      deletedAt: null,
      NOT: { memoryType: TEMPORAL_GAP_TYPE },
    };
    if (opts.agentId) where.agentId = opts.agentId;
    if (opts.sessionId) where.sessionId = opts.sessionId;

    const prev = await this.prisma.memory.findFirst({
      where,
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return prev?.createdAt ?? null;
  }

  /**
   * If a marker is warranted, insert it and return a small descriptor.
   * Otherwise return null.
   *
   * Side-effect-only on the gap marker itself; does NOT touch the new memory
   * or the embedding pipeline beyond writing a normal `memories` row. The
   * caller can optionally pass an `enqueueEmbedding` callback so the marker
   * gets embedded via the standard queue.
   */
  async maybeInsertMarker(opts: {
    userId: string;
    agentId?: string | null;
    sessionId?: string | null;
    nowTimestamp?: Date;
    enqueueEmbedding?: (memoryId: string, raw: string) => Promise<void> | void;
  }): Promise<{ id: string; raw: string; gapSeconds: number } | null> {
    if (!this.isEnabled()) return null;

    const now = opts.nowTimestamp ?? new Date();
    const threshold = this.thresholdSeconds();

    let prevTimestamp: Date | null;
    try {
      prevTimestamp = await this.findLastMemoryTimestamp({
        userId: opts.userId,
        agentId: opts.agentId,
        sessionId: opts.sessionId,
      });
    } catch (err) {
      // Never block the caller's write because of a marker-lookup failure.
      this.logger.warn(
        `[TemporalGapMarker] prior-memory lookup failed; skipping marker: ${(err as Error).message}`,
      );
      return null;
    }

    if (!this.shouldInsertMarker(prevTimestamp, now, threshold)) {
      return null;
    }

    const gapSeconds = Math.floor(
      (now.getTime() - (prevTimestamp as Date).getTime()) / 1000,
    );
    const humanGap = this.formatGap(gapSeconds);
    const prevIso = (prevTimestamp as Date).toISOString();
    const currIso = now.toISOString();

    const raw = `Temporal gap: ${humanGap} elapsed since the previous memory (${prevIso} -> ${currIso}).`;

    try {
      const marker = await this.prisma.memory.create({
        data: {
          userId: opts.userId,
          agentId: opts.agentId ?? undefined,
          sessionId: opts.sessionId ?? undefined,
          raw,
          layer: MemoryLayer.SESSION,
          source: MemorySource.SYSTEM,
          memoryType: TEMPORAL_GAP_TYPE,
          // ENG-131: Excluded from recall like dream-cycle derivatives (ENG-94).
          // Markers are temporal anchors for context, not semantic recall targets.
          searchable: false,
          // priority 4 matches EVENT - low-priority anchor, not safety-critical
          priority: 4,
          importanceScore: 0.2,
          confidence: 1.0,
          contentHash: generateContentHash(raw),
          tags: ['temporal_gap'],
          metadata: {
            kind: 'temporal_gap',
            gap_seconds: gapSeconds,
            prev_timestamp: prevIso,
            curr_timestamp: currIso,
            threshold_seconds: threshold,
            human_readable: humanGap,
          },
        },
      });

      // Markers are searchable=false — do not embed them.
      // The enqueueEmbedding callback is kept in the API for future use but
      // intentionally not called here so markers never surface in vector recall.

      this.logger.log(
        `[TemporalGapMarker] inserted marker ${marker.id} (gap=${humanGap}, agent=${opts.agentId ?? 'n/a'}, session=${opts.sessionId ?? 'n/a'})`,
      );

      return { id: marker.id, raw, gapSeconds };
    } catch (err) {
      this.logger.error(
        `[TemporalGapMarker] failed to insert marker: ${(err as Error).message}`,
      );
      return null;
    }
  }
}

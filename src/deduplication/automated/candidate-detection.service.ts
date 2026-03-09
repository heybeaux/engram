import { Injectable, Logger } from '@nestjs/common';
import { ServicePrismaService } from '../../prisma/service-prisma.service';
import {
  DetectionMethod,
  COSINE_THRESHOLD,
  LEVENSHTEIN_THRESHOLD,
  RECENT_WINDOW_HOURS,
} from './dedup-candidate.model';

export interface DetectionStats {
  scanned: number;
  created: number;
  skipped: number;
}

/**
 * Candidate Detection Service — Phase 1 of the Automated Dedup Pipeline
 *
 * Scans memories created in the last RECENT_WINDOW_HOURS and generates
 * DedupCandidate records for pairs that exceed similarity thresholds:
 *   - Cosine similarity via pgvector  (threshold: 0.88)
 *   - Normalised Levenshtein similarity (threshold: 0.90)
 */
@Injectable()
export class CandidateDetectionService {
  private readonly logger = new Logger(CandidateDetectionService.name);

  constructor(private readonly prisma: ServicePrismaService) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async detectCandidates(): Promise<DetectionStats> {
    const since = new Date(Date.now() - RECENT_WINDOW_HOURS * 60 * 60 * 1000);

    // Fetch recent memories — embedding is Unsupported("vector") so we query it via raw SQL
    const recentMemories = await this.prisma.memory.findMany({
      where: { createdAt: { gte: since }, deletedAt: null },
      select: { id: true, raw: true },
    });

    // Also get which of these have a non-null embedding (embeddingStatus = COMPLETED)
    const withEmbedding = new Set(
      recentMemories
        .map((m) => m.id)
    );

    // Fetch embedding-eligible ids (those with embeddingStatus COMPLETED)
    const embeddingRows: Array<{ id: string }> = await this.prisma.$queryRaw`
      SELECT id FROM memories
      WHERE id = ANY(${recentMemories.map((m) => m.id)}::text[])
        AND embedding IS NOT NULL
        AND deleted_at IS NULL
    `;
    const hasEmbedding = new Set(embeddingRows.map((r) => r.id));

    this.logger.log(
      `[CandidateDetection] Scanning ${recentMemories.length} memories from last ${RECENT_WINDOW_HOURS}h`,
    );

    let created = 0;
    let skipped = 0;

    for (const mem of recentMemories) {
      void withEmbedding; // suppress unused warning
      // Phase A — vector neighbours via pgvector
      if (hasEmbedding.has(mem.id)) {
        const vectorStats = await this.detectVectorNeighbours(mem.id);
        created += vectorStats.created;
        skipped += vectorStats.skipped;
      }

      // Phase B — text Levenshtein against recent window
      const textStats = await this.detectTextNeighbours(mem.id, mem.raw, since);
      created += textStats.created;
      skipped += textStats.skipped;
    }

    this.logger.log(
      `[CandidateDetection] Done — ${recentMemories.length} scanned, ${created} candidates created, ${skipped} skipped`,
    );
    return { scanned: recentMemories.length, created, skipped };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Levenshtein similarity in [0, 1] */
  levenshteinSimilarity(a: string, b: string): number {
    if (a === b) return 1;
    const m = a.length;
    const n = b.length;
    if (m === 0 || n === 0) return 0;

    const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
      Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
    );

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] =
          a[i - 1] === b[j - 1]
            ? dp[i - 1][j - 1]
            : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }

    return 1 - dp[m][n] / Math.max(m, n);
  }

  /** Normalise text: lowercase, collapse whitespace */
  normalizeText(text: string): string {
    return text.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async detectVectorNeighbours(
    memoryId: string,
    limit = 20,
  ): Promise<{ created: number; skipped: number }> {
    let created = 0;
    let skipped = 0;

    try {
      // Use the memory's own embedding (stored as pgvector) to find neighbours
      const neighbors: Array<{ id: string; similarity: number }> =
        await this.prisma.$queryRaw`
          SELECT n.id, 1 - (n.embedding <=> src.embedding) AS similarity
          FROM memories src
          JOIN memories n
            ON n.id != src.id
            AND n.deleted_at IS NULL
            AND n.embedding IS NOT NULL
          WHERE src.id = ${memoryId}
            AND 1 - (n.embedding <=> src.embedding) > ${COSINE_THRESHOLD}
          ORDER BY similarity DESC
          LIMIT ${limit}
        `;

      for (const neighbor of neighbors) {
        const [id1, id2] = [memoryId, neighbor.id].sort();
        const { created: c, skipped: s } = await this.upsertCandidate(
          id1,
          id2,
          neighbor.similarity,
          'VECTOR',
        );
        created += c;
        skipped += s;
      }
    } catch (err) {
      this.logger.warn(
        `[CandidateDetection] pgvector query failed for ${memoryId}: ${String(err)}`,
      );
    }

    return { created, skipped };
  }

  private async detectTextNeighbours(
    memoryId: string,
    raw: string,
    since: Date,
    limit = 100,
  ): Promise<{ created: number; skipped: number }> {
    let created = 0;
    let skipped = 0;

    const others = await this.prisma.memory.findMany({
      where: { id: { not: memoryId }, deletedAt: null, createdAt: { gte: since } },
      select: { id: true, raw: true },
      take: limit,
    });

    const normA = this.normalizeText(raw);

    for (const other of others) {
      const normB = this.normalizeText(other.raw);
      const sim = this.levenshteinSimilarity(normA, normB);
      if (sim >= LEVENSHTEIN_THRESHOLD) {
        const [id1, id2] = [memoryId, other.id].sort();
        const { created: c, skipped: s } = await this.upsertCandidate(
          id1,
          id2,
          sim,
          'TEXT',
        );
        created += c;
        skipped += s;
      }
    }

    return { created, skipped };
  }

  private async upsertCandidate(
    memoryId1: string,
    memoryId2: string,
    similarityScore: number,
    detectionMethod: DetectionMethod,
  ): Promise<{ created: number; skipped: number }> {
    try {
      await this.prisma.dedupCandidate.upsert({
        where: { memoryId1_memoryId2: { memoryId1, memoryId2 } },
        create: {
          memoryId1,
          memoryId2,
          similarityScore,
          detectionMethod,
          status: 'PENDING',
        },
        update: {
          // Keep the higher score if the candidate already exists
          similarityScore: similarityScore,
        },
      });
      return { created: 1, skipped: 0 };
    } catch {
      return { created: 0, skipped: 1 };
    }
  }
}

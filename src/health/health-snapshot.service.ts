/**
 * HealthSnapshotService
 *
 * Records point-in-time health metric snapshots to enable historical trending
 * and dashboard graphing.
 *
 * Snapshot schema (health_metric_snapshots):
 *   - accountId  — which account this snapshot was triggered by
 *   - agentId    — optional, which agent triggered it
 *   - metricName — one of the METRIC_NAMES enum values
 *   - value      — 0-100 float (health score)
 *   - metadata   — JSON component breakdown for drill-down
 *   - createdAt  — timestamp of the reading
 *
 * Metric names:
 *   memory_freshness     — how "fresh" memories are (inverse of stale%)
 *   embedding_coverage   — % of memories with embeddings
 *   consolidation_health — dream cycle / consolidation pipeline health
 *   dedup_health         — duplicate-free ratio
 *   memory_vitality      — composite vitality score
 *
 * TODO: Schedule a cron job to call takeSnapshot() every hour.
 * Example using @nestjs/schedule:
 *   @Cron('0 * * * *')
 *   async scheduledSnapshot() {
 *     await this.takeSnapshot('system');
 *   }
 */

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ServicePrismaService } from '../prisma/service-prisma.service';
import { HealthMetricsService } from './health-metrics.service';

export const METRIC_NAMES = [
  'memory_freshness',
  'embedding_coverage',
  'consolidation_health',
  'dedup_health',
  'memory_vitality',
] as const;

export type MetricName = (typeof METRIC_NAMES)[number];

export interface MetricSnapshot {
  id: string;
  accountId: string;
  agentId: string | null;
  metricName: MetricName;
  value: number;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface SnapshotResult {
  accountId: string;
  agentId: string | null;
  snapshots: MetricSnapshot[];
  takenAt: string;
}

@Injectable()
export class HealthSnapshotService {
  private readonly logger = new Logger(HealthSnapshotService.name);

  constructor(
    private readonly prisma: ServicePrismaService,
    private readonly healthMetrics: HealthMetricsService,
  ) {}

  /**
   * Compute current health metrics and persist them as a snapshot.
   *
   * @param accountId - The account requesting the snapshot (used for attribution)
   * @param agentId   - Optional agent context
   * @returns All 5 metric snapshots just written
   */
  async takeSnapshot(
    accountId: string,
    agentId?: string,
  ): Promise<SnapshotResult> {
    this.logger.log(`Taking health metric snapshot for accountId=${accountId}`);

    // Compute live metrics
    const report = await this.healthMetrics.compute();

    // Map raw metric keys → standardised MetricName values + derived scores
    const embeddingCoverage = this.extractFloat(
      report.metrics,
      'embedding_coverage_pct',
      100,
    );
    const duplicateRatio = this.extractFloat(
      report.metrics,
      'duplicate_ratio_pct',
      0,
    );
    const stalePct = this.extractFloat(report.metrics, 'stale_memories_pct', 0);
    const dreamCycleSla = this.extractObject(
      report.metrics,
      'dream_cycle_sla',
    ) as {
      minutesSinceLastComplete: number | null;
      stages: Record<string, number | null>;
    } | null;

    // Derived scores (0-100)
    const memoryFreshness = Math.max(0, 100 - stalePct);
    const dedupHealth = Math.max(0, 100 - duplicateRatio);
    const consolidationHealth = this.computeConsolidationHealth(dreamCycleSla);
    const memoryVitality = this.computeVitality({
      embeddingCoverage,
      dedupHealth,
      memoryFreshness,
      consolidationHealth,
    });

    const metricsToWrite: Array<{
      metricName: MetricName;
      value: number;
      metadata: Prisma.InputJsonValue;
    }> = [
      {
        metricName: 'memory_freshness',
        value: Math.round(memoryFreshness * 100) / 100,
        metadata: { stale_pct: stalePct, total_memories: report.totalMemories },
      },
      {
        metricName: 'embedding_coverage',
        value: Math.round(embeddingCoverage * 100) / 100,
        metadata: { total_memories: report.totalMemories },
      },
      {
        metricName: 'consolidation_health',
        value: Math.round(consolidationHealth * 100) / 100,
        metadata: {
          minutes_since_last_complete:
            dreamCycleSla?.minutesSinceLastComplete ?? null,
          stages: dreamCycleSla?.stages ?? {},
        },
      },
      {
        metricName: 'dedup_health',
        value: Math.round(dedupHealth * 100) / 100,
        metadata: { duplicate_ratio_pct: duplicateRatio },
      },
      {
        metricName: 'memory_vitality',
        value: Math.round(memoryVitality * 100) / 100,
        metadata: {
          components: {
            embedding_coverage: embeddingCoverage,
            dedup_health: dedupHealth,
            memory_freshness: memoryFreshness,
            consolidation_health: consolidationHealth,
          },
        },
      },
    ];

    // Bulk insert
    const created = await Promise.all(
      metricsToWrite.map((m) =>
        this.prisma.healthMetricSnapshot.create({
          data: {
            accountId,
            agentId: agentId ?? null,
            metricName: m.metricName,
            value: m.value,
            metadata: m.metadata,
          },
        }),
      ),
    );

    this.logger.log(
      `Snapshot complete: wrote ${created.length} metrics for accountId=${accountId}`,
    );

    return {
      accountId,
      agentId: agentId ?? null,
      snapshots: created as unknown as MetricSnapshot[],
      takenAt: new Date().toISOString(),
    };
  }

  /**
   * Return historical readings for a specific metric.
   *
   * @param accountId  - Account to query
   * @param metricName - One of the METRIC_NAMES
   * @param days       - How many days back to look (default 30)
   */
  async getHistory(
    accountId: string,
    metricName: MetricName,
    days = 30,
  ): Promise<MetricSnapshot[]> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const rows = await this.prisma.healthMetricSnapshot.findMany({
      where: {
        accountId,
        metricName,
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'asc' },
    });

    return rows as unknown as MetricSnapshot[];
  }

  /**
   * Return the most recent snapshot for each of the 5 metrics.
   *
   * @param accountId - Account to query
   */
  async getLatestAll(
    accountId: string,
  ): Promise<Record<MetricName, MetricSnapshot | null>> {
    const result = {} as Record<MetricName, MetricSnapshot | null>;

    await Promise.all(
      METRIC_NAMES.map(async (name) => {
        const row = await this.prisma.healthMetricSnapshot.findFirst({
          where: { accountId, metricName: name },
          orderBy: { createdAt: 'desc' },
        });
        result[name] = row as unknown as MetricSnapshot | null;
      }),
    );

    return result;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private extractFloat(
    metrics: Array<{ key: string; value: unknown }>,
    key: string,
    defaultValue: number,
  ): number {
    const m = metrics.find((x) => x.key === key);
    if (!m) return defaultValue;
    const v = m.value;
    return typeof v === 'number' ? v : defaultValue;
  }

  private extractObject(
    metrics: Array<{ key: string; value: unknown }>,
    key: string,
  ): unknown {
    const m = metrics.find((x) => x.key === key);
    return m?.value ?? null;
  }

  private computeConsolidationHealth(
    dreamCycleSla: {
      minutesSinceLastComplete: number | null;
      stages: Record<string, number | null>;
    } | null,
  ): number {
    if (!dreamCycleSla || dreamCycleSla.minutesSinceLastComplete === null) {
      // No data → degraded score
      return 40;
    }
    const mins = dreamCycleSla.minutesSinceLastComplete;
    if (mins <= 25 * 60) return 100; // ≤25h → green
    if (mins <= 48 * 60) return 65; // ≤48h → yellow
    return 20; // >48h → red
  }

  private computeVitality(components: {
    embeddingCoverage: number;
    dedupHealth: number;
    memoryFreshness: number;
    consolidationHealth: number;
  }): number {
    // Weighted composite: embeddings & dedup carry more weight than freshness
    const {
      embeddingCoverage,
      dedupHealth,
      memoryFreshness,
      consolidationHealth,
    } = components;
    return (
      embeddingCoverage * 0.35 +
      dedupHealth * 0.25 +
      memoryFreshness * 0.2 +
      consolidationHealth * 0.2
    );
  }
}

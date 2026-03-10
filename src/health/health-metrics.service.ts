import { Injectable, Logger } from '@nestjs/common';
import { ServicePrismaService } from '../prisma/service-prisma.service';

export interface MemoryHealthMetric {
  key: string;
  label: string;
  value: number | object;
  unit?: string;
  status: 'green' | 'yellow' | 'red' | 'info';
  description: string;
  computedAt: string;
}

export interface MemoryHealthReport {
  metrics: MemoryHealthMetric[];
  computedAt: string;
  totalMemories: number;
}

@Injectable()
export class HealthMetricsService {
  private readonly logger = new Logger(HealthMetricsService.name);

  constructor(private readonly prisma: ServicePrismaService) {}

  async compute(): Promise<MemoryHealthReport> {
    const computedAt = new Date().toISOString();
    const [
      totalMemories,
      embeddingPct,
      dupPct,
      stalePct,
      layerDist,
      dreamCycleSla,
    ] = await Promise.all([
      this.getTotalMemories(),
      this.getEmbeddingCoverage(),
      this.getDuplicateRatio(),
      this.getStalePct(),
      this.getLayerDistribution(),
      this.getDreamCycleSla(),
    ]);

    const metrics: MemoryHealthMetric[] = [
      {
        key: 'embedding_coverage_pct',
        label: 'Embedding Coverage',
        value: embeddingPct,
        unit: '%',
        status:
          embeddingPct >= 95 ? 'green' : embeddingPct >= 80 ? 'yellow' : 'red',
        description: 'Percentage of memories with vector embeddings',
        computedAt,
      },
      {
        key: 'duplicate_ratio_pct',
        label: 'Duplicate Ratio',
        value: dupPct,
        unit: '%',
        status: dupPct <= 5 ? 'green' : dupPct <= 15 ? 'yellow' : 'red',
        description: 'Percentage of memories that are exact-text duplicates',
        computedAt,
      },
      {
        key: 'stale_memories_pct',
        label: 'Stale Memories',
        value: stalePct,
        unit: '%',
        status: stalePct <= 20 ? 'green' : stalePct <= 40 ? 'yellow' : 'red',
        description: 'Percentage of memories untouched in the last 30 days',
        computedAt,
      },
      {
        key: 'layer_distribution',
        label: 'Memory Layer Distribution',
        value: layerDist,
        status: 'info',
        description:
          'Count of memories by layer (SESSION, PROJECT, INSIGHT, etc.)',
        computedAt,
      },
      {
        key: 'dream_cycle_sla',
        label: 'Dream Cycle SLA',
        value: dreamCycleSla,
        status:
          dreamCycleSla.minutesSinceLastComplete !== null
            ? dreamCycleSla.minutesSinceLastComplete <= 25 * 60
              ? 'green'
              : dreamCycleSla.minutesSinceLastComplete <= 48 * 60
                ? 'yellow'
                : 'red'
            : 'red',
        description: 'Minutes since Dream Cycle last completed each stage',
        computedAt,
      },
    ];

    return { metrics, computedAt, totalMemories };
  }

  async computeAndPersist(): Promise<MemoryHealthReport> {
    const report = await this.compute();
    await Promise.all(
      report.metrics.map((m) =>
        this.prisma.systemMetric.upsert({
          where: { key: m.key },
          update: { value: m.value as any, computedAt: new Date(m.computedAt) },
          create: {
            key: m.key,
            value: m.value as any,
            description: m.description,
            computedAt: new Date(m.computedAt),
          },
        }),
      ),
    );
    this.logger.log(
      `Health metrics persisted: ${report.metrics.length} metrics, totalMemories=${report.totalMemories}`,
    );
    return report;
  }

  async getLatest(): Promise<MemoryHealthReport> {
    const stored = await this.prisma.systemMetric.findMany();
    if (stored.length === 0) {
      this.logger.warn('No stored metrics — computing live');
      return this.compute();
    }
    const computedAt = stored
      .reduce(
        (latest, m) => (m.computedAt > latest ? m.computedAt : latest),
        stored[0].computedAt,
      )
      .toISOString();
    const metrics: MemoryHealthMetric[] = stored
      .filter((m) => m.key !== 'total_memories')
      .map((m) => ({
        key: m.key,
        label: m.key
          .replace(/_/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase()),
        value: m.value as any,
        status: 'info' as const,
        description: m.description ?? '',
        computedAt: m.computedAt.toISOString(),
      }));
    return { metrics, computedAt, totalMemories: 0 };
  }

  private async getTotalMemories(): Promise<number> {
    return this.prisma.memory.count({ where: { deletedAt: null } });
  }

  private async getEmbeddingCoverage(): Promise<number> {
    const result = await this.prisma.$queryRaw<[{ pct: number }]>`
      SELECT ROUND(100.0 * COUNT(embedding) / NULLIF(COUNT(*), 0), 2)::float AS pct
      FROM memories WHERE deleted_at IS NULL
    `;
    return result[0]?.pct ?? 0;
  }

  private async getDuplicateRatio(): Promise<number> {
    const result = await this.prisma.$queryRaw<[{ pct: number }]>`
      WITH dups AS (
        SELECT raw, COUNT(*) AS c FROM memories WHERE deleted_at IS NULL GROUP BY raw HAVING COUNT(*) > 1
      )
      SELECT ROUND(100.0 * COALESCE(SUM(c - 1), 0) / NULLIF((SELECT COUNT(*) FROM memories WHERE deleted_at IS NULL), 0), 2)::float AS pct
      FROM dups
    `;
    return result[0]?.pct ?? 0;
  }

  private async getStalePct(): Promise<number> {
    const result = await this.prisma.$queryRaw<[{ pct: number }]>`
      SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE updated_at < NOW() - INTERVAL '30 days') / NULLIF(COUNT(*), 0), 2)::float AS pct
      FROM memories WHERE deleted_at IS NULL
    `;
    return result[0]?.pct ?? 0;
  }

  private async getLayerDistribution(): Promise<Record<string, number>> {
    const rows = await this.prisma.memory.groupBy({
      by: ['layer'],
      where: { deletedAt: null },
      _count: { layer: true },
    });
    return Object.fromEntries(
      rows.map((r) => [r.layer ?? 'UNKNOWN', r._count.layer]),
    );
  }

  private async getDreamCycleSla(): Promise<{
    minutesSinceLastComplete: number | null;
    stages: Record<string, number | null>;
  }> {
    try {
      const result = await this.prisma.$queryRaw<
        Array<{ stage: string; minutes_since_ok: number | null }>
      >`
        SELECT stage, EXTRACT(epoch FROM (NOW() - MAX(finished_at))) / 60 AS minutes_since_ok
        FROM dream_cycle_runs WHERE status = 'COMPLETED' GROUP BY stage
      `;
      const stages = Object.fromEntries(
        result.map((r) => [
          r.stage,
          r.minutes_since_ok !== null
            ? Math.round(r.minutes_since_ok as unknown as number)
            : null,
        ]),
      );
      const values = Object.values(stages).filter((v) => v !== null);
      return {
        minutesSinceLastComplete:
          values.length > 0 ? Math.max(...values) : null,
        stages,
      };
    } catch {
      return { minutesSinceLastComplete: null, stages: {} };
    }
  }
}

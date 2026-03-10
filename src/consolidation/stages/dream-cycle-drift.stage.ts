import { Injectable, Optional } from '@nestjs/common';
import { ServicePrismaService } from '../../prisma/service-prisma.service';
import { DriftDetectionService } from '../../ensemble/drift-detection.service';
import { EnsembleService } from '../../ensemble/ensemble.service';

export interface DriftStageResult {
  modelsAnalyzed: number;
  snapshotsPersisted: number;
  alerts: string[];
}

@Injectable()
export class DreamCycleDriftStage {
  constructor(
    private readonly prisma: ServicePrismaService,
    @Optional() private readonly driftDetectionService?: DriftDetectionService,
    @Optional() private readonly ensembleService?: EnsembleService,
  ) {}

  async run(userId: string, dryRun: boolean): Promise<DriftStageResult> {
    const alerts: string[] = [];
    let snapshotsPersisted = 0;

    const memories = await this.prisma.memory.findMany({
      where: { userId, deletedAt: null },
      select: { id: true, raw: true },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });

    if (
      memories.length === 0 ||
      !this.driftDetectionService ||
      !this.ensembleService
    ) {
      return { modelsAnalyzed: 0, snapshotsPersisted: 0, alerts: [] };
    }

    const config = this.ensembleService.getConfig();
    const models = config.models;

    for (const model of models) {
      const newEmbeddings: number[][] = [];
      for (const memory of memories) {
        try {
          const result = await this.ensembleService.embedAll(memory.raw);
          const modelEmbed = result.embeddings.find(
            (e: any) => e.model === model,
          );
          newEmbeddings.push(modelEmbed ? modelEmbed.embedding : []);
        } catch {
          newEmbeddings.push([]);
        }
      }

      const analyses = await this.driftDetectionService.measureBatchDrift(
        memories,
        newEmbeddings,
        model as any,
      );

      const summary = this.driftDetectionService.summarizeDrift(analyses);
      const thresholds = this.driftDetectionService.getThresholds();

      let alertLevel = 'normal';
      if (summary.avgCosineDrift > thresholds.alert) {
        alertLevel = 'critical';
        alerts.push(
          `Critical drift on ${model}: avg=${summary.avgCosineDrift.toFixed(4)}`,
        );
      } else if (summary.avgCosineDrift > thresholds.drift) {
        alertLevel = 'warning';
        alerts.push(
          `Warning drift on ${model}: avg=${summary.avgCosineDrift.toFixed(4)}`,
        );
      }

      if (!dryRun) {
        await this.prisma.driftSnapshot.create({
          data: {
            modelId: model,
            avgDrift: summary.avgCosineDrift,
            maxDrift: summary.maxCosineDrift,
            sampleCount: analyses.length,
            alertLevel,
          },
        });
        snapshotsPersisted++;
      }
    }

    return { modelsAnalyzed: models.length, snapshotsPersisted, alerts };
  }
}

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ServicePrismaService } from '../prisma/service-prisma.service';
import { rlsContext } from '../prisma/rls-context';
import { EnsembleService } from './ensemble.service';
import { DriftDetectionService } from './drift-detection.service';
import { ModelId } from './ensemble.types';

export type DriftAnalysisJobState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed';

export interface DriftAnalyzeSnapshot {
  modelId: string;
  avgDrift: number;
  maxDrift: number;
  sampleCount: number;
  alertLevel: string;
}

export interface DriftAnalyzeResult {
  snapshots: DriftAnalyzeSnapshot[];
  summary: string;
}

export interface DriftAnalysisJobStatus {
  jobId: string;
  status: DriftAnalysisJobState;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  progress: {
    current: number;
    total: number;
    message?: string;
  };
  snapshots?: DriftAnalyzeSnapshot[];
  summary?: string;
  error?: string;
}

interface InternalDriftAnalysisJob extends DriftAnalysisJobStatus {
  accountId: string | null;
}

const GLOBAL_ACCOUNT_KEY = '__global__';

@Injectable()
export class DriftAnalysisJobService {
  private readonly logger = new Logger(DriftAnalysisJobService.name);
  private readonly jobs = new Map<string, InternalDriftAnalysisJob>();
  private readonly activeJobByAccount = new Map<string, string>();

  constructor(
    private readonly prisma: ServicePrismaService,
    private readonly ensembleService: EnsembleService,
    private readonly driftDetectionService: DriftDetectionService,
  ) {}

  enqueue(accountId: string | null): DriftAnalysisJobStatus {
    const accountKey = this.accountKey(accountId);
    const activeJobId = this.activeJobByAccount.get(accountKey);
    if (activeJobId) {
      const activeJob = this.jobs.get(activeJobId);
      if (
        activeJob &&
        (activeJob.status === 'queued' || activeJob.status === 'running')
      ) {
        return this.toPublicStatus(activeJob);
      }
      this.activeJobByAccount.delete(accountKey);
    }

    const job: InternalDriftAnalysisJob = {
      jobId: `drift_${randomUUID()}`,
      accountId,
      status: 'queued',
      createdAt: new Date(),
      progress: { current: 0, total: 0, message: 'Queued drift analysis' },
    };

    this.jobs.set(job.jobId, job);
    this.activeJobByAccount.set(accountKey, job.jobId);

    // Enqueue the worker outside request AsyncLocalStorage so the background
    // job cannot inherit a completed RLS transaction from the HTTP request.
    rlsContext.exit(() => {
      setImmediate(() => {
        void this.runJob(job).catch((err) => {
          this.logger.error(
            `Unhandled drift analysis job failure: ${err instanceof Error ? err.message : String(err)}`,
            err instanceof Error ? err.stack : undefined,
          );
        });
      });
    });

    return this.toPublicStatus(job);
  }

  getStatus(jobId: string): DriftAnalysisJobStatus | null {
    const job = this.jobs.get(jobId);
    return job ? this.toPublicStatus(job) : null;
  }

  getStatusOrThrow(
    jobId: string,
    accountId: string | null,
  ): DriftAnalysisJobStatus {
    const job = this.jobs.get(jobId);
    if (!job || this.accountKey(job.accountId) !== this.accountKey(accountId)) {
      throw new NotFoundException('Drift analysis job not found');
    }
    return this.toPublicStatus(job);
  }

  async analyzeNow(
    accountId: string | null,
    onProgress?: (current: number, total: number, message?: string) => void,
  ): Promise<DriftAnalyzeResult> {
    const memories = await this.findMemoriesForAccount(accountId);

    if (memories.length === 0) {
      onProgress?.(0, 0, 'No memories to analyze');
      return { snapshots: [], summary: 'No memories to analyze' };
    }

    const config = this.ensembleService.getConfig();
    const models = config.models;
    const snapshots: DriftAnalyzeSnapshot[] = [];

    onProgress?.(0, models.length, `Analyzing ${models.length} model(s)`);

    for (const model of models) {
      onProgress?.(
        snapshots.length,
        models.length,
        `Analyzing drift for ${String(model)}`,
      );

      const analyses = await this.driftDetectionService.measureBatchDrift(
        memories,
        await this.generateEmbeddingsForModel(memories, model),
        model,
      );

      const driftSummary = this.driftDetectionService.summarizeDrift(analyses);
      const thresholds = this.driftDetectionService.getThresholds();

      let alertLevel = 'normal';
      if (driftSummary.avgCosineDrift > thresholds.alert) {
        alertLevel = 'critical';
      } else if (driftSummary.avgCosineDrift > thresholds.drift) {
        alertLevel = 'warning';
      }

      await this.prisma.driftSnapshot.create({
        data: {
          accountId,
          modelId: model,
          avgDrift: driftSummary.avgCosineDrift,
          maxDrift: driftSummary.maxCosineDrift,
          sampleCount: analyses.length,
          alertLevel,
        },
      });

      snapshots.push({
        modelId: model,
        avgDrift: driftSummary.avgCosineDrift,
        maxDrift: driftSummary.maxCosineDrift,
        sampleCount: analyses.length,
        alertLevel,
      });

      onProgress?.(
        snapshots.length,
        models.length,
        `Completed drift analysis for ${String(model)}`,
      );
    }

    return { snapshots, summary: this.summarizeSnapshots(snapshots) };
  }

  private async runJob(job: InternalDriftAnalysisJob): Promise<void> {
    job.status = 'running';
    job.startedAt = new Date();
    job.progress = { current: 0, total: 0, message: 'Starting drift analysis' };

    try {
      const result = await this.analyzeNow(
        job.accountId,
        (current, total, message) => {
          job.progress = { current, total, message };
        },
      );

      job.status = 'succeeded';
      job.completedAt = new Date();
      job.progress = {
        current: result.snapshots.length,
        total: result.snapshots.length,
        message: result.summary,
      };
      job.snapshots = result.snapshots;
      job.summary = result.summary;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Drift analysis job ${job.jobId} failed: ${message}`,
        err instanceof Error ? err.stack : undefined,
      );
      job.status = 'failed';
      job.completedAt = new Date();
      job.error = 'Drift analysis failed';
      job.progress = { ...job.progress, message: 'Drift analysis failed' };
    } finally {
      const accountKey = this.accountKey(job.accountId);
      if (this.activeJobByAccount.get(accountKey) === job.jobId) {
        this.activeJobByAccount.delete(accountKey);
      }
    }
  }

  private async findMemoriesForAccount(
    accountId: string | null,
  ): Promise<Array<{ id: string; raw: string }>> {
    if (!accountId) {
      return this.prisma.memory.findMany({
        where: { deletedAt: null },
        select: { id: true, raw: true },
        orderBy: { updatedAt: 'desc' },
        take: 100,
      });
    }

    const users = await this.prisma.user.findMany({
      where: { accountId, deletedAt: null },
      select: { id: true },
    });
    const userIds = users.map((user) => user.id);
    if (userIds.length === 0) return [];

    return this.prisma.memory.findMany({
      where: { deletedAt: null, userId: { in: userIds } },
      select: { id: true, raw: true },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
  }

  private async generateEmbeddingsForModel(
    memories: Array<{ id: string; raw: string }>,
    model: ModelId,
  ): Promise<number[][]> {
    const embeddings: number[][] = [];
    for (const memory of memories) {
      try {
        const result = await this.ensembleService.embedAll(memory.raw);
        const modelEmbed = result.embeddings.find(
          (embedding) => embedding.model === model,
        );
        embeddings.push(modelEmbed ? modelEmbed.embedding : []);
      } catch {
        embeddings.push([]);
      }
    }
    return embeddings;
  }

  private summarizeSnapshots(snapshots: DriftAnalyzeSnapshot[]): string {
    const criticalCount = snapshots.filter(
      (snapshot) => snapshot.alertLevel === 'critical',
    ).length;
    const warningCount = snapshots.filter(
      (snapshot) => snapshot.alertLevel === 'warning',
    ).length;

    if (criticalCount > 0) return `${criticalCount} model(s) in critical drift`;
    if (warningCount > 0) return `${warningCount} model(s) with elevated drift`;
    return 'All models within normal drift range';
  }

  private accountKey(accountId: string | null): string {
    return accountId ?? GLOBAL_ACCOUNT_KEY;
  }

  private toPublicStatus(
    job: InternalDriftAnalysisJob,
  ): DriftAnalysisJobStatus {
    return {
      jobId: job.jobId,
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      progress: { ...job.progress },
      snapshots: job.snapshots ? [...job.snapshots] : undefined,
      summary: job.summary,
      error: job.error,
    };
  }
}

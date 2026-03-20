import { ModelId } from './ensemble.types';
/**
 * Checkpoint Service
 *
 * Manages checkpoints for resumable re-embedding jobs.
 * Uses PostgreSQL for persistence (Redis would be better for production).
 */

import { Injectable, Logger } from '@nestjs/common';
import { ServicePrismaService } from '../prisma/service-prisma.service';
import {
  ReembedCheckpoint,
  ReembedProgress,
  ReembedMetrics,
} from './ensemble.types';

@Injectable()
export class CheckpointService {
  private readonly logger = new Logger(CheckpointService.name);

  constructor(private readonly prisma: ServicePrismaService) {}

  /**
   * Save a checkpoint
   */
  async save(checkpoint: ReembedCheckpoint): Promise<void> {
    await this.prisma.ensembleReembedCheckpoint.upsert({
      where: { jobId: checkpoint.jobId },
      create: {
        jobId: checkpoint.jobId,
        lastProcessedId: checkpoint.lastProcessedId,
        progress: checkpoint.progress as any,
        completedModels: checkpoint.completedModels,
        metrics: checkpoint.metrics as any,
      },
      update: {
        lastProcessedId: checkpoint.lastProcessedId,
        progress: checkpoint.progress as any,
        completedModels: checkpoint.completedModels,
        metrics: checkpoint.metrics as any,
        createdAt: new Date(),
      },
    });

    this.logger.debug(`Checkpoint saved for job ${checkpoint.jobId}`);
  }

  /**
   * Get a checkpoint by job ID
   */
  async get(jobId: string): Promise<ReembedCheckpoint | null> {
    const record = await this.prisma.ensembleReembedCheckpoint.findUnique({
      where: { jobId },
    });

    if (!record) return null;

    return {
      jobId: record.jobId,
      createdAt: record.createdAt,
      lastProcessedId: record.lastProcessedId,
      progress: record.progress as unknown as ReembedProgress,
      completedModels: (record.completedModels || []) as ModelId[],
      metrics: record.metrics as Partial<ReembedMetrics>,
    };
  }

  /**
   * Delete a checkpoint
   */
  async delete(jobId: string): Promise<void> {
    await this.prisma.ensembleReembedCheckpoint.deleteMany({
      where: { jobId },
    });

    this.logger.debug(`Checkpoint deleted for job ${jobId}`);
  }

  /**
   * Find any active (non-expired) checkpoint
   */
  async findActiveCheckpoint(): Promise<ReembedCheckpoint | null> {
    // Consider checkpoints older than 24 hours as stale
    const staleThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const record = await this.prisma.ensembleReembedCheckpoint.findFirst({
      where: {
        createdAt: { gt: staleThreshold },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!record) return null;

    return {
      jobId: record.jobId,
      createdAt: record.createdAt,
      lastProcessedId: record.lastProcessedId,
      progress: record.progress as unknown as ReembedProgress,
      completedModels: (record.completedModels || []) as ModelId[],
      metrics: record.metrics as Partial<ReembedMetrics>,
    };
  }

  /**
   * List all active checkpoints
   */
  async listActive(): Promise<ReembedCheckpoint[]> {
    const staleThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const records = await this.prisma.ensembleReembedCheckpoint.findMany({
      where: {
        createdAt: { gt: staleThreshold },
      },
      orderBy: { createdAt: 'desc' },
    });

    return records.map((record) => ({
      jobId: record.jobId,
      createdAt: record.createdAt,
      lastProcessedId: record.lastProcessedId,
      progress: record.progress as unknown as ReembedProgress,
      completedModels: (record.completedModels || []) as ModelId[],
      metrics: record.metrics as Partial<ReembedMetrics>,
    }));
  }

  /**
   * Clean up stale checkpoints
   */
  async cleanupStale(): Promise<number> {
    const staleThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const result = await this.prisma.ensembleReembedCheckpoint.deleteMany({
      where: {
        createdAt: { lt: staleThreshold },
      },
    });

    if (result.count > 0) {
      this.logger.log(`Cleaned up ${result.count} stale checkpoints`);
    }

    return result.count;
  }
}

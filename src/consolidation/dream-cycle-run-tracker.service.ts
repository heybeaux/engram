import { Injectable, Logger } from '@nestjs/common';
import { ServicePrismaService } from '../prisma/service-prisma.service';

/**
 * A per-user report still RUNNING after this long was orphaned by a crash or
 * redeploy (local nightly runs finish in about an hour for 265 users).
 */
export const DREAM_CYCLE_STALE_MS = 6 * 60 * 60 * 1000;

export interface StageRunRecord {
  id: string;
  runId: string;
  stage: string;
}

@Injectable()
export class DreamCycleRunTrackerService {
  private readonly logger = new Logger(DreamCycleRunTrackerService.name);

  constructor(private readonly prisma: ServicePrismaService) {}

  async startStage(
    runId: string,
    stage: string,
    totalRows?: number,
  ): Promise<StageRunRecord> {
    const record = await this.prisma.dreamCycleStageRun.create({
      data: { runId, stage, status: 'STARTED', totalRows },
    });
    this.logger.debug(`Dream Cycle stage started: run=${runId} stage=${stage}`);
    return { id: record.id, runId: record.runId, stage: record.stage };
  }

  async completeStage(
    recordId: string,
    rowsTouched: number,
    startedAt: Date,
  ): Promise<void> {
    const now = new Date();
    await this.prisma.dreamCycleStageRun.update({
      where: { id: recordId },
      data: {
        status: 'COMPLETED',
        rowsTouched,
        finishedAt: now,
        durationMs: now.getTime() - startedAt.getTime(),
      },
    });
  }

  async abortStage(
    recordId: string,
    rowsTouched: number,
    totalRows: number,
    reason: string,
    startedAt: Date,
  ): Promise<void> {
    const now = new Date();
    await this.prisma.dreamCycleStageRun.update({
      where: { id: recordId },
      data: {
        status: 'ABORTED',
        rowsTouched,
        totalRows,
        errorMsg: reason.slice(0, 500),
        finishedAt: now,
        durationMs: now.getTime() - startedAt.getTime(),
      },
    });
    this.logger.warn(`Dream Cycle stage ABORTED: id=${recordId}`);
  }

  async errorStage(
    recordId: string,
    error: Error,
    startedAt: Date,
  ): Promise<void> {
    const now = new Date();
    await this.prisma.dreamCycleStageRun.update({
      where: { id: recordId },
      data: {
        status: 'ERROR',
        errorMsg: error.message.slice(0, 500),
        finishedAt: now,
        durationMs: now.getTime() - startedAt.getTime(),
      },
    });
  }

  /**
   * Marks orphaned RUNNING reports as FAILED. Without this an orphan stays the
   * newest report and /v1/health shows lastRun=null, status=RUNNING until the
   * next cycle starts.
   */
  async failStaleReports(staleMs = DREAM_CYCLE_STALE_MS): Promise<number> {
    const { count } = await this.prisma.dreamCycleReport.updateMany({
      where: {
        status: 'RUNNING',
        startedAt: { lt: new Date(Date.now() - staleMs) },
      },
      data: {
        status: 'FAILED',
        completedAt: new Date(),
        errors: { push: 'orphaned: still RUNNING past stale threshold' },
      },
    });
    if (count > 0) {
      this.logger.warn(`Marked ${count} orphaned Dream Cycle report(s) FAILED`);
    }
    return count;
  }

  async getTotalMemoryCount(userId?: string): Promise<number> {
    return this.prisma.memory.count({
      where: { deletedAt: null, ...(userId ? { userId } : {}) },
    });
  }
}

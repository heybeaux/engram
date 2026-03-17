import { Injectable, Logger } from '@nestjs/common';
import { ServicePrismaService } from '../prisma/service-prisma.service';

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

  async getTotalMemoryCount(userId?: string): Promise<number> {
    return this.prisma.memory.count({
      where: { deletedAt: null, ...(userId ? { userId } : {}) },
    });
  }
}

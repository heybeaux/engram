import {
  Injectable,
  Logger,
  Optional,
  BadRequestException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { AttachMethod, AttributeType, MemoryLayer, MemorySource, ProfileSource } from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CsvParserService } from './csv-parser.service';
import { ImportMappingService } from './import-mapping.service';
import { ImportJobService } from './import-job.service';
import {
  MappingConfig,
  MappedRecord,
  PreviewResult,
  BulkImportJobData,
  ImportStats,
  RowError,
} from './import.types';

export const BULK_IMPORT_QUEUE = 'bulk-import-v2';
export const BULK_IMPORT_JOB = 'bulk-import:process';

/**
 * ImportExecutionService
 *
 * Orchestrates the full import lifecycle:
 *   preview()     — dry-run, no DB writes
 *   execute()     — enqueues a BullMQ job
 *   processJob()  — the actual worker logic (called by processor)
 */
@Injectable()
export class ImportExecutionService {
  private readonly logger = new Logger(ImportExecutionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly csvParser: CsvParserService,
    private readonly mappingService: ImportMappingService,
    private readonly jobService: ImportJobService,
    @Optional() @InjectQueue(BULK_IMPORT_QUEUE) private readonly queue: Queue | null,
  ) {}

  // ── Preview ─────────────────────────────────────────────────────────────────

  /**
   * Dry-run import: parses + maps but performs NO database writes.
   * Returns a summary of what would be created.
   */
  async preview(
    file: Buffer,
    config: MappingConfig,
    userId: string,
  ): Promise<PreviewResult> {
    this.logger.debug(`[preview] Starting for user ${userId}`);

    const parsed = this.csvParser.parse(file);
    const headerErrors = this.csvParser.validateHeaders(parsed.headers, config);
    if (headerErrors.length > 0) {
      throw new BadRequestException(
        `CSV is missing required columns: ${headerErrors.join(', ')}`,
      );
    }

    const { records, errors } = this.mappingService.applyMapping(parsed.rows, config);

    const profiles = records.map((r) => ({
      rowNumber: r.rowNumber,
      name: r.profile.name,
      type: r.profile.type,
      description: r.profile.description,
      attributeCount: r.attributes.length,
      hasMemory: !!r.memory,
    }));

    const memories = records
      .filter((r) => !!r.memory)
      .map((r) => ({
        rowNumber: r.rowNumber,
        content: r.memory!.content,
        importance: r.memory!.importance,
      }));

    return {
      profiles,
      memories,
      errors,
      stats: {
        profileCount: profiles.length,
        memoryCount: memories.length,
        errorCount: errors.length,
      },
    };
  }

  // ── Execute ─────────────────────────────────────────────────────────────────

  /**
   * Kick off an async import job.
   * If BullMQ is unavailable (no Redis), falls back to synchronous processing.
   */
  async execute(
    file: Buffer,
    config: MappingConfig,
    userId: string,
  ): Promise<{ jobId: string }> {
    // Validate upfront before enqueuing
    const parsed = this.csvParser.parse(file);
    const headerErrors = this.csvParser.validateHeaders(parsed.headers, config);
    if (headerErrors.length > 0) {
      throw new BadRequestException(
        `CSV is missing required columns: ${headerErrors.join(', ')}`,
      );
    }

    const { jobId } = this.jobService.createJob(userId);

    const jobData: BulkImportJobData = {
      jobId,
      userId,
      fileBase64: file.toString('base64'),
      config,
    };

    if (this.queue) {
      await this.queue.add(BULK_IMPORT_JOB, jobData, {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 50, age: 3600 },
        removeOnFail: { count: 20 },
        jobId: `bulk-import-${jobId}`,
      });
      this.logger.log(`Import job enqueued: ${jobId}`);
    } else {
      // Fallback: run synchronously (dev / no-Redis mode)
      this.logger.warn('No Redis — running import synchronously');
      this.processJob(jobData).catch((err) => {
        this.logger.error(`Sync import failed for job ${jobId}:`, err);
        this.jobService.failJob(jobId, String(err));
      });
    }

    return { jobId };
  }

  // ── Process Job ─────────────────────────────────────────────────────────────

  /**
   * The core import worker. Called from BulkImportProcessor (or directly in no-Redis mode).
   *
   * For each valid row:
   *   1. Create EntityProfile
   *   2. Create EntityAttributes (bulk)
   *   3. Create Memory (if memoryMapping present)
   *   4. Link via EntityProfileMemory
   *
   * Bad rows are skipped; processing continues.
   */
  async processJob(jobData: BulkImportJobData): Promise<void> {
    const { jobId, userId, fileBase64, config } = jobData;
    this.logger.log(`[processJob] Starting job ${jobId}`);

    let file: Buffer;
    try {
      file = Buffer.from(fileBase64, 'base64');
    } catch {
      this.jobService.failJob(jobId, 'Failed to decode file buffer');
      return;
    }

    // Parse + map
    let records: MappedRecord[];
    let mappingErrors: RowError[];
    try {
      const parsed = this.csvParser.parse(file);
      const result = this.mappingService.applyMapping(parsed.rows, config);
      records = result.records;
      mappingErrors = result.errors;
    } catch (err) {
      this.jobService.failJob(jobId, `Parse/mapping failed: ${String(err)}`);
      return;
    }

    // Add mapping errors to job tracker
    for (const e of mappingErrors) {
      this.jobService.addError(jobId, e);
    }

    const stats: ImportStats = {
      profileCount: 0,
      memoryCount: 0,
      errorCount: mappingErrors.length,
    };

    const total = records.length;

    for (let i = 0; i < total; i++) {
      const record = records[i];
      try {
        await this.processRecord(record, userId, stats);
      } catch (err) {
        this.logger.warn(`[processJob] Row ${record.rowNumber} failed: ${err}`);
        this.jobService.addError(jobId, {
          rowNumber: record.rowNumber,
          message: `Failed to create record: ${String(err)}`,
        });
        stats.errorCount++;
      }

      // Update progress every 10 rows or at the end
      if (i % 10 === 0 || i === total - 1) {
        const progress = total > 0 ? (i + 1) / total : 1;
        this.jobService.updateProgress(jobId, progress, stats);
      }
    }

    this.jobService.completeJob(jobId, stats);
    this.logger.log(
      `[processJob] Job ${jobId} completed — profiles: ${stats.profileCount}, memories: ${stats.memoryCount}, errors: ${stats.errorCount}`,
    );
  }

  // ── Private Helpers ─────────────────────────────────────────────────────────

  private async processRecord(
    record: MappedRecord,
    userId: string,
    stats: ImportStats,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // 1. Create EntityProfile
      const profile = await tx.entityProfile.create({
        data: {
          userId,
          name: record.profile.name,
          type: record.profile.type,
          normalizedName: record.profile.name.toLowerCase().trim(),
          description: record.profile.description ?? null,
          aliases: [],
          tags: [],
          source: ProfileSource.IMPORT,
          verified: false,
        },
      });
      stats.profileCount++;

      // 2. Create EntityAttributes (bulk)
      if (record.attributes.length > 0) {
        await tx.entityAttribute.createMany({
          data: record.attributes.map((attr) => ({
            profileId: profile.id,
            key: attr.key,
            value: attr.value,
            valueType: attr.valueType ?? AttributeType.STRING,
            category: attr.category ?? null,
            source: 'IMPORT',
            confidence: 0.9,
            verified: false,
          })),
          skipDuplicates: true,
        });
      }

      // 3. Create Memory + link (if memoryMapping present)
      if (record.memory) {
        const contentHash = crypto
          .createHash('sha256')
          .update(record.memory.content)
          .digest('hex');

        const memory = await tx.memory.create({
          data: {
            userId,
            raw: record.memory.content,
            layer: MemoryLayer.INSIGHT,
            source: MemorySource.EXPLICIT_STATEMENT,
            importanceScore: record.memory.importance
              ? record.memory.importance / 5
              : 0.5,
            confidence: 0.9,
            contentHash,
          },
        });
        stats.memoryCount++;

        // 4. Link memory to profile
        await tx.entityProfileMemory.create({
          data: {
            profileId: profile.id,
            memoryId: memory.id,
            relevanceScore: 1.0,
            attachMethod: AttachMethod.IMPORT,
          },
        });
      }
    });
  }
}

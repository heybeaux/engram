import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CsvParserService } from '../import/csv-parser.service';
import { ImportMappingService } from '../import/import-mapping.service';
import { ImportJobService } from '../import/import-job.service';
import {
  MappingConfig,
  MappedRecord,
  ImportStats,
  RowError,
} from '../import/import.types';
import { AttachMethod, MemoryLayer, MemorySource, EmbeddingStatus } from '@prisma/client';

export interface ProcessingResult {
  stats: ImportStats;
  errors: RowError[];
}

/**
 * ImportProcessingService
 *
 * Handles the actual DB-writing side of bulk import v2:
 *  - Parse CSV → map rows → create EntityProfiles + EntityAttributes + Memories
 *  - Skips bad rows (missing name), continues on other per-row errors
 *  - Tracks progress via ImportJobService
 *  - Optionally triggers embedding for created memories
 */
@Injectable()
export class ImportProcessingService {
  private readonly logger = new Logger(ImportProcessingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly csvParser: CsvParserService,
    private readonly mappingService: ImportMappingService,
    private readonly jobService: ImportJobService,
  ) {}

  /**
   * Process a full import, writing records to DB.
   * Progress is streamed to the job tracker.
   */
  async processImport(
    jobId: string,
    userId: string,
    fileBuffer: Buffer,
    config: MappingConfig,
  ): Promise<ProcessingResult> {
    // 1. Parse
    const parsed = this.csvParser.parse(fileBuffer);

    // 2. Map all rows
    const { records, errors: mappingErrors } = this.mappingService.applyMapping(
      parsed.rows,
      config,
    );

    // Report mapping errors into the job
    for (const err of mappingErrors) {
      this.jobService.addError(jobId, err);
    }

    const total = records.length;
    const stats: ImportStats = { profileCount: 0, memoryCount: 0, errorCount: mappingErrors.length };

    if (total === 0) {
      this.jobService.completeJob(jobId, stats);
      return { stats, errors: mappingErrors };
    }

    const processingErrors: RowError[] = [];

    // 3. Process row-by-row
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      try {
        const result = await this.processRecord(userId, record);
        stats.profileCount += 1;
        if (result.memoryCreated) stats.memoryCount += 1;
      } catch (err) {
        const rowErr: RowError = {
          rowNumber: record.rowNumber,
          message: `Failed to process row: ${(err as Error).message}`,
        };
        processingErrors.push(rowErr);
        this.jobService.addError(jobId, rowErr);
        stats.errorCount += 1;
        this.logger.warn(`Row ${record.rowNumber} failed: ${(err as Error).message}`);
      }

      // Update progress every 10 rows (or at the last row)
      if (i % 10 === 0 || i === records.length - 1) {
        const progress = (i + 1) / total;
        this.jobService.updateProgress(jobId, progress, { ...stats });
      }
    }

    this.jobService.completeJob(jobId, stats);

    this.logger.log(
      `Import complete [${jobId}]: ${stats.profileCount} profiles, ${stats.memoryCount} memories, ${stats.errorCount} errors`,
    );

    return { stats, errors: [...mappingErrors, ...processingErrors] };
  }

  // ── Private Helpers ─────────────────────────────────────────────────────────

  private async processRecord(
    userId: string,
    record: MappedRecord,
  ): Promise<{ memoryCreated: boolean }> {
    let memoryCreated = false;

    await this.prisma.$transaction(async (tx) => {
      // Create entity profile
      const profile = await tx.entityProfile.create({
        data: {
          userId,
          name: record.profile.name,
          type: record.profile.type,
          normalizedName: record.profile.name.toLowerCase().trim(),
          description: record.profile.description ?? null,
          aliases: [],
          tags: [],
          source: 'IMPORT' as any,
          verified: false,
        },
      });

      // Create attributes
      if (record.attributes.length > 0) {
        await tx.entityAttribute.createMany({
          data: record.attributes.map((attr) => ({
            profileId: profile.id,
            key: attr.key,
            value: attr.value,
            valueType: attr.valueType,
            category: attr.category ?? null,
            source: 'IMPORT',
            confidence: 1.0,
            verified: false,
          })),
          skipDuplicates: true,
        });
      }

      // Create memory + link to profile
      if (record.memory) {
        const memory = await tx.memory.create({
          data: {
            userId,
            raw: record.memory.content,
            layer: MemoryLayer.IDENTITY,
            source: MemorySource.SYSTEM,
            embeddingStatus: EmbeddingStatus.PENDING,
            importanceScore: record.memory.importance
              ? record.memory.importance / 5
              : 0.5,
            effectiveScore: record.memory.importance
              ? record.memory.importance / 5
              : 0.5,
          },
        });

        // Link memory to profile
        await tx.entityProfileMemory.create({
          data: {
            profileId: profile.id,
            memoryId: memory.id,
            relevanceScore: 1.0,
            attachMethod: AttachMethod.IMPORT,
          },
        });

        memoryCreated = true;
      }
    });

    return { memoryCreated };
  }
}

import {
  Injectable,
  Logger,
} from '@nestjs/common';
import { CreateMemoryDto, CreateMemoryBatchDto } from './dto/create-memory.dto';
import {
  ExportedMemory,
  ImportMemoryItemDto,
  ImportResult,
} from './dto/export-import.dto';
import {
  BulkCreateMemoryDto,
  BulkCreateResult,
  BulkTextImportDto,
  BulkTextResult,
} from './dto/bulk.dto';
import { QueryMemoryDto, LoadContextDto } from './dto/query-memory.dto';
import { UpdateMemoryDto, CorrectMemoryDto } from './dto/update-memory.dto';

// Extracted services
import { MemoryQueryService } from './memory-query.service';
import { MemoryGraphService } from './memory-graph.service';
import { MemoryExportService } from './memory-export.service';
import { MemoryWriteService } from './memory-write.service';
import { MemoryLifecycleService } from './memory-lifecycle.service';

// Re-export types for backward compatibility
export type {
  MemoryWithExtraction,
  MemoryWithScore,
  QueryResult,
  ContextResult,
} from './memory.types';
import {
  MemoryWithExtraction,
  QueryResult,
  ContextResult,
} from './memory.types';

@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);
  constructor(
    private queryService: MemoryQueryService,
    private graphService: MemoryGraphService,
    private exportService: MemoryExportService,
    private writeService: MemoryWriteService,
    private lifecycleService: MemoryLifecycleService,
  ) {}

  /**
   * Create a single memory — delegates to MemoryWriteService
   */
  async remember(
    userId: string,
    dto: CreateMemoryDto,
  ): Promise<MemoryWithExtraction> {
    return this.writeService.remember(userId, dto);
  }

  /**
   * Create multiple memories in batch — delegates to MemoryWriteService
   */
  async rememberAll(
    userId: string,
    dto: CreateMemoryBatchDto,
  ): Promise<{ created: number; failed: number }> {
    return this.writeService.rememberAll(userId, dto);
  }

  /**
   * Bulk create memories — delegates to MemoryWriteService
   */
  async bulkCreate(
    userId: string,
    dto: BulkCreateMemoryDto,
  ): Promise<BulkCreateResult> {
    return this.writeService.bulkCreate(userId, dto);
  }

  /**
   * Bulk text import — delegates to MemoryWriteService
   */
  async bulkTextImport(
    userId: string,
    dto: BulkTextImportDto,
  ): Promise<BulkTextResult> {
    return this.writeService.bulkTextImport(userId, dto);
  }

  /**
   * Semantic search for memories — delegates to MemoryQueryService
   */
  async recall(
    userId: string | string[] | null,
    dto: QueryMemoryDto,
  ): Promise<QueryResult> {
    return this.queryService.recall(userId, dto);
  }

  /**
   * Load context for session start — delegates to MemoryQueryService
   */
  async loadContext(
    userId: string,
    dto: LoadContextDto,
  ): Promise<ContextResult> {
    return this.queryService.loadContext(userId, dto);
  }

  /**
   * Mark a memory as used — delegates to MemoryLifecycleService
   */
  async markUsed(memoryId: string, userId?: string): Promise<void> {
    return this.lifecycleService.markUsed(memoryId, userId);
  }

  /**
   * Get a single memory by ID — delegates to MemoryLifecycleService
   */
  async getById(
    memoryId: string,
    userId?: string,
    accountUserIds?: string[],
    accountId?: string,
  ): Promise<MemoryWithExtraction | null> {
    return this.lifecycleService.getById(
      memoryId,
      userId,
      accountUserIds,
      accountId,
    );
  }

  /**
   * Soft delete a memory — delegates to MemoryLifecycleService
   */
  async delete(
    memoryId: string,
    userId?: string,
    accountUserIds?: string[],
  ): Promise<void> {
    return this.lifecycleService.delete(memoryId, userId, accountUserIds);
  }

  /**
   * Update an existing memory — delegates to MemoryLifecycleService
   */
  async update(
    userId: string,
    memoryId: string,
    dto: UpdateMemoryDto,
  ): Promise<MemoryWithExtraction> {
    return this.lifecycleService.update(userId, memoryId, dto);
  }

  /**
   * Correct a memory with contradiction tracking — delegates to MemoryLifecycleService
   */
  async correctMemory(
    userId: string,
    memoryId: string,
    dto: CorrectMemoryDto,
  ): Promise<MemoryWithExtraction> {
    return this.lifecycleService.correctMemory(userId, memoryId, dto);
  }

  /**
   * Export memories with filters — delegates to MemoryLifecycleService
   */
  async exportMemoriesFiltered(
    userId: string,
    filters: {
      layer?: string;
      projectId?: string;
      startDate?: string;
      endDate?: string;
    },
    take: number,
    cursor?: string,
  ): Promise<ExportedMemory[]> {
    return this.lifecycleService.exportMemoriesFiltered(
      userId,
      filters,
      take,
      cursor,
    );
  }

  /**
   * Get graph data for visualization — delegates to MemoryGraphService
   */
  async getGraphData(
    userId: string,
    limit: number = 500,
    includeAgent: boolean = false,
  ) {
    return this.graphService.getGraphData(userId, limit, includeAgent);
  }

  // =========================================================================
  // EXPORT / IMPORT — delegated to MemoryExportService (HEY-221)
  // =========================================================================

  async exportMemories(userId: string): Promise<ExportedMemory[]> {
    return this.exportService.exportMemories(userId);
  }

  async exportMemoriesBatch(
    userId: string,
    take: number,
    cursor?: string,
  ): Promise<ExportedMemory[]> {
    return this.exportService.exportMemoriesBatch(userId, take, cursor);
  }

  async importMemories(
    userId: string,
    items: ImportMemoryItemDto[],
  ): Promise<ImportResult> {
    return this.exportService.importMemories(userId, items);
  }
}

import { Injectable, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
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
import { MemoryQueryService } from './memory-query.service';
import { MemoryGraphService } from './memory-graph.service';
import { MemoryExportService } from './memory-export.service';
import { MemoryWriteService } from './memory-write.service';
import { MemoryBulkService } from './memory-bulk.service';
import { MemoryUpdateService } from './memory-update.service';
import { MemoryCrudService } from './memory-crud.service';

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
  constructor(
    private queryService: MemoryQueryService,
    private graphService: MemoryGraphService,
    private exportService: MemoryExportService,
    private writeService: MemoryWriteService,
    private bulkService: MemoryBulkService,
    private updateService: MemoryUpdateService,
    private crudService: MemoryCrudService,
    // EventEmitter2 kept for @Optional injection but not used directly —
    // sub-services each inject it independently
    @Optional() private eventEmitter?: EventEmitter2,
  ) {}

  // Write

  async remember(userId: string, dto: CreateMemoryDto): Promise<MemoryWithExtraction> {
    return this.writeService.remember(userId, dto);
  }

  async rememberAll(userId: string, dto: CreateMemoryBatchDto): Promise<{ created: number; failed: number }> {
    return this.writeService.rememberAll(userId, dto);
  }

  // Bulk

  async bulkCreate(userId: string, dto: BulkCreateMemoryDto): Promise<BulkCreateResult> {
    return this.bulkService.bulkCreate(userId, dto);
  }

  async bulkTextImport(userId: string, dto: BulkTextImportDto): Promise<BulkTextResult> {
    return this.bulkService.bulkTextImport(userId, dto);
  }

  // Update

  async update(userId: string, memoryId: string, dto: UpdateMemoryDto): Promise<MemoryWithExtraction> {
    return this.updateService.update(userId, memoryId, dto);
  }

  async correctMemory(userId: string, memoryId: string, dto: CorrectMemoryDto): Promise<MemoryWithExtraction> {
    return this.updateService.correctMemory(userId, memoryId, dto);
  }

  // CRUD

  async markUsed(memoryId: string, userId?: string): Promise<void> {
    return this.crudService.markUsed(memoryId, userId);
  }

  async getById(memoryId: string, userId?: string, accountUserIds?: string[], accountId?: string): Promise<MemoryWithExtraction | null> {
    return this.crudService.getById(memoryId, userId, accountUserIds, accountId);
  }

  async delete(memoryId: string, userId?: string, accountUserIds?: string[]): Promise<void> {
    return this.crudService.delete(memoryId, userId, accountUserIds);
  }

  // Search / Context

  async recall(userId: string | string[], dto: QueryMemoryDto): Promise<QueryResult> {
    return this.queryService.recall(userId, dto);
  }

  async loadContext(userId: string, dto: LoadContextDto): Promise<ContextResult> {
    return this.queryService.loadContext(userId, dto);
  }

  // Graph

  async getGraphData(userId: string, limit: number = 500, includeAgent: boolean = false) {
    return this.graphService.getGraphData(userId, limit, includeAgent);
  }

  // Export / Import

  async exportMemories(userId: string): Promise<ExportedMemory[]> {
    return this.exportService.exportMemories(userId);
  }

  async exportMemoriesBatch(userId: string, take: number, cursor?: string): Promise<ExportedMemory[]> {
    return this.exportService.exportMemoriesBatch(userId, take, cursor);
  }

  async exportMemoriesFiltered(
    userId: string,
    filters: { layer?: string; projectId?: string; startDate?: string; endDate?: string },
    take: number,
    cursor?: string,
  ): Promise<ExportedMemory[]> {
    return this.exportService.exportMemoriesFiltered(userId, filters, take, cursor);
  }

  async importMemories(userId: string, items: ImportMemoryItemDto[]): Promise<ImportResult> {
    return this.exportService.importMemories(userId, items);
  }
}

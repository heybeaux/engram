/**
 * Prisma/PostgreSQL Storage Provider
 *
 * Default storage provider wrapping existing Prisma/PostgreSQL usage.
 * Uses pgvector for vector similarity search via raw SQL.
 *
 * This is a near-transparent extraction of current behavior —
 * consuming modules will be wired through StorageService in a follow-up PR.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingWriteService } from '../vector/embedding-write.service';
import {
  StorageProvider,
  CreateMemoryData,
  UpdateMemoryData,
  IncrementMemoryData,
  MemoryFilters,
  PaginationOptions,
  MemoryInclude,
  StoredMemory,
  VectorSearchResult,
  VectorSearchOptions,
  BulkUpdateEntry,
  StorageStats,
  CreateMergeCandidateData,
  HealthCheckResult,
} from './storage-provider.interface';

@Injectable()
export class PrismaPostgresProvider implements StorageProvider {
  readonly name = 'prisma-postgres';
  private readonly logger = new Logger(PrismaPostgresProvider.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddingWrite: EmbeddingWriteService,
  ) {}

  // ── Memory CRUD ──────────────────────────────────────────────────────

  async createMemory(data: CreateMemoryData): Promise<StoredMemory> {
    const { embedding, ...prismaData } = data;
    const memory = await this.prisma.memory.create({
      data: prismaData as any,
    });

    if (embedding) {
      await this.embeddingWrite.writeLegacyInlineEmbedding(memory.id, embedding);
    }

    return memory as StoredMemory;
  }

  async getMemory(
    id: string,
    include?: MemoryInclude,
  ): Promise<StoredMemory | null> {
    const result = await this.prisma.memory.findUnique({
      where: { id },
      include: this.buildInclude(include),
    });
    return result as StoredMemory | null;
  }

  async updateMemory(
    id: string,
    data: UpdateMemoryData,
  ): Promise<StoredMemory> {
    const { embedding, ...prismaData } = data;
    const result = await this.prisma.memory.update({
      where: { id },
      data: prismaData as any,
    });

    if (embedding) {
      await this.embeddingWrite.writeLegacyInlineEmbedding(id, embedding);
    }

    return result as StoredMemory;
  }

  async incrementMemory(
    id: string,
    increments: IncrementMemoryData,
    data?: UpdateMemoryData,
  ): Promise<StoredMemory> {
    const updateData: any = { ...data };
    if (increments.usedCount) {
      updateData.usedCount = { increment: increments.usedCount };
    }
    if (increments.retrievalCount) {
      updateData.retrievalCount = { increment: increments.retrievalCount };
    }
    const result = await this.prisma.memory.update({
      where: { id },
      data: updateData,
    });
    return result as StoredMemory;
  }

  async deleteMemory(id: string): Promise<void> {
    await this.prisma.memory.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  // ── Queries ──────────────────────────────────────────────────────────

  async findMemories(
    filters: MemoryFilters,
    pagination?: PaginationOptions,
    include?: MemoryInclude,
  ): Promise<StoredMemory[]> {
    const where = this.buildWhere(filters);
    const orderBy = this.buildOrderBy(pagination);

    const results = await this.prisma.memory.findMany({
      where,
      include: this.buildInclude(include),
      orderBy,
      take: pagination?.limit,
      skip: pagination?.offset,
    });

    return results as StoredMemory[];
  }

  async countMemories(filters: MemoryFilters): Promise<number> {
    const where = this.buildWhere(filters);
    return this.prisma.memory.count({ where });
  }

  async updateManyMemories(
    filters: MemoryFilters,
    data: UpdateMemoryData,
  ): Promise<number> {
    const where = this.buildWhere(filters);
    const { embedding, ...prismaData } = data;
    const result = await this.prisma.memory.updateMany({
      where,
      data: prismaData as any,
    });
    return result.count;
  }

  async incrementManyMemories(
    filters: MemoryFilters,
    increments: IncrementMemoryData,
    data?: UpdateMemoryData,
  ): Promise<number> {
    const where = this.buildWhere(filters);
    const updateData: any = { ...data };
    if (increments.usedCount) {
      updateData.usedCount = { increment: increments.usedCount };
    }
    if (increments.retrievalCount) {
      updateData.retrievalCount = { increment: increments.retrievalCount };
    }
    const result = await this.prisma.memory.updateMany({
      where,
      data: updateData,
    });
    return result.count;
  }

  // ── Vector Search ────────────────────────────────────────────────────

  async vectorSearch(
    embedding: number[],
    options: VectorSearchOptions,
  ): Promise<VectorSearchResult[]> {
    const vectorStr = `[${embedding.join(',')}]`;
    const { limit, threshold, filters } = options;

    // Build WHERE clause parts
    const conditions: string[] = [
      'm.embedding IS NOT NULL',
      'm.deleted_at IS NULL',
    ];
    const params: any[] = [vectorStr];
    let paramIdx = 2;

    if (filters?.userId) {
      conditions.push(`m.user_id = $${paramIdx}`);
      params.push(filters.userId);
      paramIdx++;
    }

    if (filters?.layers && filters.layers.length > 0) {
      conditions.push(`m.layer = ANY($${paramIdx})`);
      params.push(filters.layers.map((l) => l.toString()));
      paramIdx++;
    }

    if (threshold !== undefined) {
      conditions.push(`1 - (m.embedding <=> $1::vector) >= $${paramIdx}`);
      params.push(threshold);
      paramIdx++;
    }

    const whereClause = conditions.join(' AND ');

    const results = await this.prisma.$queryRawUnsafe<
      Array<{ id: string; score: number }>
    >(
      `SELECT m.id, 1 - (m.embedding <=> $1::vector) as score
       FROM memories m
       WHERE ${whereClause}
       ORDER BY m.embedding <=> $1::vector
       LIMIT $${paramIdx}`,
      ...params,
      limit,
    );

    return results.map((r) => ({
      id: r.id,
      score: Number(r.score),
    }));
  }

  async getMemoryEmbedding(memoryId: string): Promise<number[] | null> {
    const raw = await this.prisma.$queryRawUnsafe<Array<{ embedding: string }>>(
      `SELECT embedding::text FROM memories WHERE id = $1 AND embedding IS NOT NULL`,
      memoryId,
    );
    if (!raw.length || !raw[0].embedding) return null;
    return JSON.parse(raw[0].embedding);
  }

  // ── Bulk Operations ──────────────────────────────────────────────────

  async bulkCreate(data: CreateMemoryData[]): Promise<StoredMemory[]> {
    // Use transaction for atomicity
    const results: StoredMemory[] = [];
    await this.prisma.$transaction(async (tx) => {
      for (const item of data) {
        const { embedding, ...prismaData } = item;
        const memory = await tx.memory.create({
          data: prismaData as any,
        });
        if (embedding) {
          await this.embeddingWrite.writeLegacyInlineEmbedding(memory.id, embedding);
        }
        results.push(memory as StoredMemory);
      }
    });
    return results;
  }

  async bulkUpdate(updates: BulkUpdateEntry[]): Promise<number> {
    let count = 0;
    await this.prisma.$transaction(async (tx) => {
      for (const { id, data } of updates) {
        const { embedding, ...prismaData } = data;
        await tx.memory.update({
          where: { id },
          data: prismaData as any,
        });
        if (embedding) {
          await this.embeddingWrite.writeLegacyInlineEmbedding(id, embedding);
        }
        count++;
      }
    });
    return count;
  }

  // ── Stats / Aggregations ─────────────────────────────────────────────

  async getStats(userId?: string): Promise<StorageStats> {
    const baseWhere = userId ? { userId } : {};

    const [total, active, deleted, consolidated] = await Promise.all([
      this.prisma.memory.count({ where: baseWhere }),
      this.prisma.memory.count({ where: { ...baseWhere, deletedAt: null } }),
      this.prisma.memory.count({
        where: { ...baseWhere, deletedAt: { not: null } },
      }),
      this.prisma.memory.count({ where: { ...baseWhere, consolidated: true } }),
    ]);

    // Layer distribution
    const layerGroups = await this.prisma.memory.groupBy({
      by: ['layer'],
      where: { ...baseWhere, deletedAt: null },
      _count: { _all: true },
    });

    const layerDistribution: Record<string, number> = {};
    for (const group of layerGroups) {
      layerDistribution[group.layer] = group._count._all;
    }

    // Memory type distribution
    const typeGroups = await this.prisma.memory.groupBy({
      by: ['memoryType'],
      where: { ...baseWhere, deletedAt: null, memoryType: { not: null } },
      _count: { _all: true },
    });

    const memoryTypeDistribution: Record<string, number> = {};
    for (const group of typeGroups) {
      if (group.memoryType) {
        memoryTypeDistribution[group.memoryType] = group._count._all;
      }
    }

    return {
      totalMemories: total,
      activeMemories: active,
      deletedMemories: deleted,
      consolidatedMemories: consolidated,
      layerDistribution,
      memoryTypeDistribution,
    };
  }

  async groupBy(
    field: string,
    filters?: MemoryFilters,
  ): Promise<Array<{ value: string; count: number }>> {
    const where = filters ? this.buildWhere(filters) : {};
    const results = await this.prisma.memory.groupBy({
      by: [field as any],
      where,
      _count: { _all: true },
    });

    return results.map((r: any) => ({
      value: String(r[field] ?? 'null'),
      count: r._count._all,
    }));
  }

  async aggregate(
    field: string,
    operation: 'avg' | 'sum' | 'min' | 'max',
    filters?: MemoryFilters,
  ): Promise<number | null> {
    const where = filters ? this.buildWhere(filters) : {};
    const result = await this.prisma.memory.aggregate({
      where,
      [`_${operation}`]: { [field]: true },
    } as any);

    const opResult = (result as any)[`_${operation}`];
    return opResult?.[field] ?? null;
  }

  // ── Merge / Dedup Support ────────────────────────────────────────────

  async createMergeCandidate(data: CreateMergeCandidateData): Promise<any> {
    return this.prisma.mergeCandidate.create({
      data: data as any,
    });
  }

  // ── Health ───────────────────────────────────────────────────────────

  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return {
        healthy: true,
        latencyMs: Date.now() - start,
        provider: this.name,
      };
    } catch (error: any) {
      return {
        healthy: false,
        latencyMs: Date.now() - start,
        provider: this.name,
        details: { error: error.message },
      };
    }
  }

  // ── Private Helpers ──────────────────────────────────────────────────

  private buildWhere(filters: MemoryFilters): any {
    const where: any = {};

    if (filters.userId) where.userId = filters.userId;
    if (filters.userIds) where.userId = { in: filters.userIds };
    if (filters.layer) where.layer = filters.layer;
    if (filters.layers) where.layer = { in: filters.layers };
    if (filters.source) where.source = filters.source;
    if (filters.subjectType) where.subjectType = filters.subjectType;
    if (filters.projectId) where.projectId = filters.projectId;
    if (filters.sessionId) where.sessionId = filters.sessionId;
    if (filters.agentId) where.agentId = filters.agentId;
    if (filters.memoryType) where.memoryType = filters.memoryType;
    if (filters.memoryTypes) where.memoryType = { in: filters.memoryTypes };
    if (filters.consolidated !== undefined)
      where.consolidated = filters.consolidated;
    if (filters.ids) where.id = { in: filters.ids };
    if (filters.excludeIds) {
      where.id = { ...where.id, notIn: filters.excludeIds };
    }

    // Explicit null checks
    if (filters.deletedAt === null) where.deletedAt = null;
    if (filters.deletedAt instanceof Date) where.deletedAt = filters.deletedAt;
    if ('deletedAt' in filters && filters.deletedAt === null)
      where.deletedAt = null;
    if (filters.supersededById === null) where.supersededById = null;
    if (filters.consolidatedInto === null) where.consolidatedInto = null;

    // Date ranges
    if (filters.createdAtGte || filters.createdAtLte) {
      where.createdAt = {};
      if (filters.createdAtGte) where.createdAt.gte = filters.createdAtGte;
      if (filters.createdAtLte) where.createdAt.lte = filters.createdAtLte;
    }

    // Embedding filter (has embedding)
    if (filters.hasEmbedding === true) {
      where.embedding = { not: null };
    } else if (filters.hasEmbedding === false) {
      where.embedding = null;
    }

    return where;
  }

  private buildOrderBy(pagination?: PaginationOptions): any {
    if (!pagination?.orderBy) return { createdAt: 'desc' };
    return { [pagination.orderBy]: pagination.orderDirection ?? 'desc' };
  }

  private buildInclude(include?: MemoryInclude): any {
    if (!include) return undefined;
    const result: any = {};
    if (include.extraction) result.extraction = true;
    if (include.entities) result.entities = { include: { entity: true } };
    if (include.chainLinks) result.chainLinks = true;
    return Object.keys(result).length > 0 ? result : undefined;
  }
}

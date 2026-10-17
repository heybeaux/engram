import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { GraphEntity, GraphEntityType, Memory } from '@prisma/client';
import { EntityService } from './entity.service';
import { RelationshipService } from './relationship.service';
import { GraphExtractionService } from './graph-extraction.service';
import { EntityWithRelationships } from '../dto/entity.dto';
import {
  GraphTraversalResult,
  TraverseGraphDto,
} from '../dto/relationship.dto';
import { MemoryProcessingResult } from '../dto/extraction.dto';

/**
 * GraphService - High-level graph operations
 *
 * Provides a unified interface for graph queries, entity profiles,
 * path finding, and integration with memory retrieval.
 */
@Injectable()
export class GraphService {
  private readonly logger = new Logger(GraphService.name);
  private readonly enabled: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly entityService: EntityService,
    private readonly relationshipService: RelationshipService,
    private readonly extractionService: GraphExtractionService,
  ) {
    this.enabled = this.config.get<string>('GRAPH_ENABLED') === 'true';
  }

  /**
   * Check if graph features are enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Process a memory for graph extraction (async, non-blocking)
   */
  async processMemory(memory: Memory): Promise<MemoryProcessingResult> {
    return this.extractionService.processMemory(memory);
  }

  /**
   * Get entity profile with relationships and recent memories
   */
  async getEntityProfile(
    userId: string,
    entityNameOrId: string,
  ): Promise<{
    entity: EntityWithRelationships;
    recentMemories: Memory[];
  } | null> {
    // Try to find by ID first, then by name
    let entity = await this.entityService.findById(entityNameOrId);
    if (!entity) {
      entity = await this.entityService.findByNameOrAlias(
        userId,
        entityNameOrId,
      );
    }
    if (!entity) {
      return null;
    }

    const entityWithRels = await this.entityService.getWithRelationships(
      entity.id,
    );

    // Get recent memories mentioning this entity
    const mentions = await this.prisma.graphEntityMention.findMany({
      where: {
        entityId: entity.id,
        memory: { userHidden: false, deletedAt: null },
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: {
        memory: true,
      },
    });

    return {
      entity: entityWithRels,
      recentMemories: mentions.map((m) => m.memory),
    };
  }

  /**
   * Find path between two entities
   */
  async findPath(
    userId: string,
    fromEntity: string,
    toEntity: string,
  ): Promise<{
    found: boolean;
    path: Array<{
      entity: GraphEntity;
      relationship: { id: string; type: string } | null;
    }>;
  }> {
    // Resolve entity names to IDs
    const from = await this.entityService.findByNameOrAlias(userId, fromEntity);
    const to = await this.entityService.findByNameOrAlias(userId, toEntity);

    if (!from || !to) {
      return { found: false, path: [] };
    }

    const pathResult = await this.relationshipService.findPath(
      userId,
      from.id,
      to.id,
    );

    if (pathResult.length === 0) {
      return { found: false, path: [] };
    }

    // Resolve path to entities
    const path = await Promise.all(
      pathResult.map(async (p) => {
        const entity = await this.entityService.findById(p.entityId);
        let relationship: { id: string; type: string } | null = null;
        if (p.relationshipId) {
          const rel = await this.relationshipService.findById(p.relationshipId);
          if (rel) {
            relationship = { id: rel.id, type: rel.type };
          }
        }
        return { entity: entity!, relationship };
      }),
    );

    return { found: true, path };
  }

  /**
   * Find entities by relationship to another entity
   */
  async findByRelationship(
    userId: string,
    relationshipType: string,
    targetEntityName: string,
  ): Promise<GraphEntity[]> {
    const target = await this.entityService.findByNameOrAlias(
      userId,
      targetEntityName,
    );
    if (!target) {
      return [];
    }

    // Find entities with outgoing relationship to target
    const relationships = await this.prisma.graphRelationship.findMany({
      where: {
        userId,
        targetEntityId: target.id,
        type: relationshipType as any,
      },
      include: {
        sourceEntity: true,
      },
    });

    return relationships.map((r) => r.sourceEntity);
  }

  /**
   * Traverse graph from an entity
   */
  async traverse(dto: TraverseGraphDto): Promise<GraphTraversalResult> {
    return this.relationshipService.traverse(dto);
  }

  /**
   * Get graph statistics for a user
   */
  async getStats(userId: string): Promise<{
    enabled: boolean;
    totalEntities: number;
    byType: Record<string, number>;
    totalRelationships: number;
    totalMentions: number;
    topEntities: Array<{ name: string; type: string; mentionCount: number }>;
  }> {
    const stats = await this.entityService.getStats(userId);
    const topEntities = await this.entityService.getTopEntities(userId, 5);

    return {
      enabled: this.enabled,
      ...stats,
      topEntities: topEntities.map((e) => ({
        name: e.name,
        type: e.type,
        mentionCount: e.mentionCount,
      })),
    };
  }

  /**
   * Get all memories mentioning an entity
   */
  async getMemoriesForEntity(
    entityId: string,
    limit: number = 20,
  ): Promise<Memory[]> {
    const mentions = await this.prisma.graphEntityMention.findMany({
      where: { entityId, memory: { userHidden: false, deletedAt: null } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        memory: true,
      },
    });

    return mentions.map((m) => m.memory);
  }

  /**
   * Search entities semantically
   * Combines exact match + alias match + description search
   */
  async searchEntities(
    userId: string,
    query: string,
    options?: {
      type?: GraphEntityType;
      limit?: number;
    },
  ): Promise<
    Array<GraphEntity & { matchType: 'exact' | 'alias' | 'description' }>
  > {
    const limit = options?.limit || 10;
    const results: Array<
      GraphEntity & { matchType: 'exact' | 'alias' | 'description' }
    > = [];
    const seen = new Set<string>();

    // 1. Exact name match
    const exactMatch = await this.entityService.findByName(
      userId,
      query,
      options?.type,
    );
    if (exactMatch) {
      results.push({ ...exactMatch, matchType: 'exact' });
      seen.add(exactMatch.id);
    }

    // 2. Alias match
    const aliasMatch = await this.entityService.findByAlias(
      userId,
      query,
      options?.type,
    );
    if (aliasMatch && !seen.has(aliasMatch.id)) {
      results.push({ ...aliasMatch, matchType: 'alias' });
      seen.add(aliasMatch.id);
    }

    // 3. Description/name contains search
    const { entities } = await this.entityService.list({
      userId,
      type: options?.type,
      search: query,
      limit: limit - results.length,
    });

    for (const entity of entities) {
      if (!seen.has(entity.id)) {
        results.push({ ...entity, matchType: 'description' });
        seen.add(entity.id);
        if (results.length >= limit) break;
      }
    }

    return results;
  }

  /**
   * Get related entities (entities connected through relationships)
   */
  async getRelatedEntities(
    entityId: string,
    depth: number = 1,
  ): Promise<GraphEntity[]> {
    const entity = await this.entityService.findById(entityId);
    if (!entity) return [];

    const result = await this.relationshipService.traverse({
      userId: entity.userId,
      startEntityId: entityId,
      maxDepth: depth,
    });

    const relatedIds = result.nodes
      .filter((n) => n.id !== entityId)
      .map((n) => n.id);

    return this.prisma.graphEntity.findMany({
      where: { id: { in: relatedIds } },
    });
  }

  /**
   * Backfill graph data for all memories of a user
   * Processes memories that don't have graph data yet
   */
  async backfill(
    userId: string,
    options?: { limit?: number; priority?: 'high' | 'normal' | 'low' },
  ): Promise<{
    processed: number;
    skipped: number;
    failed: number;
    total: number;
    durationMs: number;
  }> {
    const startTime = Date.now();
    this.logger.log(`Starting graph backfill for user ${userId}`);

    // Find memories without graph mentions
    const memories = await this.prisma.memory.findMany({
      where: {
        userId,
        graphMentions: { none: {} },
        deletedAt: null,
      },
      orderBy: { createdAt: 'desc' },
      take: options?.limit || 50,
    });

    const CONCURRENCY = parseInt(
      this.config.get('GRAPH_BACKFILL_CONCURRENCY') || '5',
      10,
    );
    let processed = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < memories.length; i += CONCURRENCY) {
      const batch = memories.slice(i, i + CONCURRENCY);
      const backfillTimeout = parseInt(
        this.config.get('GRAPH_BACKFILL_TIMEOUT_MS') || '120000',
        10,
      );
      const results = await Promise.allSettled(
        batch.map(async (memory) => {
          const timeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), backfillTimeout),
          );
          return Promise.race([this.processMemory(memory), timeout]);
        }),
      );

      for (const r of results) {
        if (r.status === 'fulfilled') {
          const res = r.value as {
            entitiesCreated: number;
            entitiesUpdated: number;
          };
          if (res.entitiesCreated > 0 || res.entitiesUpdated > 0) processed++;
          else skipped++;
        } else {
          failed++;
          this.logger.warn(
            `Failed to process memory in batch: ${r.reason?.message || r.reason}`,
          );
        }
      }

      const done = i + batch.length;
      if (done % 10 < CONCURRENCY || done >= memories.length) {
        this.logger.log(
          `Backfill progress: ${done}/${memories.length} (${processed} processed, ${skipped} skipped, ${failed} failed)`,
        );
      }
    }

    const durationMs = Date.now() - startTime;
    this.logger.log(
      `Backfill complete: ${processed} processed, ${skipped} skipped, ${failed} failed in ${durationMs}ms`,
    );
    return { processed, skipped, failed, total: memories.length, durationMs };
  }
}

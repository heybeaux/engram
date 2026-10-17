import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EntityService } from '../../graph/services/entity.service';
import { RelationshipService } from '../../graph/services/relationship.service';
import { MemoryWithScore } from '../../memory/memory.types';
import {
  AnticipatoryStrategy,
  ContextSignals,
  AnticipatoryResult,
} from './strategy.interface';

/**
 * Entity Radiation Strategy
 *
 * When a recall query mentions a known entity, traverse 1-hop in the
 * knowledge graph and pull memories from adjacent entities. This surfaces
 * related context the agent didn't explicitly ask for.
 *
 * Example: Query mentions "Engram" → graph shows Railway, Prisma, pgvector
 * are 1-hop away → pull top memories about those adjacent entities.
 */
@Injectable()
export class EntityRadiationStrategy implements AnticipatoryStrategy {
  readonly name = 'entity_radiation';
  private readonly logger = new Logger(EntityRadiationStrategy.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entityService: EntityService,
    private readonly relationshipService: RelationshipService,
  ) {}

  async execute(
    signals: ContextSignals,
    options: { maxResults: number; timeoutMs: number },
  ): Promise<AnticipatoryResult[]> {
    const deadline = Date.now() + options.timeoutMs;

    if (signals.entities.length === 0) {
      return [];
    }

    const results: AnticipatoryResult[] = [];
    const seenEntityIds = new Set<string>();

    for (const entityName of signals.entities) {
      if (Date.now() > deadline) break;
      if (results.length >= options.maxResults) break;

      try {
        // Find the entity in the graph
        const entity = await this.entityService.findByNameOrAlias(
          signals.userId,
          entityName,
        );
        if (!entity) continue;

        // Traverse 1-hop relationships
        const traversal = await this.relationshipService.traverse({
          userId: signals.userId,
          startEntityId: entity.id,
          maxDepth: 1,
        });

        // Get adjacent entity IDs (exclude the start entity)
        const adjacentEntities = traversal.nodes
          .filter((n) => n.id !== entity.id)
          .sort((a, b) => {
            // Sort by relationship weight (from edges)
            const aEdge = traversal.edges.find(
              (e) => e.targetId === a.id || e.sourceId === a.id,
            );
            const bEdge = traversal.edges.find(
              (e) => e.targetId === b.id || e.sourceId === b.id,
            );
            return (bEdge?.weight ?? 0) - (aEdge?.weight ?? 0);
          });

        for (const adjEntity of adjacentEntities) {
          if (Date.now() > deadline) break;
          if (results.length >= options.maxResults) break;
          if (seenEntityIds.has(adjEntity.id)) continue; // Diversity: 1 per entity
          seenEntityIds.add(adjEntity.id);

          // Find memories mentioning this adjacent entity
          const memories = await this.prisma.memory.findMany({
            where: {
              userId: signals.userId,
              deletedAt: null,
              userHidden: false,
              supersededById: null,
              id: { notIn: [...signals.excludeMemoryIds] },
              graphMentions: {
                some: {
                  entityId: adjEntity.id,
                },
              },
            },
            include: { extraction: true },
            orderBy: [{ effectiveScore: 'desc' }, { createdAt: 'desc' }],
            take: 1,
          });

          if (memories.length === 0) continue;

          const memory = memories[0];

          // Compute salience: weight from edge × effectiveScore × recency decay
          const edge = traversal.edges.find(
            (e) => e.targetId === adjEntity.id || e.sourceId === adjEntity.id,
          );
          const edgeWeight = edge?.weight ?? 0.5;
          const recencyDays =
            (Date.now() - memory.createdAt.getTime()) / (1000 * 60 * 60 * 24);
          const recencyDecay = Math.max(0.1, 1 - recencyDays / 90); // Decay over 90 days
          const salience = edgeWeight * memory.effectiveScore * recencyDecay;

          results.push({
            memory: { ...memory, score: salience } as MemoryWithScore,
            meta: {
              strategy: this.name,
              reason: `Related to ${entityName} via entity: ${adjEntity.name}`,
              salience,
              entityPath: [entityName, adjEntity.name],
            },
          });
        }
      } catch (err) {
        this.logger.warn(
          `Entity radiation failed for "${entityName}": ${(err as Error).message}`,
        );
      }
    }

    // Sort by salience descending
    return results
      .sort((a, b) => b.meta.salience - a.meta.salience)
      .slice(0, options.maxResults);
  }
}

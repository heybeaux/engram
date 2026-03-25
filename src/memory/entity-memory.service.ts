import { Injectable, Logger } from '@nestjs/common';
import { ServicePrismaService } from '../prisma/service-prisma.service';
import { MemoryLayer, MemorySource, EmbeddingStatus } from '@prisma/client';

@Injectable()
export class EntityMemoryService {
  private readonly logger = new Logger(EntityMemoryService.name);

  constructor(private readonly prisma: ServicePrismaService) {}

  /**
   * Ensure an IDENTITY-layer memory exists for a person or organization entity.
   * Idempotent: calling multiple times for the same entity produces exactly one memory.
   */
  async ensureEntityMemory(entity: {
    name: string;
    type: string;
    userId: string;
  }): Promise<void> {
    const entityType = entity.type.toLowerCase();
    if (entityType !== 'person' && entityType !== 'organization') {
      return;
    }

    const normalizedName = entity.name.toLowerCase().trim().replace(/\s+/g, '-');
    const tag = `entity:${normalizedName}`;

    // Check for existing IDENTITY memory with this entity tag
    const existing = await this.prisma.memory.findFirst({
      where: {
        userId: entity.userId,
        layer: MemoryLayer.IDENTITY,
        tags: { has: tag },
        deletedAt: null,
      },
      select: { id: true },
    });

    if (existing) {
      // Touch lastRetrievedAt to keep it fresh
      await this.prisma.memory.update({
        where: { id: existing.id },
        data: { lastRetrievedAt: new Date() },
      });
      this.logger.debug(
        `Entity memory already exists for ${entity.name} (${existing.id}), refreshed`,
      );
      return;
    }

    // Create new IDENTITY memory directly via Prisma to avoid circular dependency
    // (MemoryWriteService -> MemoryPipelineService -> EntityMemoryService).
    // EmbeddingRetryCron (runs every 5 minutes) discovers PENDING memories and
    // enqueues them for embedding — expect up to a 5-minute delay before this
    // memory becomes vector-searchable.
    await this.prisma.memory.create({
      data: {
        userId: entity.userId,
        raw: `${entity.name} is ${entityType.match(/^[aeiou]/i) ? 'an' : 'a'} ${entityType} known to ${entity.userId}.`,
        layer: MemoryLayer.IDENTITY,
        source: MemorySource.AGENT_OBSERVATION,
        tags: [tag, `entity-type:${entityType}`, 'auto:entity-extraction'],
        searchable: true,
        embeddingStatus: EmbeddingStatus.PENDING,
        importanceScore: 0.6,
      },
    });

    this.logger.log(
      `Created IDENTITY memory for ${entityType} entity: ${entity.name}`,
    );
  }
}

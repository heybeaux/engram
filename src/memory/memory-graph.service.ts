import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class MemoryGraphService {
  constructor(private prisma: PrismaService) {}

  /**
   * Get graph data for visualization.
   *
   * Builds edges from:
   * 1. Shared entities — two memories that mention the same entity get linked
   * 2. Entity relationships — directed edges between entities from GraphRelationship
   * 3. Memory chain links — explicit sequential links between memories
   */
  async getGraphData(
    userId: string,
    limit: number = 500,
    includeAgent: boolean = false,
  ): Promise<{
    nodes: any[];
    edges: any[];
    entities: any[];
    stats?: { human: number; agent: number };
  }> {
    const userIds = [userId];
    let agentUserId: string | null = null;

    if (includeAgent) {
      const currentUser = await this.prisma.user.findUnique({
        where: { id: userId },
      });
      if (currentUser?.accountId) {
        const agentUser = await this.prisma.user.findFirst({
          where: {
            accountId: currentUser.accountId,
            externalId: 'rook',
            deletedAt: null,
          },
        });
        if (agentUser) {
          userIds.push(agentUser.id);
          agentUserId = agentUser.id;
        }
      }
    }

    const memories = await this.prisma.memory.findMany({
      where: {
        userId: { in: userIds },
        deletedAt: null,
      },
      select: {
        id: true,
        userId: true,
        raw: true,
        layer: true,
        source: true,
        importanceScore: true,
        effectiveScore: true,
        safetyCritical: true,
        consolidated: true,
        userPinned: true,
        confidence: true,
        createdAt: true,
        extraction: true,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    const memoryIds = memories.map((m) => m.id);

    // ── Entity mentions from semantic graph ─────────────────────────────
    const mentions = await this.prisma.graphEntityMention.findMany({
      where: { memoryId: { in: memoryIds } },
      include: { entity: true },
    });

    const entityMap = new Map<string, any>();
    const memoryEntityMap = new Map<
      string,
      Array<{ id: string; name: string; type: string }>
    >();
    // Inverted index: entityId → [memoryIds that mention it]
    const entityToMemories = new Map<string, string[]>();

    for (const mention of mentions) {
      const entity = mention.entity;
      if (!entityMap.has(entity.id)) {
        entityMap.set(entity.id, {
          id: entity.id,
          name: entity.name,
          type: entity.type,
          mentionCount: entity.mentionCount,
        });
      }

      // Memory → entities
      const existing = memoryEntityMap.get(mention.memoryId) || [];
      if (!existing.some((e) => e.id === entity.id)) {
        existing.push({ id: entity.id, name: entity.name, type: entity.type });
      }
      memoryEntityMap.set(mention.memoryId, existing);

      // Entity → memories (inverted)
      const memIds = entityToMemories.get(entity.id) || [];
      if (!memIds.includes(mention.memoryId)) {
        memIds.push(mention.memoryId);
      }
      entityToMemories.set(entity.id, memIds);
    }

    // ── Build shared-entity edges between memories ──────────────────────
    const edgeSet = new Set<string>(); // dedup "memA:memB"
    const sharedEntityEdges: Array<{
      id: string;
      source: string;
      target: string;
      linkType: string;
      confidence: number;
      createdAt: string;
    }> = [];

    for (const [entityId, memIds] of entityToMemories.entries()) {
      if (memIds.length < 2) continue;
      const entityName = entityMap.get(entityId)?.name || entityId;
      // HEY-364: Sort by recency + importance before capping, not insertion order
      const sortedMemIds = [...memIds].sort((a, b) => {
        const ma = memories.find((m) => m.id === a);
        const mb = memories.find((m) => m.id === b);
        // Primary: importance (desc), secondary: recency (desc)
        const scoreA =
          (ma?.importanceScore ?? 0) + (ma ? ma.createdAt.getTime() / 1e15 : 0);
        const scoreB =
          (mb?.importanceScore ?? 0) + (mb ? mb.createdAt.getTime() / 1e15 : 0);
        return scoreB - scoreA;
      });
      const cappedMemIds = sortedMemIds.slice(0, 10);
      for (let i = 0; i < cappedMemIds.length; i++) {
        for (let j = i + 1; j < cappedMemIds.length; j++) {
          const [a, b] = [cappedMemIds[i], cappedMemIds[j]].sort();
          const key = `${a}:${b}`;
          if (edgeSet.has(key)) continue;
          edgeSet.add(key);
          sharedEntityEdges.push({
            id: `shared-${a.slice(0, 8)}-${b.slice(0, 8)}`,
            source: a,
            target: b,
            linkType: `shared:${entityName}`,
            confidence: 0.5 + Math.min(0.4, memIds.length * 0.05),
            createdAt: new Date().toISOString(),
          });
        }
      }
    }

    // ── Entity relationships ────────────────────────────────────────────
    const entityIds = Array.from(entityMap.keys());
    const relationships =
      entityIds.length > 0
        ? await this.prisma.graphRelationship.findMany({
            where: {
              OR: [
                { sourceEntityId: { in: entityIds } },
                { targetEntityId: { in: entityIds } },
              ],
            },
          })
        : [];

    const entityRelEdges = relationships
      .filter(
        (r) =>
          entityIds.includes(r.sourceEntityId) &&
          entityIds.includes(r.targetEntityId),
      )
      .map((r) => ({
        id: r.id,
        source: r.sourceEntityId,
        target: r.targetEntityId,
        linkType: r.type,
        confidence: r.weight,
        createdAt: r.createdAt.toISOString(),
      }));

    // ── Memory chain links ──────────────────────────────────────────────
    const chainLinks = await this.prisma.memoryChainLink.findMany({
      where: {
        OR: [{ sourceId: { in: memoryIds } }, { targetId: { in: memoryIds } }],
      },
    });

    const chainEdges = chainLinks
      .filter(
        (l) => memoryIds.includes(l.sourceId) && memoryIds.includes(l.targetId),
      )
      .map((l) => ({
        id: l.id,
        source: l.sourceId,
        target: l.targetId,
        linkType: l.linkType,
        confidence: l.confidence,
        createdAt: l.createdAt.toISOString(),
      }));

    // ── Build nodes ─────────────────────────────────────────────────────
    const nodes = memories.map((m) => {
      const memEntities = memoryEntityMap.get(m.id) || [];
      return {
        id: m.id,
        raw: m.raw,
        layer: m.layer,
        source: m.source,
        memorySource:
          agentUserId && m.userId === agentUserId ? 'agent' : 'human',
        importanceScore: m.importanceScore,
        effectiveScore: m.effectiveScore,
        safetyCritical: m.safetyCritical,
        consolidated: m.consolidated,
        userPinned: m.userPinned,
        confidence: m.confidence,
        createdAt: m.createdAt.toISOString(),
        extraction: m.extraction
          ? {
              who: m.extraction.who,
              what: m.extraction.what,
              when: m.extraction.when?.toISOString(),
              where: m.extraction.whereCtx,
              why: m.extraction.why,
              how: m.extraction.how,
              topics: m.extraction.topics,
              memoryType: m.extraction.memoryType,
            }
          : null,
        entities: memEntities,
        primaryEntityType:
          memEntities.length > 0 ? memEntities[0].type.toLowerCase() : 'other',
      };
    });

    const humanCount = nodes.filter((n) => n.memorySource === 'human').length;
    const agentCount = nodes.filter((n) => n.memorySource === 'agent').length;

    return {
      nodes,
      edges: [...sharedEntityEdges, ...entityRelEdges, ...chainEdges],
      entities: Array.from(entityMap.values()),
      ...(includeAgent && { stats: { human: humanCount, agent: agentCount } }),
    };
  }
}

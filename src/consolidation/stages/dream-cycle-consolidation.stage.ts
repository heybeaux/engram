import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ServicePrismaService } from '../../prisma/service-prisma.service';
import { EmbeddingService } from '../../embedding/embedding.service';
import { LLMService } from '../../llm/llm.service';

export interface ConsolidationStageResult {
  clustersFound: number;
  consolidated: number;
  archived: number;
  errors: number;
  llmCalls: number;
}

interface ColdMemory {
  id: string;
  content: string;
  embedding: number[] | null;
}

@Injectable()
export class DreamCycleConsolidationStage {
  private readonly logger = new Logger(DreamCycleConsolidationStage.name);
  private readonly similarityThreshold: number;
  private readonly minClusterSize: number;
  private readonly maxConsolidations: number;

  constructor(
    private readonly prisma: ServicePrismaService,
    private readonly config: ConfigService,
    private readonly embeddingService: EmbeddingService,
    private readonly llmService: LLMService,
  ) {
    this.similarityThreshold = parseFloat(
      this.config.get('DREAM_CONSOLIDATION_SIMILARITY') ?? '0.82',
    );
    this.minClusterSize = parseInt(
      this.config.get('DREAM_CONSOLIDATION_MIN_CLUSTER') ?? '3',
      10,
    );
    this.maxConsolidations = parseInt(
      this.config.get('DREAM_MAX_CONSOLIDATIONS') ?? '10',
      10,
    );
  }

  async run(
    userId: string,
    dryRun: boolean,
  ): Promise<ConsolidationStageResult> {
    const result: ConsolidationStageResult = {
      clustersFound: 0,
      consolidated: 0,
      archived: 0,
      errors: 0,
      llmCalls: 0,
    };

    this.logger.log(
      `Starting cold memory consolidation for user ${userId} (dryRun: ${dryRun})`,
    );

    // Fetch cold-tier memories with embeddings
    const coldMemories = await this.fetchColdMemories(userId);
    if (coldMemories.length < this.minClusterSize) {
      this.logger.log(
        `Only ${coldMemories.length} cold memories found, need at least ${this.minClusterSize}`,
      );
      return result;
    }

    // Cluster by vector similarity
    const clusters = this.clusterMemories(coldMemories);
    result.clustersFound = clusters.length;

    this.logger.log(
      `Found ${clusters.length} clusters from ${coldMemories.length} cold memories`,
    );

    // Process clusters up to max
    const toProcess = clusters.slice(0, this.maxConsolidations);
    for (const cluster of toProcess) {
      try {
        if (!dryRun) {
          await this.consolidateCluster(cluster, userId);
          result.llmCalls++;
        }
        result.consolidated++;
        result.archived += cluster.length;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Failed to consolidate cluster: ${msg}`);
        result.errors++;
      }
    }

    this.logger.log(`Consolidation complete: ${JSON.stringify(result)}`);
    return result;
  }

  private async fetchColdMemories(userId: string): Promise<ColdMemory[]> {
    // Use raw query to extract embedding vectors alongside memory data
    const memories = await this.prisma.$queryRaw<
      Array<{ id: string; content: string; embedding: string | null }>
    >`
      SELECT id, raw AS content, embedding::text
      FROM memories
      WHERE user_id = ${userId}
        AND deleted_at IS NULL
        AND tier = 'COLD'
        AND consolidated = false
      ORDER BY created_at ASC
    `;

    return memories.map((m) => ({
      id: m.id,
      content: m.content,
      embedding: m.embedding ? this.parseVector(m.embedding) : null,
    }));
  }

  private parseVector(vectorStr: string): number[] {
    // pgvector format: [0.1,0.2,...]
    return vectorStr.replace(/[[\]]/g, '').split(',').map(Number);
  }

  /**
   * Greedy single-linkage clustering: for each unvisited memory,
   * find all similar memories and form a cluster if >= minClusterSize.
   */
  clusterMemories(memories: ColdMemory[]): ColdMemory[][] {
    const visited = new Set<string>();
    const clusters: ColdMemory[][] = [];

    const withEmbeddings = memories.filter((m) => m.embedding !== null);

    for (const memory of withEmbeddings) {
      if (visited.has(memory.id)) continue;

      const cluster: ColdMemory[] = [memory];
      visited.add(memory.id);

      for (const candidate of withEmbeddings) {
        if (visited.has(candidate.id)) continue;
        const sim = this.cosineSimilarity(
          memory.embedding!,
          candidate.embedding!,
        );
        if (sim >= this.similarityThreshold) {
          cluster.push(candidate);
          visited.add(candidate.id);
        }
      }

      if (cluster.length >= this.minClusterSize) {
        clusters.push(cluster);
      } else {
        // Unmark non-cluster members so they can join other clusters
        for (const m of cluster) {
          if (m.id !== memory.id) visited.delete(m.id);
        }
      }
    }

    return clusters;
  }

  cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  private async consolidateCluster(
    cluster: ColdMemory[],
    userId: string,
  ): Promise<void> {
    const memoryList = cluster
      .map((m, i) => `${i + 1}. ${m.content}`)
      .join('\n');

    const prompt = `Consolidate these related memories into a single comprehensive memory.
Preserve important nuances and details. Include specific facts, dates, and names.

Memories:
${memoryList}

Write a single consolidated memory that captures all the information above.`;

    const llmResponse = await this.llmService.chat([
      { role: 'user', content: prompt },
    ]);

    const consolidatedContent =
      llmResponse.content?.trim() || cluster.map((m) => m.content).join(' ');

    // Generate embedding for the consolidated memory
    const [embedding] = await this.embeddingService.embed([
      consolidatedContent,
    ]);

    // Create consolidated memory and archive originals in a transaction
    await this.prisma.$transaction(async (tx) => {
      // Create the new consolidated memory
      const newMemory = await tx.memory.create({
        data: {
          userId,
          raw: consolidatedContent,
          layer: 'INSIGHT',
          source: 'DREAM_CYCLE',
          memoryType: 'FACT',
          tier: 'WARM',
          consolidated: false,
          searchable: false,
        },
      });

      // Store embedding via raw query
      if (embedding) {
        await tx.$executeRaw`
          UPDATE memories SET embedding = ${JSON.stringify(embedding)}::vector
          WHERE id = ${newMemory.id}
        `;
      }

      // Link originals to the consolidated memory and archive them
      const originalIds = cluster.map((m) => m.id);
      await tx.memory.updateMany({
        where: { id: { in: originalIds }, userId },
        data: {
          consolidatedInto: newMemory.id,
          consolidated: true,
          tier: 'ARCHIVED',
        },
      });
    });
  }
}

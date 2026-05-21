import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

export interface SemanticMatch {
  profileId: string;
  similarity: number;
}

@Injectable()
export class EntitySemanticService {
  private readonly logger = new Logger(EntitySemanticService.name);
  private readonly embedUrl: string;
  private readonly embedModel: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.embedUrl = this.configService.get<string>(
      'LOCAL_EMBED_URL',
      'http://localhost:8080',
    );
    this.embedModel = this.configService.get<string>(
      'LOCAL_EMBED_MODEL',
      this.configService.get<string>('OPENAI_EMBED_MODEL', ''),
    );
  }

  /**
   * Find entity profiles semantically similar to a given memory.
   * Returns profiles whose embedding cosine similarity exceeds the threshold.
   */
  async findSemanticMatches(
    memoryId: string,
    userId: string,
    threshold = 0.75,
  ): Promise<SemanticMatch[]> {
    // Load the memory text
    const memory = await this.prisma.memory.findFirst({
      where: { id: memoryId, userId, deletedAt: null },
      select: { raw: true },
    });

    if (!memory) {
      this.logger.warn(`Memory ${memoryId} not found for user ${userId}`);
      return [];
    }

    // Generate embedding for memory text
    let memoryEmbedding: number[];
    try {
      memoryEmbedding = await this.embed(memory.raw);
    } catch (err) {
      this.logger.error(
        `Failed to embed memory ${memoryId}: ${(err as Error).message}`,
      );
      return [];
    }

    // Load entity profiles that have embeddings
    // Use raw query to access the vector column
    const profiles = await this.prisma.$queryRaw<
      Array<{ id: string; embedding: string | null }>
    >`
      SELECT id, embedding::text as embedding
      FROM entity_profiles
      WHERE user_id = ${userId}
        AND deleted_at IS NULL
        AND embedding IS NOT NULL
    `;

    if (!profiles.length) return [];

    const matches: SemanticMatch[] = [];

    for (const profile of profiles) {
      if (!profile.embedding) continue;

      try {
        const profileVector = this.parseVector(profile.embedding);
        const similarity = this.cosineSimilarity(
          memoryEmbedding,
          profileVector,
        );

        if (similarity >= threshold) {
          matches.push({ profileId: profile.id, similarity });
        }
      } catch (err) {
        this.logger.warn(
          `Failed to compare embedding for profile ${profile.id}: ${(err as Error).message}`,
        );
      }
    }

    // Sort by descending similarity
    return matches.sort((a, b) => b.similarity - a.similarity);
  }

  /**
   * Call the local embedding server to embed a single text.
   */
  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.embedUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: text,
        ...(this.embedModel ? { model: this.embedModel } : {}),
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Embed server error ${response.status}: ${body}`);
    }

    const data = await response.json();

    if (!data.data || !Array.isArray(data.data) || !data.data[0]?.embedding) {
      throw new Error('Invalid response from embed server');
    }

    return data.data[0].embedding as number[];
  }

  /**
   * Parse a Postgres vector string like "[0.1,0.2,...]" or "{0.1,0.2,...}" into number[].
   */
  private parseVector(raw: string): number[] {
    const cleaned = raw.replace(/^\[|\]$|^\{|\}$/g, '');
    return cleaned.split(',').map((v) => parseFloat(v));
  }

  /**
   * Compute cosine similarity between two vectors.
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
    }

    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom === 0) return 0;

    return dot / denom;
  }
}

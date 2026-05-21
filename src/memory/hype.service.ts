import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LLMService } from '../llm/llm.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class HypeService {
  private readonly logger = new Logger(HypeService.name);
  private readonly enabled: boolean;

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    @Optional() private llmService?: LLMService,
  ) {
    this.enabled =
      this.configService.get<string>('HYPE_ENABLED', 'false') === 'true';
  }

  async generateHypotheticals(content: string): Promise<string[]> {
    if (!this.enabled || !this.llmService) return [];

    try {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('HyPE timeout')), 5000),
      );

      const chatPromise = this.llmService.chat([
        {
          role: 'user',
          content: `Generate 3 short questions that this memory would be the answer to. Return ONLY the questions as a JSON array of strings, nothing else.\n\nMemory: ${content}`,
        },
      ]);

      const response = await Promise.race([chatPromise, timeoutPromise]);
      const questions = JSON.parse(response.content);
      if (!Array.isArray(questions)) return [];
      return questions.filter((q: unknown) => typeof q === 'string');
    } catch {
      return [];
    }
  }

  async embedAndStore(
    memoryId: string,
    hypotheticals: string[],
    userId: string,
  ): Promise<void> {
    if (!hypotheticals.length || !this.llmService) return;

    for (let i = 0; i < hypotheticals.length; i++) {
      const result = await this.llmService.embed(hypotheticals[i]);
      const embeddingStr = `[${result.embedding.join(',')}]`;
      const modelId = `hype-${i}`;
      const now = new Date();

      await this.prisma.$executeRawUnsafe(
        `
        INSERT INTO memory_embeddings (id, memory_id, model_id, dimensions, embedding, created_at, updated_at)
        VALUES (gen_random_uuid()::text, $1, $2, $3, $4::vector, $5, $5)
        ON CONFLICT (memory_id, model_id)
        DO UPDATE SET
          embedding = $4::vector,
          dimensions = $3,
          updated_at = $5
        `,
        memoryId,
        modelId,
        result.dimensions,
        embeddingStr,
        now,
      );
    }
  }

  async generateAndStore(
    memoryId: string,
    content: string,
    userId: string,
  ): Promise<void> {
    if (!this.enabled) return;

    const hypotheticals = await this.generateHypotheticals(content);
    await this.embedAndStore(memoryId, hypotheticals, userId);
  }
}

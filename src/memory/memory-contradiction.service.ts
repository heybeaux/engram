import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from './embedding.service';
import {
  FindContradictionsDto,
  FindContradictionsResult,
  ContradictionResult,
} from './dto/find-contradictions.dto';

@Injectable()
export class MemoryContradictionService {
  private readonly logger = new Logger(MemoryContradictionService.name);

  constructor(
    private prisma: PrismaService,
    private embedding: EmbeddingService,
  ) {}

  /**
   * Find memories that potentially contradict a given fact or insight.
   * Uses high cosine similarity (>threshold) to find semantically related
   * memories of contradictable types (FACT, PREFERENCE, CONSTRAINT, LESSON).
   */
  async findContradictions(
    userId: string | string[] | null,
    dto: FindContradictionsDto,
  ): Promise<FindContradictionsResult> {
    const startTime = Date.now();

    if (!dto.memoryId && !dto.text) {
      throw new BadRequestException(
        'Either memoryId or text must be provided',
      );
    }

    const threshold = dto.threshold ?? 0.8;
    const limit = dto.limit ?? 10;

    let sourceEmbedding: number[];
    let sourceText: string;
    let sourceId: string | null = null;

    if (dto.memoryId) {
      // Load the source memory
      const source = await this.prisma.memory.findUnique({
        where: { id: dto.memoryId },
        select: { id: true, raw: true, userId: true },
      });

      if (!source) {
        throw new NotFoundException(
          `Memory ${dto.memoryId} not found`,
        );
      }

      sourceId = source.id;
      sourceText = source.raw;

      // Try to get existing embedding from DB
      const embeddingRows = await this.prisma.$queryRawUnsafe<
        Array<{ embedding: string }>
      >(
        `SELECT embedding::text FROM memories WHERE id = $1 AND embedding IS NOT NULL`,
        dto.memoryId,
      );

      if (embeddingRows.length > 0 && embeddingRows[0].embedding) {
        sourceEmbedding = JSON.parse(embeddingRows[0].embedding);
      } else {
        sourceEmbedding = await this.embedding.generate(source.raw);
      }
    } else {
      sourceText = dto.text!;
      sourceEmbedding = await this.embedding.generate(dto.text!);
    }

    // Build WHERE conditions for the vector search
    const conditions: string[] = [
      'm.embedding IS NOT NULL',
      'm.deleted_at IS NULL',
      'm.searchable = true',
      `m.memory_type IN ('FACT', 'PREFERENCE', 'CONSTRAINT', 'LESSON')`,
    ];
    const params: any[] = [`[${sourceEmbedding.join(',')}]`];
    let paramIdx = 2;

    // Exclude source memory
    if (sourceId) {
      conditions.push(`m.id != $${paramIdx}`);
      params.push(sourceId);
      paramIdx++;
    }

    // Multi-tenant: filter by agentId
    if (dto.agentId) {
      conditions.push(`m.agent_id = $${paramIdx}`);
      params.push(dto.agentId);
      paramIdx++;
    }

    // Filter by userId for isolation
    if (userId !== null) {
      if (Array.isArray(userId)) {
        conditions.push(`m.user_id = ANY($${paramIdx})`);
        params.push(userId);
      } else {
        conditions.push(`m.user_id = $${paramIdx}`);
        params.push(userId);
      }
      paramIdx++;
    }

    // Similarity threshold
    conditions.push(`1 - (m.embedding <=> $1::vector) > $${paramIdx}`);
    params.push(threshold);
    paramIdx++;

    const whereClause = conditions.join(' AND ');

    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        raw: string;
        memory_type: string | null;
        importance_score: number;
        similarity: number;
        created_at: Date;
      }>
    >(
      `SELECT m.id, m.raw, m.memory_type, m.importance_score,
              1 - (m.embedding <=> $1::vector) as similarity,
              m.created_at
       FROM memories m
       WHERE ${whereClause}
       ORDER BY similarity DESC
       LIMIT $${paramIdx}`,
      ...params,
      limit,
    );

    const contradictions: ContradictionResult[] = rows.map((r) => ({
      id: r.id,
      raw: r.raw,
      memoryType: r.memory_type,
      importanceScore: Number(r.importance_score),
      similarity: Number(r.similarity),
      createdAt: r.created_at,
    }));

    return {
      sourceId,
      sourceText,
      contradictions,
      total: contradictions.length,
      latencyMs: Date.now() - startTime,
    };
  }
}

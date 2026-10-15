import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmbedHealthService } from './embed-health.service';
import { EmbeddingService } from '../memory/embedding.service';

/**
 * Background service that retries embedding generation for memories
 * that were created without embeddings (due to engram-embed being down).
 *
 * Runs every 5 minutes. Only attempts if engram-embed is available.
 */
@Injectable()
export class EmbeddingRetryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmbeddingRetryService.name);
  private readonly batchSize = 20;
  private readonly intervalMs = 5 * 60 * 1000; // 5 minutes
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private prisma: PrismaService,
    private embedHealth: EmbedHealthService,
    private embeddingService: EmbeddingService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.retryPendingEmbeddings().catch((err) => {
        this.logger.error('Embedding retry failed:', err);
      });
    }, this.intervalMs);
    this.logger.log('Embedding retry service started (every 5 minutes)');
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async retryPendingEmbeddings(): Promise<void> {
    // Only attempt if embed is available
    const available = await this.embedHealth.isAvailable();
    if (!available) {
      this.logger.warn({
        event: 'embedding_retry.skipped',
        reason: 'provider_unavailable',
      });
      return;
    }

    // Find memories without embeddings
    const pending = await this.prisma.memory.findMany({
      where: {
        embeddingId: null,
        deletedAt: null,
      },
      orderBy: { createdAt: 'desc' },
      take: this.batchSize,
      select: {
        id: true,
        raw: true,
        userId: true,
        layer: true,
        importanceScore: true,
      },
    });

    if (pending.length === 0) return;

    this.logger.log(`Retrying embeddings for ${pending.length} memories`);
    let success = 0;
    let failed = 0;

    for (const memory of pending) {
      let stage = 'generate';
      try {
        const embedding = await this.embeddingService.generate(memory.raw);
        stage = 'store';
        const embeddingId = await this.embeddingService.store(
          memory.id,
          embedding,
          {
            userId: memory.userId,
            layer: memory.layer,
            importance: memory.importanceScore,
          },
        );

        stage = 'mark_complete';
        await this.prisma.memory.update({
          where: { id: memory.id },
          data: { embeddingId },
        });

        success++;
      } catch (err) {
        failed++;
        // Do not log content or upstream error messages (may contain payloads).
        this.logger.warn({
          event: 'embedding_retry.memory_failed',
          memoryId: memory.id,
          stage,
          errorType: err instanceof Error ? err.name : typeof err,
        });
        if (failed >= 3) {
          this.logger.warn(
            `Embedding retry: ${failed} failures, stopping batch`,
          );
          break;
        }
      }
    }

    this.logger.log({
      event: 'embedding_retry.batch_complete',
      selected: pending.length,
      succeeded: success,
      failed,
      unattempted: pending.length - success - failed,
    });
  }
}

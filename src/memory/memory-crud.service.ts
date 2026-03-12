import {
  Injectable,
  Optional,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MemoryDeletedEvent } from '../events/event-types';
import { PrismaService } from '../prisma/prisma.service';
import { rlsContext } from '../prisma/rls-context';
import { MemoryWithExtraction } from './memory.types';

@Injectable()
export class MemoryCrudService {
  private readonly logger = new Logger(MemoryCrudService.name);

  constructor(
    private prisma: PrismaService,
    @Optional() private eventEmitter?: EventEmitter2,
  ) {}

  private runWithRls(
    accountId: string | undefined,
    fn: () => Promise<void>,
  ): void {
    if (!accountId) {
      fn().catch((err) =>
        this.logger.error('[Memory] Background op failed:', err),
      );
      return;
    }
    const sanitized = accountId.replace(/[^a-zA-Z0-9_-]/g, '');
    this.prisma
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SET LOCAL app.current_account_id = '${sanitized}'`,
        );
        await rlsContext.run(tx as any, () => fn());
      })
      .catch((err) =>
        this.logger.error('[Memory] Background RLS op failed:', err),
      );
  }

  private async incrementMemoriesUsed(
    userId: string,
    delta: number,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { agent: { select: { accountId: true } } },
    });
    const accountId = user?.agent?.accountId;
    if (!accountId) return;

    if (delta > 0) {
      await this.prisma.account.update({
        where: { id: accountId },
        data: { memoriesUsed: { increment: delta } },
      });
    } else {
      await this.prisma.$executeRawUnsafe(
        `UPDATE accounts SET memories_used = GREATEST(0, memories_used + $1) WHERE id = $2`,
        delta,
        accountId,
      );
    }
  }

  private emitEvent(eventName: string, payload: any): void {
    try {
      this.eventEmitter?.emit(eventName, payload);
    } catch (err) {
      this.logger.error(`[Memory] Failed to emit ${eventName}:`, err);
    }
  }

  async verifyOwnership(
    memoryId: string,
    userId: string,
    accountUserIds?: string[],
  ): Promise<void> {
    const memory = await this.prisma.memory.findUnique({
      where: { id: memoryId },
      select: { userId: true },
    });
    if (!memory) {
      throw new NotFoundException(`Memory not found: ${memoryId}`);
    }
    const allowedIds = accountUserIds ?? [userId];
    if (!allowedIds.includes(memory.userId)) {
      throw new ForbiddenException(
        'Access denied: Memory belongs to another user',
      );
    }
  }

  async markUsed(memoryId: string, userId?: string): Promise<void> {
    if (userId) {
      await this.verifyOwnership(memoryId, userId);
    }
    await this.prisma.memory.update({
      where: { id: memoryId },
      data: {
        usedCount: { increment: 1 },
        lastUsedAt: new Date(),
      },
    });
  }

  async getById(
    memoryId: string,
    userId?: string,
    accountUserIds?: string[],
    accountId?: string,
  ): Promise<MemoryWithExtraction | null> {
    const memory = await this.prisma.memory.findUnique({
      where: { id: memoryId },
      include: { extraction: true },
    });
    if (!memory) return null;
    if (accountId) {
      return memory;
    }
    const allowedIds = accountUserIds || (userId ? [userId] : []);
    if (allowedIds.length > 0 && !allowedIds.includes(memory.userId)) {
      throw new ForbiddenException(
        'Access denied: Memory belongs to another user',
      );
    }
    return memory;
  }

  async delete(
    memoryId: string,
    userId?: string,
    accountUserIds?: string[],
  ): Promise<void> {
    if (userId) {
      await this.verifyOwnership(memoryId, userId, accountUserIds);
    }
    await this.prisma.memory.update({
      where: { id: memoryId },
      data: { deletedAt: new Date() },
    });

    if (userId) {
      this.incrementMemoriesUsed(userId, -1).catch((err) => {
        this.logger.error(`[Memory] Failed to decrement memoriesUsed:`, err);
      });
    }

    this.emitEvent(
      'memory.deleted',
      new MemoryDeletedEvent(memoryId, userId ?? 'unknown'),
    );
  }
}

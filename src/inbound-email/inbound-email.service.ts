import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryService } from '../memory/memory.service';
import { InboundEmailDataDto } from './dto/inbound-email-webhook.dto';

const MAX_CONTENT_LENGTH = 500_000;

export interface ResolvedAgent {
  agentId: string;
  userId: string | null;
}

@Injectable()
export class InboundEmailService {
  private readonly logger = new Logger(InboundEmailService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly memoryService: MemoryService,
  ) {}

  /**
   * Extract the local part from an email address.
   * e.g. "rook@mail.openengram.ai" → "rook"
   */
  extractLocalPart(address: string): string | null {
    const local = address.trim().split('@')[0]?.toLowerCase();
    return local || null;
  }

  /**
   * Resolve an agent by matching the email local part against agent names
   * (case-insensitive). Returns agentId and first associated userId.
   */
  async resolveAgent(recipientAddress: string): Promise<ResolvedAgent | null> {
    const localPart = this.extractLocalPart(recipientAddress);
    if (!localPart) return null;

    const agent = await this.prisma.agent.findFirst({
      where: {
        name: { equals: localPart, mode: 'insensitive' },
        deletedAt: null,
      },
      include: { users: true },
    });

    if (!agent) return null;

    return {
      agentId: agent.id,
      userId: agent.users[0]?.id ?? null,
    };
  }

  async handleInboundEmail(data: InboundEmailDataDto, resendEventId: string) {
    // Idempotency check
    const existing = await this.prisma.inboundEmail.findUnique({
      where: { resendEventId },
    });

    if (existing) {
      this.logger.log(`Duplicate event ${resendEventId}, skipping`);
      return existing;
    }

    // Truncate content
    const textBody = data.text ? data.text.slice(0, MAX_CONTENT_LENGTH) : null;
    const htmlBody = data.html ? data.html.slice(0, MAX_CONTENT_LENGTH) : null;

    const toStr = data.to.join(', ');

    const record = await this.prisma.inboundEmail.create({
      data: {
        from: data.from,
        to: toStr,
        subject: data.subject ?? null,
        textBody,
        htmlBody,
        rawHeaders: data.headers ?? undefined,
        resendEventId,
        status: 'received',
      },
    });

    this.logger.log(`Stored inbound email ${record.id} from ${data.from}`);

    // Route to agent by recipient address
    const addresses = toStr.split(',').map((a) => a.trim());
    let resolved: ResolvedAgent | null = null;

    for (const address of addresses) {
      resolved = await this.resolveAgent(address);
      if (resolved) break;
    }

    if (resolved) {
      this.logger.log(
        `Routed email ${record.id} to agent ${resolved.agentId} (user: ${resolved.userId})`,
      );
      // Create memory with the resolved user
      await this.createMemoryFromEmail(record, data, resolved);
    } else {
      this.logger.warn(`No agent found for email ${record.id} (to: ${toStr})`);
      await this.updateEmailStatus(record.id, 'unrouted');
    }

    return record;
  }

  private async createMemoryFromEmail(
    record: { id: string; from: string; to: string; subject: string | null },
    data: InboundEmailDataDto,
    resolved: ResolvedAgent,
  ): Promise<void> {
    try {
      const memoryContent = `Email from ${data.from}: ${data.subject || '(no subject)'}\n\n${data.text || ''}`;

      if (!resolved.userId) {
        this.logger.warn(
          `No user found for memory creation from email ${record.id}`,
        );
        await this.updateEmailStatus(record.id, 'routed');
        return;
      }

      await this.memoryService.remember(resolved.userId, {
        content: memoryContent,
        layer: 'SESSION',
        source: 'AGENT_OBSERVATION',
      });

      await this.updateEmailStatus(record.id, 'processed');
      this.logger.log(`Created memory from email ${record.id}`);
    } catch (error) {
      this.logger.error(
        `Failed to create memory from email ${record.id}: ${error.message}`,
        error.stack,
      );
      await this.updateEmailStatus(record.id, 'failed');
    }
  }

  private async updateEmailStatus(id: string, status: string): Promise<void> {
    try {
      await this.prisma.inboundEmail.update({
        where: { id },
        data: {
          status,
          processedAt: status === 'processed' ? new Date() : undefined,
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to update email status ${id}: ${error.message}`,
      );
    }
  }
}

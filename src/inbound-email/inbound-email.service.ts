import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryService } from '../memory/memory.service';
import { InboundEmailDataDto } from './dto/inbound-email-webhook.dto';

const MAX_CONTENT_LENGTH = 500_000;

@Injectable()
export class InboundEmailService {
  private readonly logger = new Logger(InboundEmailService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly memoryService: MemoryService,
  ) {}

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

    const record = await this.prisma.inboundEmail.create({
      data: {
        from: data.from,
        to: data.to.join(', '),
        subject: data.subject ?? null,
        textBody,
        htmlBody,
        rawHeaders: data.headers ?? undefined,
        resendEventId,
        status: 'received',
      },
    });

    this.logger.log(`Stored inbound email ${record.id} from ${data.from}`);

    // Create memory from email content
    await this.createMemoryFromEmail(record, data);

    return record;
  }

  private async createMemoryFromEmail(
    record: { id: string; from: string; to: string; subject: string | null },
    data: InboundEmailDataDto,
  ): Promise<void> {
    try {
      const memoryContent = `Email from ${data.from}: ${data.subject || '(no subject)'}\n\n${data.text || ''}`;

      // HEY-399 will add proper user routing; for now use first available user
      const user = await this.prisma.user.findFirst({
        orderBy: { createdAt: 'asc' },
      });

      if (!user) {
        this.logger.warn(
          `No user found for memory creation from email ${record.id}`,
        );
        await this.updateEmailStatus(record.id, 'failed');
        return;
      }

      await this.memoryService.remember(user.id, {
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

  private async updateEmailStatus(
    id: string,
    status: string,
  ): Promise<void> {
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

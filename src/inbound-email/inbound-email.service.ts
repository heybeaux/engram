import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InboundEmailDataDto } from './dto/inbound-email-webhook.dto';

const MAX_CONTENT_LENGTH = 500_000;

@Injectable()
export class InboundEmailService {
  private readonly logger = new Logger(InboundEmailService.name);

  constructor(private readonly prisma: PrismaService) {}

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
    return record;
  }
}

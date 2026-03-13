import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryService } from '../memory/memory.service';
import { InboundEmailDataDto } from './dto/inbound-email-webhook.dto';
import { EmailQueryDto } from './dto/email-query.dto';
import { LinkedInEmailParserService } from './linkedin-email-parser.service';

const MAX_CONTENT_LENGTH = 500_000;

export interface ResolvedAgent {
  agentId: string;
  userId: string | null;
}

@Injectable()
export class InboundEmailService {
  private readonly logger = new Logger(InboundEmailService.name);

  private readonly senderAllowlist: string[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly memoryService: MemoryService,
    private readonly configService: ConfigService,
    private readonly linkedInParser: LinkedInEmailParserService,
  ) {
    // Parse INBOUND_EMAIL_SENDER_ALLOWLIST — comma-separated emails or domains
    // e.g. "trevan@generositycatalyst.com,matt@generositycatalyst.com" or "@generositycatalyst.com"
    const raw =
      this.configService.get<string>('INBOUND_EMAIL_SENDER_ALLOWLIST') || '';
    this.senderAllowlist = raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }

  /**
   * Check if a sender is allowed. If no allowlist is configured, all senders are allowed.
   * Supports exact email matches and domain matches (prefixed with @).
   */
  isSenderAllowed(from: string): boolean {
    if (this.senderAllowlist.length === 0) return true;
    const sender = from.toLowerCase().trim();
    return this.senderAllowlist.some((entry) => {
      if (entry.startsWith('@')) {
        return sender.endsWith(entry);
      }
      return sender === entry;
    });
  }

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
    });

    if (!agent) return null;

    // Users now belong to accounts; find the first user for this agent's account
    const defaultUser = agent.accountId
      ? await this.prisma.user.findFirst({
          where: { accountId: agent.accountId },
          select: { id: true },
        })
      : null;

    return {
      agentId: agent.id,
      userId: defaultUser?.id ?? null,
    };
  }

  async findEmails(query: EmailQueryDto) {
    const {
      page = 1,
      limit = 20,
      search,
      from,
      to,
      status,
      startDate,
      endDate,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = query;

    const where: any = {};

    if (search) {
      where.OR = [
        { subject: { contains: search, mode: 'insensitive' } },
        { textBody: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (from) {
      where.from = { contains: from, mode: 'insensitive' };
    }

    if (to) {
      where.to = { contains: to, mode: 'insensitive' };
    }

    if (status) {
      where.status = status;
    }

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    const [data, total] = await Promise.all([
      this.prisma.inboundEmail.findMany({
        where,
        orderBy: { [sortBy]: sortOrder },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.inboundEmail.count({ where }),
    ]);

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async handleInboundEmail(data: InboundEmailDataDto, resendEventId: string) {
    this.logger.log(
      `Inbound email payload keys: ${Object.keys(data).join(', ')} | text: ${data.text ? `${data.text.length} chars` : 'null'} | html: ${data.html ? `${data.html.length} chars` : 'null'}`,
    );

    // Idempotency check
    const existing = await this.prisma.inboundEmail.findUnique({
      where: { resendEventId },
    });

    if (existing) {
      this.logger.log(`Duplicate event ${resendEventId}, skipping`);
      return existing;
    }

    // Sender allowlist check
    if (!this.isSenderAllowed(data.from)) {
      this.logger.warn(
        `Rejected email from ${data.from} — not on sender allowlist`,
      );
      return null;
    }

    // Use webhook body if present, otherwise will fetch from API
    let textBody = data.text ? data.text.slice(0, MAX_CONTENT_LENGTH) : null;
    let htmlBody = data.html ? data.html.slice(0, MAX_CONTENT_LENGTH) : null;

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

    // If webhook payload didn't include body content, fetch from Resend API
    if (!textBody && !htmlBody) {
      const emailId = data.email_id ?? data.id ?? null;
      if (emailId) {
        const fetched = await this.fetchEmailContent(emailId);
        if (fetched) {
          textBody = fetched.text
            ? fetched.text.slice(0, MAX_CONTENT_LENGTH)
            : null;
          htmlBody = fetched.html
            ? fetched.html.slice(0, MAX_CONTENT_LENGTH)
            : null;

          await this.prisma.inboundEmail.update({
            where: { id: record.id },
            data: { textBody, htmlBody },
          });

          this.logger.log(
            `Fetched email content from Resend API for ${record.id}`,
          );
        } else {
          this.logger.warn(
            `Failed to fetch email content from Resend API for ${record.id}`,
          );
          await this.updateEmailStatus(record.id, 'content_fetch_failed');
        }
      } else {
        this.logger.warn(
          `No email ID in webhook payload for ${record.id} — cannot fetch content`,
        );
      }
    }

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
      // Create memory with the resolved user — use fetched content
      await this.createMemoryFromEmail(
        record,
        { ...data, text: textBody ?? data.text, html: htmlBody ?? data.html },
        resolved,
      );
    } else {
      this.logger.warn(`No agent found for email ${record.id} (to: ${toStr})`);
      await this.updateEmailStatus(record.id, 'unrouted');
    }

    return record;
  }

  /**
   * Fetch full email content from Resend API.
   * The webhook payload may not include body content — this retrieves it.
   */
  private async fetchEmailContent(
    emailId: string,
  ): Promise<{ text: string | null; html: string | null } | null> {
    const apiKey = this.configService.get<string>('RESEND_API_KEY');
    if (!apiKey) {
      this.logger.warn(
        'RESEND_API_KEY not configured — cannot fetch email content',
      );
      return null;
    }

    try {
      const response = await fetch(
        `https://api.resend.com/emails/receiving/${emailId}`,
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        },
      );

      if (!response.ok) {
        this.logger.warn(
          `Resend API returned ${response.status} for email ${emailId}`,
        );
        return null;
      }

      const data = await response.json();
      return {
        text: data.text ?? null,
        html: data.html ?? null,
      };
    } catch (error) {
      this.logger.error(
        `Failed to fetch email content from Resend API: ${error.message}`,
      );
      return null;
    }
  }

  private async createMemoryFromEmail(
    record: { id: string; from: string; to: string; subject: string | null },
    data: InboundEmailDataDto,
    resolved: ResolvedAgent,
  ): Promise<void> {
    try {
      if (!resolved.userId) {
        this.logger.warn(
          `No user found for memory creation from email ${record.id}`,
        );
        await this.updateEmailStatus(record.id, 'routed');
        return;
      }

      // Check if this is a LinkedIn engagement notification
      const linkedIn = this.linkedInParser.parse(
        data.subject || '',
        data.text || '',
        data.from,
      );

      if (
        linkedIn.isLinkedIn &&
        linkedIn.engagerName &&
        linkedIn.type !== 'unknown'
      ) {
        // Store structured LinkedIn engagement memory
        const engagementContent = linkedIn.commentPreview
          ? `${linkedIn.engagerName} ${linkedIn.action}: "${linkedIn.commentPreview}"`
          : `${linkedIn.engagerName} ${linkedIn.action}`;

        await this.memoryService.remember(resolved.userId, {
          content: engagementContent,
          layer: 'PROJECT',
          source: 'AGENT_OBSERVATION',
          tags: ['linkedin:engagement', 'auto:true', 'source:email'],
        });

        this.logger.log(
          `Created LinkedIn engagement memory from email ${record.id}: ${linkedIn.type} by ${linkedIn.engagerName}`,
        );
      } else {
        // Standard email memory
        const memoryContent = `Email from ${data.from}: ${data.subject || '(no subject)'}\n\n${data.text || ''}`;

        await this.memoryService.remember(resolved.userId, {
          content: memoryContent,
          layer: 'SESSION',
          source: 'AGENT_OBSERVATION',
        });

        this.logger.log(`Created memory from email ${record.id}`);
      }

      await this.updateEmailStatus(record.id, 'processed');
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

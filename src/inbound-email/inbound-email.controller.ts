import {
  Controller,
  Post,
  Get,
  Query,
  Req,
  HttpCode,
  Logger,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Webhook } from 'svix';
import { InboundEmailService } from './inbound-email.service';
import { InboundEmailWebhookDto } from './dto/inbound-email-webhook.dto';
import { EmailQueryDto } from './dto/email-query.dto';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';

@Controller('v1')
@UseGuards(ThrottlerGuard)
export class InboundEmailController {
  private readonly logger = new Logger(InboundEmailController.name);

  constructor(
    private readonly inboundEmailService: InboundEmailService,
    private readonly configService: ConfigService,
  ) {}

  @Get('emails')
  @UseGuards(ApiKeyOrJwtGuard)
  async findEmails(@Query() query: EmailQueryDto) {
    return this.inboundEmailService.findEmails(query);
  }

  @Post('webhooks/inbound-email')
  @HttpCode(200)
  async handleWebhook(@Req() req: any) {
    const rawBody = req.rawBody;
    if (!rawBody) {
      throw new UnauthorizedException('Missing raw body');
    }

    // Verify Svix signature
    const secret = this.configService.get<string>('RESEND_WEBHOOK_SECRET');
    if (!secret) {
      this.logger.error('RESEND_WEBHOOK_SECRET not configured');
      throw new UnauthorizedException('Webhook not configured');
    }

    const headers = {
      'svix-id': req.headers['svix-id'],
      'svix-timestamp': req.headers['svix-timestamp'],
      'svix-signature': req.headers['svix-signature'],
    };

    let payload: InboundEmailWebhookDto;
    try {
      const wh = new Webhook(secret);
      payload = wh.verify(rawBody.toString(), headers) as any;
    } catch (err) {
      this.logger.warn(`Webhook signature verification failed: ${err.message}`);
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const resendEventId = req.headers['svix-id'] as string;

    this.logger.log(
      `Webhook verified — type: ${payload.type}, data keys: ${Object.keys(payload.data || {}).join(', ')}, top-level keys: ${Object.keys(payload).join(', ')}`,
    );

    // Process — always return 200 for valid signatures
    try {
      await this.inboundEmailService.handleInboundEmail(
        payload.data,
        resendEventId,
      );
    } catch (err) {
      this.logger.error(
        `Failed to process inbound email: ${err.message}`,
        err.stack,
      );
    }

    return { received: true };
  }
}

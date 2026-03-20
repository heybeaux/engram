import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookService } from './webhook.service';
import { EngramEvent } from '../events/event-types';
import * as crypto from 'crypto';
import { validateWebhookUrl } from './url-validator';

@Injectable()
export class WebhookDeliveryService {
  private readonly logger = new Logger(WebhookDeliveryService.name);
  private readonly enabled: boolean;
  private readonly deliveryTimeout: number;

  constructor(
    private prisma: PrismaService,
    private webhookService: WebhookService,
    private config: ConfigService,
  ) {
    this.enabled = this.config.get('WEBHOOK_ENABLED') !== 'false';
    this.deliveryTimeout = parseInt(
      this.config.get('WEBHOOK_DELIVERY_TIMEOUT') ?? '10000',
      10,
    );
  }

  /**
   * Listen to ALL events via wildcard and deliver to matching webhooks
   */
  @OnEvent('**')
  async handleEvent(payload: any): Promise<void> {
    if (!this.enabled) return;

    const eventType = payload?.type;
    if (!eventType || typeof eventType !== 'string') return;

    try {
      const subscriptions =
        await this.webhookService.getMatchingSubscriptions(eventType);
      if (subscriptions.length === 0) return;

      for (const sub of subscriptions) {
        // Apply filters
        if (!this.matchesFilters(sub, payload)) continue;

        // Fire-and-forget delivery with retry
        this.deliverWithRetry(sub, eventType, payload).catch((err) => {
          this.logger.error(
            `Delivery failed for subscription ${sub.id}: ${err.message}`,
          );
        });
      }
    } catch (err) {
      this.logger.error(`Event handling failed for ${eventType}: ${err}`);
    }
  }

  private matchesFilters(sub: any, payload: any): boolean {
    // Layer filter
    if (sub.filterLayers?.length > 0 && payload.layer) {
      if (!sub.filterLayers.includes(payload.layer)) return false;
    }

    // Tag filter
    if (sub.filterTags?.length > 0 && payload.tags) {
      const hasTags = sub.filterTags.some((t: string) =>
        payload.tags.includes(t),
      );
      if (!hasTags) return false;
    }

    // Importance filter
    if (sub.filterMinImportance != null && payload.importance != null) {
      if (payload.importance < sub.filterMinImportance) return false;
    }

    return true;
  }

  async deliverWithRetry(
    sub: any,
    eventType: string,
    payload: any,
  ): Promise<void> {
    // Validate URL before delivery (DNS resolution + IP blocklist)
    await validateWebhookUrl(sub.url);

    const maxAttempts = sub.maxRetries + 1;
    const deliveryId = crypto.randomUUID();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const body = JSON.stringify({
        id: deliveryId,
        type: eventType,
        timestamp: payload.timestamp ?? new Date().toISOString(),
        data: payload.toJSON ? payload.toJSON() : payload,
      });

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Engram-Event': eventType,
        'X-Engram-Delivery': deliveryId,
      };

      if (sub.secret) {
        headers['X-Engram-Signature'] = this.sign(body, sub.secret);
      }

      let statusCode: number | null;
      let error: string | null;

      try {
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          this.deliveryTimeout,
        );

        const response = await fetch(sub.url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });

        clearTimeout(timeout);
        statusCode = response.status;

        // Log delivery
        await this.logDelivery(
          sub.id,
          eventType,
          payload,
          statusCode,
          null,
          attempt,
        );

        if (response.ok) {
          await this.webhookService.recordSuccess(sub.id);
          return;
        }

        error = `HTTP ${statusCode}`;
      } catch (err: any) {
        error = err.message ?? String(err);
        await this.logDelivery(
          sub.id,
          eventType,
          payload,
          null,
          error,
          attempt,
        );
      }

      // Record failure
      await this.webhookService.recordFailure(sub.id);

      // Exponential backoff before retry
      if (attempt < maxAttempts) {
        const delay = sub.backoffMs * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  sign(body: string, secret: string): string {
    return crypto.createHmac('sha256', secret).update(body).digest('hex');
  }

  private async logDelivery(
    subscriptionId: string,
    eventType: string,
    payload: any,
    statusCode: number | null,
    error: string | null,
    attempt: number,
  ): Promise<void> {
    try {
      await this.prisma.webhookDeliveryLog.create({
        data: {
          subscriptionId,
          eventType,
          payload: payload.toJSON ? payload.toJSON() : payload,
          statusCode,
          error,
          attempt,
        },
      });
    } catch (err) {
      this.logger.error(`Failed to log delivery: ${err}`);
    }
  }

  /**
   * Send a test event to a webhook subscription
   */
  async sendTestEvent(subscriptionId: string, userId: string): Promise<any> {
    const sub = await this.webhookService.getById(subscriptionId, userId);
    if (!sub) throw new Error('Webhook subscription not found');

    const testPayload = {
      type: 'webhook.test',
      timestamp: new Date().toISOString(),
      message: 'Test event from Engram',
      subscriptionId: sub.id,
      toJSON() {
        return this;
      },
    };

    await this.deliverWithRetry(sub, 'webhook.test', testPayload);
    return { sent: true };
  }
}

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { WebhookService } from './webhook.service';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryCreatedEvent } from '../events/event-types';

// Mock URL validator to avoid real DNS lookups in tests
jest.mock('./url-validator', () => ({
  validateWebhookUrl: jest.fn().mockResolvedValue(undefined),
  validateWebhookUrlSync: jest.fn(),
  WebhookUrlValidationError: class WebhookUrlValidationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'WebhookUrlValidationError';
    }
  },
}));

// Mock fetch globally
const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

describe('WebhookDeliveryService', () => {
  let service: WebhookDeliveryService;
  let mockWebhookService: any;
  let mockPrisma: any;

  beforeEach(async () => {
    mockWebhookService = {
      getMatchingSubscriptions: jest.fn().mockResolvedValue([]),
      getById: jest.fn(),
      recordSuccess: jest.fn().mockResolvedValue(undefined),
      recordFailure: jest.fn().mockResolvedValue(undefined),
    };

    mockPrisma = {
      webhookDeliveryLog: {
        create: jest.fn().mockResolvedValue({}),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookDeliveryService,
        { provide: WebhookService, useValue: mockWebhookService },
        { provide: PrismaService, useValue: mockPrisma },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string) => {
              if (key === 'WEBHOOK_ENABLED') return 'true';
              if (key === 'WEBHOOK_DELIVERY_TIMEOUT') return '5000';
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    service = module.get(WebhookDeliveryService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('handleEvent', () => {
    it('skips events without type', async () => {
      await service.handleEvent({});
      expect(
        mockWebhookService.getMatchingSubscriptions,
      ).not.toHaveBeenCalled();
    });

    it('fetches matching subscriptions for typed events', async () => {
      const evt = new MemoryCreatedEvent('m1', 'SESSION', 0.8, [], 'u1', 'hi');
      mockWebhookService.getMatchingSubscriptions.mockResolvedValue([]);

      await service.handleEvent(evt);
      expect(mockWebhookService.getMatchingSubscriptions).toHaveBeenCalledWith(
        'memory.created',
      );
    });

    it('delivers to matching subscriptions', async () => {
      const evt = new MemoryCreatedEvent('m1', 'SESSION', 0.8, [], 'u1', 'hi');
      const sub = {
        id: 'wh-1',
        url: 'https://example.com/hook',
        events: ['memory.created'],
        secret: null,
        maxRetries: 0,
        backoffMs: 100,
        filterLayers: [],
        filterTags: [],
        filterMinImportance: null,
        active: true,
      };
      mockWebhookService.getMatchingSubscriptions.mockResolvedValue([sub]);
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      await service.handleEvent(evt);

      // Wait for fire-and-forget
      await new Promise((r) => setTimeout(r, 100));
      expect(mockFetch).toHaveBeenCalled();
    });
  });

  describe('matchesFilters', () => {
    it('passes when no filters set', () => {
      const sub = {
        filterLayers: [],
        filterTags: [],
        filterMinImportance: null,
      };
      expect((service as any).matchesFilters(sub, {})).toBe(true);
    });

    it('filters by layer', () => {
      const sub = {
        filterLayers: ['SESSION'],
        filterTags: [],
        filterMinImportance: null,
      };
      expect((service as any).matchesFilters(sub, { layer: 'SESSION' })).toBe(
        true,
      );
      expect((service as any).matchesFilters(sub, { layer: 'IDENTITY' })).toBe(
        false,
      );
    });

    it('filters by importance', () => {
      const sub = {
        filterLayers: [],
        filterTags: [],
        filterMinImportance: 0.7,
      };
      expect((service as any).matchesFilters(sub, { importance: 0.8 })).toBe(
        true,
      );
      expect((service as any).matchesFilters(sub, { importance: 0.5 })).toBe(
        false,
      );
    });
  });

  describe('sign', () => {
    it('produces HMAC-SHA256 signature', () => {
      const sig = service.sign('{"test":true}', 'secret123');
      expect(sig).toBeTruthy();
      expect(typeof sig).toBe('string');
      expect(sig.length).toBe(64); // hex SHA256
    });

    it('produces consistent signatures', () => {
      const body = '{"data":"hello"}';
      const sig1 = service.sign(body, 'key');
      const sig2 = service.sign(body, 'key');
      expect(sig1).toBe(sig2);
    });

    it('different keys produce different signatures', () => {
      const body = '{"data":"hello"}';
      const sig1 = service.sign(body, 'key1');
      const sig2 = service.sign(body, 'key2');
      expect(sig1).not.toBe(sig2);
    });
  });

  describe('deliverWithRetry', () => {
    it('retries on failure', async () => {
      const sub = {
        id: 'wh-1',
        url: 'https://example.com/hook',
        secret: null,
        maxRetries: 2,
        backoffMs: 10, // Short for tests
      };

      mockFetch
        .mockRejectedValueOnce(new Error('timeout'))
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce({ ok: true, status: 200 });

      await service.deliverWithRetry(sub, 'memory.created', {
        type: 'memory.created',
        timestamp: new Date().toISOString(),
      });

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(mockWebhookService.recordSuccess).toHaveBeenCalled();
    });

    it('stops after max retries', async () => {
      const sub = {
        id: 'wh-1',
        url: 'https://example.com/hook',
        secret: null,
        maxRetries: 1,
        backoffMs: 10,
      };

      mockFetch.mockRejectedValue(new Error('timeout'));

      await service.deliverWithRetry(sub, 'memory.created', {
        type: 'memory.created',
      });

      expect(mockFetch).toHaveBeenCalledTimes(2); // 1 initial + 1 retry
      expect(mockWebhookService.recordFailure).toHaveBeenCalledTimes(2);
    });
  });
});

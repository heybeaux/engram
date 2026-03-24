import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { WebhookDeliveryService } from './webhook-delivery.service';

const mockWebhook = {
  id: 'wh-1',
  userId: 'user-1',
  url: 'https://example.com/hook',
  events: ['memory.created'],
  secret: null,
  active: true,
  createdAt: new Date(),
};

const mockWebhookService = {
  create: jest.fn().mockResolvedValue(mockWebhook),
  list: jest.fn().mockResolvedValue([mockWebhook]),
  getById: jest.fn().mockResolvedValue(mockWebhook),
  update: jest.fn().mockResolvedValue({ ...mockWebhook, active: false }),
  delete: jest.fn().mockResolvedValue({ deleted: true }),
  getDeliveries: jest.fn().mockResolvedValue([]),
};

const mockDeliveryService = {
  sendTestEvent: jest.fn().mockResolvedValue({ queued: true }),
};

const headers = (userId = 'user-1') => ({ 'x-am-user-id': userId });

describe('WebhookController', () => {
  let controller: WebhookController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WebhookController],
      providers: [
        { provide: WebhookService, useValue: mockWebhookService },
        { provide: WebhookDeliveryService, useValue: mockDeliveryService },
      ],
    }).compile();

    controller = module.get<WebhookController>(WebhookController);
  });

  // ── Auth guard: missing X-AM-User-ID ────────────────────────────────────────

  describe('getUserId (implicit via all endpoints)', () => {
    it('create: throws 401 when X-AM-User-ID is missing', async () => {
      await expect(
        controller.create({} as any, { url: 'https://x.com', events: ['e'] } as any),
      ).rejects.toMatchObject({ status: HttpStatus.UNAUTHORIZED });
    });

    it('list: throws 401 when X-AM-User-ID is missing', async () => {
      await expect(controller.list({} as any)).rejects.toMatchObject({
        status: HttpStatus.UNAUTHORIZED,
      });
    });

    it('getById: throws 401 when X-AM-User-ID is missing', async () => {
      await expect(controller.getById({} as any, 'wh-1')).rejects.toMatchObject({
        status: HttpStatus.UNAUTHORIZED,
      });
    });

    it('update: throws 401 when X-AM-User-ID is missing', async () => {
      await expect(
        controller.update({} as any, 'wh-1', {}),
      ).rejects.toMatchObject({ status: HttpStatus.UNAUTHORIZED });
    });

    it('delete: throws 401 when X-AM-User-ID is missing', async () => {
      await expect(controller.delete({} as any, 'wh-1')).rejects.toMatchObject({
        status: HttpStatus.UNAUTHORIZED,
      });
    });

    it('test: throws 401 when X-AM-User-ID is missing', async () => {
      await expect(controller.test({} as any, 'wh-1')).rejects.toMatchObject({
        status: HttpStatus.UNAUTHORIZED,
      });
    });

    it('deliveries: throws 401 when X-AM-User-ID is missing', async () => {
      await expect(
        controller.deliveries({} as any, 'wh-1'),
      ).rejects.toMatchObject({ status: HttpStatus.UNAUTHORIZED });
    });
  });

  // ── POST / create ────────────────────────────────────────────────────────────

  describe('create', () => {
    const dto = { url: 'https://example.com/hook', events: ['memory.created'] };

    it('creates a webhook and returns it', async () => {
      const result = await controller.create(headers(), dto as any);
      expect(result).toEqual(mockWebhook);
      expect(mockWebhookService.create).toHaveBeenCalledWith('user-1', dto);
    });

    it('wraps service errors in 400 HttpException', async () => {
      mockWebhookService.create.mockRejectedValueOnce(new Error('Limit reached'));
      await expect(controller.create(headers(), dto as any)).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
        message: 'Limit reached',
      });
    });
  });

  // ── GET / list ───────────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns webhook list for user', async () => {
      const result = await controller.list(headers());
      expect(result).toEqual([mockWebhook]);
      expect(mockWebhookService.list).toHaveBeenCalledWith('user-1');
    });
  });

  // ── GET /:id ─────────────────────────────────────────────────────────────────

  describe('getById', () => {
    it('returns a single webhook', async () => {
      const result = await controller.getById(headers(), 'wh-1');
      expect(result).toEqual(mockWebhook);
    });

    it('throws 404 when webhook not found', async () => {
      mockWebhookService.getById.mockResolvedValueOnce(null);
      await expect(controller.getById(headers(), 'wh-missing')).rejects.toMatchObject({
        status: HttpStatus.NOT_FOUND,
      });
    });
  });

  // ── PATCH /:id ───────────────────────────────────────────────────────────────

  describe('update', () => {
    it('updates a webhook', async () => {
      const result = await controller.update(headers(), 'wh-1', { active: false });
      expect(result.active).toBe(false);
    });

    it('wraps service errors in 404 HttpException', async () => {
      mockWebhookService.update.mockRejectedValueOnce(new Error('Not found'));
      await expect(
        controller.update(headers(), 'wh-missing', {}),
      ).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    });
  });

  // ── DELETE /:id ──────────────────────────────────────────────────────────────

  describe('delete', () => {
    it('deletes a webhook', async () => {
      const result = await controller.delete(headers(), 'wh-1');
      expect(result).toEqual({ deleted: true });
    });

    it('wraps service errors in 404 HttpException', async () => {
      mockWebhookService.delete.mockRejectedValueOnce(new Error('Not found'));
      await expect(controller.delete(headers(), 'wh-missing')).rejects.toMatchObject({
        status: HttpStatus.NOT_FOUND,
      });
    });
  });

  // ── POST /:id/test ───────────────────────────────────────────────────────────

  describe('test', () => {
    it('sends a test event and returns result', async () => {
      const result = await controller.test(headers(), 'wh-1');
      expect(result).toEqual({ queued: true });
      expect(mockDeliveryService.sendTestEvent).toHaveBeenCalledWith('wh-1', 'user-1');
    });

    it('wraps delivery errors in 404 HttpException', async () => {
      mockDeliveryService.sendTestEvent.mockRejectedValueOnce(
        new Error('Webhook not found'),
      );
      await expect(controller.test(headers(), 'bad-id')).rejects.toMatchObject({
        status: HttpStatus.NOT_FOUND,
      });
    });
  });

  // ── GET /:id/deliveries ──────────────────────────────────────────────────────

  describe('deliveries', () => {
    it('returns delivery list with default limit 50', async () => {
      await controller.deliveries(headers(), 'wh-1');
      expect(mockWebhookService.getDeliveries).toHaveBeenCalledWith(
        'wh-1',
        'user-1',
        50,
      );
    });

    it('passes parsed limit when provided as query param', async () => {
      await controller.deliveries(headers(), 'wh-1', '10');
      expect(mockWebhookService.getDeliveries).toHaveBeenCalledWith(
        'wh-1',
        'user-1',
        10,
      );
    });

    it('wraps service errors in 404 HttpException', async () => {
      mockWebhookService.getDeliveries.mockRejectedValueOnce(
        new Error('Webhook not found'),
      );
      await expect(
        controller.deliveries(headers(), 'bad-id'),
      ).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    });
  });
});

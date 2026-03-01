import { InboundEmailController } from './inbound-email.controller';
import { InboundEmailService } from './inbound-email.service';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { Webhook } from 'svix';

jest.mock('svix', () => ({
  Webhook: jest.fn(),
}));

describe('InboundEmailController', () => {
  let controller: InboundEmailController;
  let service: jest.Mocked<InboundEmailService>;
  let configService: jest.Mocked<ConfigService>;
  let mockWebhookVerify: jest.Mock;

  const validPayload = {
    type: 'email.received',
    data: {
      from: 'sender@example.com',
      to: ['agent@mail.openengram.ai'],
      subject: 'Hello',
      text: 'Plain text body',
      html: '<p>HTML body</p>',
    },
  };

  beforeEach(() => {
    service = {
      handleInboundEmail: jest.fn().mockResolvedValue({ id: 'uuid-1' }),
    } as any;

    configService = {
      get: jest.fn().mockReturnValue('whsec_test_secret'),
    } as any;

    mockWebhookVerify = jest.fn().mockReturnValue(validPayload);
    (Webhook as any).mockImplementation(() => ({
      verify: mockWebhookVerify,
    }));

    controller = new InboundEmailController(service, configService);
  });

  const makeReq = (overrides: any = {}) => ({
    rawBody: Buffer.from(JSON.stringify(validPayload)),
    headers: {
      'svix-id': 'evt-123',
      'svix-timestamp': '1234567890',
      'svix-signature': 'v1,valid',
      ...overrides.headers,
    },
    ...overrides,
  });

  it('should return 200 on valid webhook', async () => {
    const result = await controller.handleWebhook(makeReq());

    expect(result).toEqual({ received: true });
    expect(service.handleInboundEmail).toHaveBeenCalledWith(
      validPayload.data,
      'evt-123',
    );
  });

  it('should throw 401 on invalid signature', async () => {
    mockWebhookVerify.mockImplementation(() => {
      throw new Error('Invalid signature');
    });

    await expect(controller.handleWebhook(makeReq())).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('should throw 401 when raw body is missing', async () => {
    await expect(
      controller.handleWebhook({ headers: {}, rawBody: undefined }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('should throw 401 when webhook secret is not configured', async () => {
    configService.get.mockReturnValue(undefined);

    await expect(controller.handleWebhook(makeReq())).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('should return 200 even if service throws', async () => {
    service.handleInboundEmail.mockRejectedValue(new Error('DB error'));

    const result = await controller.handleWebhook(makeReq());
    expect(result).toEqual({ received: true });
  });

  it('should handle duplicate events (idempotency)', async () => {
    service.handleInboundEmail.mockResolvedValue({
      id: 'uuid-existing',
    } as any);

    const result = await controller.handleWebhook(makeReq());
    expect(result).toEqual({ received: true });
  });
});

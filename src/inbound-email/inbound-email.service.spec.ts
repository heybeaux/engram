import { InboundEmailService } from './inbound-email.service';
import { PrismaService } from '../prisma/prisma.service';

describe('InboundEmailService', () => {
  let service: InboundEmailService;
  let prisma: jest.Mocked<PrismaService>;

  beforeEach(() => {
    prisma = {
      inboundEmail: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
    } as any;

    service = new InboundEmailService(prisma);
  });

  const sampleData = {
    from: 'sender@example.com',
    to: ['agent@mail.openengram.ai'],
    subject: 'Hello',
    text: 'Plain text body',
    html: '<p>HTML body</p>',
    headers: [],
  };

  it('should store a new inbound email', async () => {
    (prisma.inboundEmail.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.inboundEmail.create as jest.Mock).mockResolvedValue({
      id: 'uuid-1',
      from: sampleData.from,
      to: 'agent@mail.openengram.ai',
      subject: 'Hello',
      textBody: 'Plain text body',
      htmlBody: '<p>HTML body</p>',
      rawHeaders: [],
      resendEventId: 'evt-1',
      status: 'received',
      processedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.handleInboundEmail(sampleData, 'evt-1');

    expect(prisma.inboundEmail.findUnique).toHaveBeenCalledWith({
      where: { resendEventId: 'evt-1' },
    });
    expect(prisma.inboundEmail.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        from: 'sender@example.com',
        to: 'agent@mail.openengram.ai',
        subject: 'Hello',
        resendEventId: 'evt-1',
      }),
    });
    expect(result.id).toBe('uuid-1');
  });

  it('should return existing record on duplicate event', async () => {
    const existing = { id: 'uuid-existing', resendEventId: 'evt-dup' } as any;
    (prisma.inboundEmail.findUnique as jest.Mock).mockResolvedValue(existing);

    const result = await service.handleInboundEmail(sampleData, 'evt-dup');

    expect(result).toBe(existing);
    expect(prisma.inboundEmail.create).not.toHaveBeenCalled();
  });

  it('should truncate content exceeding 500KB', async () => {
    (prisma.inboundEmail.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.inboundEmail.create as jest.Mock).mockImplementation(({ data }: any) => ({
      id: 'uuid-2',
      ...data,
      processedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const longText = 'x'.repeat(600_000);
    await service.handleInboundEmail(
      { ...sampleData, text: longText, html: longText },
      'evt-long',
    );

    const createCall = (prisma.inboundEmail.create as jest.Mock).mock.calls[0][0] as any;
    expect(createCall.data.textBody.length).toBe(500_000);
    expect(createCall.data.htmlBody.length).toBe(500_000);
  });
});

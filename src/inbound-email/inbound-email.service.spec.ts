import { InboundEmailService } from './inbound-email.service';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryService } from '../memory/memory.service';

describe('InboundEmailService', () => {
  let service: InboundEmailService;
  let prisma: jest.Mocked<PrismaService>;
  let memoryService: jest.Mocked<MemoryService>;

  beforeEach(() => {
    prisma = {
      inboundEmail: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      user: {
        findFirst: jest.fn(),
      },
    } as any;

    memoryService = {
      remember: jest.fn(),
    } as any;

    service = new InboundEmailService(prisma, memoryService);
  });

  const sampleData = {
    from: 'sender@example.com',
    to: ['agent@mail.openengram.ai'],
    subject: 'Hello',
    text: 'Plain text body',
    html: '<p>HTML body</p>',
    headers: [],
  };

  const storedRecord = {
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
  };

  const defaultUser = { id: 'user-1', createdAt: new Date() };

  it('should store a new inbound email and create memory', async () => {
    (prisma.inboundEmail.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.inboundEmail.create as jest.Mock).mockResolvedValue(storedRecord);
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(defaultUser);
    (memoryService.remember as jest.Mock).mockResolvedValue({});
    (prisma.inboundEmail.update as jest.Mock).mockResolvedValue({});

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
    expect(memoryService.remember).toHaveBeenCalledWith('user-1', {
      content: 'Email from sender@example.com: Hello\n\nPlain text body',
      layer: 'SESSION',
      source: 'AGENT_OBSERVATION',
    });
    expect(prisma.inboundEmail.update).toHaveBeenCalledWith({
      where: { id: 'uuid-1' },
      data: { status: 'processed', processedAt: expect.any(Date) },
    });
    expect(result.id).toBe('uuid-1');
  });

  it('should return existing record on duplicate event', async () => {
    const existing = { id: 'uuid-existing', resendEventId: 'evt-dup' } as any;
    (prisma.inboundEmail.findUnique as jest.Mock).mockResolvedValue(existing);

    const result = await service.handleInboundEmail(sampleData, 'evt-dup');

    expect(result).toBe(existing);
    expect(prisma.inboundEmail.create).not.toHaveBeenCalled();
    expect(memoryService.remember).not.toHaveBeenCalled();
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
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(defaultUser);
    (memoryService.remember as jest.Mock).mockResolvedValue({});
    (prisma.inboundEmail.update as jest.Mock).mockResolvedValue({});

    const longText = 'x'.repeat(600_000);
    await service.handleInboundEmail(
      { ...sampleData, text: longText, html: longText },
      'evt-long',
    );

    const createCall = (prisma.inboundEmail.create as jest.Mock).mock.calls[0][0] as any;
    expect(createCall.data.textBody.length).toBe(500_000);
    expect(createCall.data.htmlBody.length).toBe(500_000);
  });

  it('should not fail webhook when memory creation fails', async () => {
    (prisma.inboundEmail.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.inboundEmail.create as jest.Mock).mockResolvedValue(storedRecord);
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(defaultUser);
    (memoryService.remember as jest.Mock).mockRejectedValue(
      new Error('Memory creation failed'),
    );
    (prisma.inboundEmail.update as jest.Mock).mockResolvedValue({});

    const result = await service.handleInboundEmail(sampleData, 'evt-fail');

    expect(result.id).toBe('uuid-1');
    expect(prisma.inboundEmail.update).toHaveBeenCalledWith({
      where: { id: 'uuid-1' },
      data: { status: 'failed', processedAt: undefined },
    });
  });

  it('should handle no user found gracefully', async () => {
    (prisma.inboundEmail.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.inboundEmail.create as jest.Mock).mockResolvedValue(storedRecord);
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.inboundEmail.update as jest.Mock).mockResolvedValue({});

    const result = await service.handleInboundEmail(sampleData, 'evt-nouser');

    expect(result.id).toBe('uuid-1');
    expect(memoryService.remember).not.toHaveBeenCalled();
    expect(prisma.inboundEmail.update).toHaveBeenCalledWith({
      where: { id: 'uuid-1' },
      data: { status: 'failed', processedAt: undefined },
    });
  });

  it('should format memory content with no subject', async () => {
    (prisma.inboundEmail.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.inboundEmail.create as jest.Mock).mockResolvedValue({
      ...storedRecord,
      subject: null,
    });
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(defaultUser);
    (memoryService.remember as jest.Mock).mockResolvedValue({});
    (prisma.inboundEmail.update as jest.Mock).mockResolvedValue({});

    await service.handleInboundEmail(
      { ...sampleData, subject: undefined },
      'evt-nosub',
    );

    expect(memoryService.remember).toHaveBeenCalledWith('user-1', {
      content: 'Email from sender@example.com: (no subject)\n\nPlain text body',
      layer: 'SESSION',
      source: 'AGENT_OBSERVATION',
    });
  });
});

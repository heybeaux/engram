import { InboundEmailService } from './inbound-email.service';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryService } from '../memory/memory.service';
import { ConfigService } from '@nestjs/config';
import { LinkedInEmailParserService } from './linkedin-email-parser.service';

describe('InboundEmailService', () => {
  let service: InboundEmailService;
  let prisma: jest.Mocked<PrismaService>;
  let memoryService: jest.Mocked<MemoryService>;
  let configService: jest.Mocked<ConfigService>;
  let linkedInParser: jest.Mocked<LinkedInEmailParserService>;

  beforeEach(() => {
    prisma = {
      inboundEmail: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      agent: {
        findFirst: jest.fn(),
      },
      user: {
        findFirst: jest.fn(),
      },
    } as any;

    memoryService = {
      remember: jest.fn().mockResolvedValue({}),
    } as any;

    configService = {
      get: jest.fn().mockReturnValue(''),
    } as any;

    linkedInParser = {
      parse: jest.fn().mockReturnValue({ isLinkedIn: false }),
    } as any;

    service = new InboundEmailService(
      prisma,
      memoryService,
      configService,
      linkedInParser,
    );
  });

  const sampleData = {
    from: 'sender@example.com',
    to: ['rook@mail.openengram.ai'],
    subject: 'Hello',
    text: 'Plain text body',
    html: '<p>HTML body</p>',
    headers: [],
  };

  describe('extractLocalPart', () => {
    it('should extract local part from standard email', () => {
      expect(service.extractLocalPart('rook@mail.openengram.ai')).toBe('rook');
    });

    it('should lowercase the local part', () => {
      expect(service.extractLocalPart('Rook@mail.openengram.ai')).toBe('rook');
    });

    it('should trim whitespace', () => {
      expect(service.extractLocalPart('  rook@mail.openengram.ai  ')).toBe(
        'rook',
      );
    });

    it('should return null for empty string', () => {
      expect(service.extractLocalPart('')).toBeNull();
    });

    it('should return null for address starting with @', () => {
      expect(service.extractLocalPart('@domain.com')).toBeNull();
    });
  });

  describe('resolveAgent', () => {
    it('should resolve a valid agent by name', async () => {
      (prisma.agent.findFirst as jest.Mock).mockResolvedValue({
        id: 'agent-1',
        name: 'rook',
        users: [{ id: 'user-1' }],
      });

      const result = await service.resolveAgent('rook@mail.openengram.ai');

      expect(result).toEqual({ agentId: 'agent-1', userId: 'user-1' });
      expect(prisma.agent.findFirst as jest.Mock).toHaveBeenCalledWith({
        where: {
          name: { equals: 'rook', mode: 'insensitive' },
          deletedAt: null,
        },
        include: { users: true },
      });
    });

    it('should return null for unknown agent', async () => {
      (prisma.agent.findFirst as jest.Mock).mockResolvedValue(null);

      const result = await service.resolveAgent('unknown@mail.openengram.ai');
      expect(result).toBeNull();
    });

    it('should return null userId when agent has no users', async () => {
      (prisma.agent.findFirst as jest.Mock).mockResolvedValue({
        id: 'agent-2',
        name: 'solo',
        users: [],
      });

      const result = await service.resolveAgent('solo@mail.openengram.ai');
      expect(result).toEqual({ agentId: 'agent-2', userId: null });
    });
  });

  describe('handleInboundEmail', () => {
    it('should store email, route to agent, and create memory', async () => {
      (prisma.inboundEmail.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.inboundEmail.create as jest.Mock).mockResolvedValue({
        id: 'uuid-1',
        from: sampleData.from,
        to: 'rook@mail.openengram.ai',
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
      (prisma.agent.findFirst as jest.Mock).mockResolvedValue({
        id: 'agent-1',
        name: 'rook',
        users: [{ id: 'user-1' }],
      });
      (prisma.inboundEmail.update as jest.Mock).mockResolvedValue({});

      const result = await service.handleInboundEmail(sampleData, 'evt-1');

      expect(prisma.inboundEmail.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          from: 'sender@example.com',
          to: 'rook@mail.openengram.ai',
          subject: 'Hello',
          resendEventId: 'evt-1',
          status: 'received',
        }),
      });
      expect(memoryService.remember as jest.Mock).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          content: expect.stringContaining('sender@example.com'),
          layer: 'SESSION',
          source: 'AGENT_OBSERVATION',
        }),
      );
      expect(prisma.inboundEmail.update as jest.Mock).toHaveBeenCalledWith({
        where: { id: 'uuid-1' },
        data: { status: 'processed', processedAt: expect.any(Date) },
      });
      expect(result!.id).toBe('uuid-1');
    });

    it('should set status to unrouted when agent not found', async () => {
      (prisma.inboundEmail.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.inboundEmail.create as jest.Mock).mockResolvedValue({
        id: 'uuid-2',
        from: sampleData.from,
        to: 'unknown@mail.openengram.ai',
        status: 'received',
      });
      (prisma.agent.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.inboundEmail.update as jest.Mock).mockResolvedValue({});

      await service.handleInboundEmail(
        { ...sampleData, to: ['unknown@mail.openengram.ai'] },
        'evt-2',
      );

      expect(prisma.inboundEmail.update as jest.Mock).toHaveBeenCalledWith({
        where: { id: 'uuid-2' },
        data: { status: 'unrouted' },
      });
      expect(memoryService.remember).not.toHaveBeenCalled();
    });

    it('should return existing record on duplicate event', async () => {
      const existing = {
        id: 'uuid-existing',
        resendEventId: 'evt-dup',
      } as any;
      (prisma.inboundEmail.findUnique as jest.Mock).mockResolvedValue(existing);

      const result = await service.handleInboundEmail(sampleData, 'evt-dup');

      expect(result).toBe(existing);
      expect(prisma.inboundEmail.create).not.toHaveBeenCalled();
    });

    it('should truncate content exceeding 500KB', async () => {
      (prisma.inboundEmail.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.inboundEmail.create as jest.Mock).mockImplementation(
        ({ data }: any) => ({
          id: 'uuid-3',
          ...data,
          processedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      );
      (prisma.agent.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.inboundEmail.update as jest.Mock).mockResolvedValue({});

      const longText = 'x'.repeat(600_000);
      await service.handleInboundEmail(
        { ...sampleData, text: longText, html: longText },
        'evt-long',
      );

      const createCall = (prisma.inboundEmail.create as jest.Mock).mock
        .calls[0][0];
      expect(createCall.data.textBody.length).toBe(500_000);
      expect(createCall.data.htmlBody.length).toBe(500_000);
    });

    it('should not fail webhook when memory creation fails', async () => {
      (prisma.inboundEmail.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.inboundEmail.create as jest.Mock).mockResolvedValue({
        id: 'uuid-1',
        from: sampleData.from,
        to: 'rook@mail.openengram.ai',
        subject: 'Hello',
        status: 'received',
      });
      (prisma.agent.findFirst as jest.Mock).mockResolvedValue({
        id: 'agent-1',
        name: 'rook',
        users: [{ id: 'user-1' }],
      });
      (memoryService.remember as jest.Mock).mockRejectedValue(
        new Error('Memory creation failed'),
      );
      (prisma.inboundEmail.update as jest.Mock).mockResolvedValue({});

      const result = await service.handleInboundEmail(sampleData, 'evt-fail');

      expect(result!.id).toBe('uuid-1');
      // Should update status to 'failed'
      expect(prisma.inboundEmail.update as jest.Mock).toHaveBeenCalledWith({
        where: { id: 'uuid-1' },
        data: { status: 'failed', processedAt: undefined },
      });
    });

    it('should handle routed agent with no users gracefully', async () => {
      (prisma.inboundEmail.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.inboundEmail.create as jest.Mock).mockResolvedValue({
        id: 'uuid-1',
        from: sampleData.from,
        to: 'rook@mail.openengram.ai',
        subject: 'Hello',
        status: 'received',
      });
      (prisma.agent.findFirst as jest.Mock).mockResolvedValue({
        id: 'agent-1',
        name: 'rook',
        users: [],
      });
      (prisma.inboundEmail.update as jest.Mock).mockResolvedValue({});

      await service.handleInboundEmail(sampleData, 'evt-nouser');

      // Should set status to 'routed' (agent found but no user for memory)
      expect(prisma.inboundEmail.update as jest.Mock).toHaveBeenCalledWith({
        where: { id: 'uuid-1' },
        data: { status: 'routed', processedAt: undefined },
      });
      expect(memoryService.remember).not.toHaveBeenCalled();
    });
  });

  describe('findEmails', () => {
    beforeEach(() => {
      (prisma.inboundEmail as any).findMany = jest.fn().mockResolvedValue([]);
      (prisma.inboundEmail as any).count = jest.fn().mockResolvedValue(0);
    });

    it('should return paginated results with defaults', async () => {
      (prisma.inboundEmail.findMany as jest.Mock).mockResolvedValue([
        { id: '1' },
      ]);
      (prisma.inboundEmail.count as jest.Mock).mockResolvedValue(1);

      const result = await service.findEmails({});

      expect(result).toEqual({
        data: [{ id: '1' }],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      });
      expect(prisma.inboundEmail.findMany as jest.Mock).toHaveBeenCalledWith({
        where: {},
        orderBy: { createdAt: 'desc' },
        skip: 0,
        take: 20,
      });
    });

    it('should apply search filter across subject and textBody', async () => {
      (prisma.inboundEmail.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.inboundEmail.count as jest.Mock).mockResolvedValue(0);

      await service.findEmails({ search: 'hello' });

      const call = (prisma.inboundEmail.findMany as jest.Mock).mock.calls[0][0];
      expect(call.where.OR).toEqual([
        { subject: { contains: 'hello', mode: 'insensitive' } },
        { textBody: { contains: 'hello', mode: 'insensitive' } },
      ]);
    });

    it('should apply from/to/status filters', async () => {
      (prisma.inboundEmail.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.inboundEmail.count as jest.Mock).mockResolvedValue(0);

      await service.findEmails({
        from: 'test@',
        to: 'rook@',
        status: 'processed',
      });

      const call = (prisma.inboundEmail.findMany as jest.Mock).mock.calls[0][0];
      expect(call.where.from).toEqual({
        contains: 'test@',
        mode: 'insensitive',
      });
      expect(call.where.to).toEqual({ contains: 'rook@', mode: 'insensitive' });
      expect(call.where.status).toBe('processed');
    });

    it('should apply date range filters', async () => {
      (prisma.inboundEmail.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.inboundEmail.count as jest.Mock).mockResolvedValue(0);

      await service.findEmails({
        startDate: '2026-01-01T00:00:00Z',
        endDate: '2026-02-01T00:00:00Z',
      });

      const call = (prisma.inboundEmail.findMany as jest.Mock).mock.calls[0][0];
      expect(call.where.createdAt.gte).toEqual(
        new Date('2026-01-01T00:00:00Z'),
      );
      expect(call.where.createdAt.lte).toEqual(
        new Date('2026-02-01T00:00:00Z'),
      );
    });

    it('should calculate totalPages correctly', async () => {
      (prisma.inboundEmail.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.inboundEmail.count as jest.Mock).mockResolvedValue(45);

      const result = await service.findEmails({ page: 1, limit: 20 });
      expect(result.totalPages).toBe(3);
    });

    it('should handle custom pagination and sorting', async () => {
      (prisma.inboundEmail.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.inboundEmail.count as jest.Mock).mockResolvedValue(0);

      await service.findEmails({
        page: 3,
        limit: 10,
        sortBy: 'from',
        sortOrder: 'asc',
      });

      expect(prisma.inboundEmail.findMany as jest.Mock).toHaveBeenCalledWith({
        where: {},
        orderBy: { from: 'asc' },
        skip: 20,
        take: 10,
      });
    });
  });
});

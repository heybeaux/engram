import { Test, TestingModule } from '@nestjs/testing';
import {
  MemoryAccessLogService,
  MemoryAccessType,
} from './memory-access-log.service';
import { PrismaService } from '../prisma/prisma.service';

describe('MemoryAccessLogService', () => {
  let service: MemoryAccessLogService;
  let prisma: any;

  const mockAgentSession = {
    id: 'session-id-1',
    sessionKey: 'agent:main',
    label: 'Main Agent',
    status: 'ACTIVE',
    createdAt: new Date('2026-02-09T21:00:00Z'),
    endedAt: null,
  };

  const mockCompletedSession = {
    ...mockAgentSession,
    id: 'session-id-2',
    sessionKey: 'agent:main:subagent:abc',
    label: 'Sub Agent',
    status: 'COMPLETED',
    endedAt: new Date('2026-02-09T21:45:00Z'),
  };

  beforeEach(async () => {
    prisma = {
      agentSession: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
      },
      memoryAccessLog: {
        create: jest.fn(),
        createMany: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
      memory: {
        findUnique: jest.fn(),
      },
      memoryPoolMembership: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoryAccessLogService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<MemoryAccessLogService>(MemoryAccessLogService);
  });

  describe('writeLogEntry', () => {
    it('should resolve session and create log entry', async () => {
      prisma.agentSession.findUnique.mockResolvedValue({ id: 'session-id-1' });
      prisma.memoryAccessLog.create.mockResolvedValue({});

      await service.writeLogEntry({
        memoryId: 'mem-1',
        agentSessionKey: 'agent:main',
        accessType: MemoryAccessType.CREATED,
        context: 'test',
      });

      expect(prisma.memoryAccessLog.create).toHaveBeenCalledWith({
        data: {
          memoryId: 'mem-1',
          agentSessionId: 'session-id-1',
          accessType: 'CREATED',
          context: 'test',
          tokensCost: undefined,
        },
      });
    });

    it('should auto-create session if not found', async () => {
      prisma.agentSession.findUnique.mockResolvedValue(null);
      prisma.agentSession.upsert.mockResolvedValue({ id: 'new-session-id' });
      prisma.memoryAccessLog.create.mockResolvedValue({});

      await service.writeLogEntry({
        memoryId: 'mem-1',
        agentSessionKey: 'agent:main:subagent:xyz',
        accessType: MemoryAccessType.RECALLED,
      });

      expect(prisma.agentSession.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { sessionKey: 'agent:main:subagent:xyz' },
          create: expect.objectContaining({
            sessionKey: 'agent:main:subagent:xyz',
            parentKey: 'agent:main',
          }),
        }),
      );
    });
  });

  describe('writeBatchLogEntries', () => {
    it('should batch insert multiple entries', async () => {
      prisma.agentSession.findUnique.mockResolvedValue({ id: 'session-id-1' });
      prisma.memoryAccessLog.createMany.mockResolvedValue({ count: 3 });

      await service.writeBatchLogEntries([
        {
          memoryId: 'mem-1',
          agentSessionKey: 'agent:main',
          accessType: MemoryAccessType.RECALLED,
        },
        {
          memoryId: 'mem-2',
          agentSessionKey: 'agent:main',
          accessType: MemoryAccessType.RECALLED,
        },
        {
          memoryId: 'mem-3',
          agentSessionKey: 'agent:main',
          accessType: MemoryAccessType.RECALLED,
        },
      ]);

      expect(prisma.memoryAccessLog.createMany).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          expect.objectContaining({ memoryId: 'mem-1' }),
          expect.objectContaining({ memoryId: 'mem-2' }),
          expect.objectContaining({ memoryId: 'mem-3' }),
        ]),
      });
    });

    it('should skip empty batch', async () => {
      await service.writeBatchLogEntries([]);
      expect(prisma.memoryAccessLog.createMany).not.toHaveBeenCalled();
    });
  });

  describe('getAttribution', () => {
    it('should return full attribution trail', async () => {
      prisma.memory.findUnique.mockResolvedValue({
        id: 'mem-1',
        createdBySession: 'agent:main',
      });
      prisma.agentSession.findUnique.mockResolvedValue(mockAgentSession);
      prisma.memoryAccessLog.findMany.mockResolvedValue([
        {
          accessType: 'RECALLED',
          context: 'search query',
          createdAt: new Date('2026-02-09T21:05:00Z'),
          agentSession: { sessionKey: 'agent:main:subagent:abc' },
        },
      ]);

      const result = await service.getAttribution('mem-1');

      expect(result.memoryId).toBe('mem-1');
      expect(result.createdBySession?.sessionKey).toBe('agent:main');
      expect(result.accessLog).toHaveLength(1);
      expect(result.pools).toHaveLength(0);
    });

    it('should handle memory with no creator session', async () => {
      prisma.memory.findUnique.mockResolvedValue({ id: 'mem-1' });
      prisma.memoryAccessLog.findMany.mockResolvedValue([]);

      const result = await service.getAttribution('mem-1');

      expect(result.createdBySession).toBeNull();
      expect(result.accessLog).toHaveLength(0);
    });
  });

  describe('getSessionSummary', () => {
    it('should return session summary', async () => {
      prisma.agentSession.findUnique.mockResolvedValue(mockCompletedSession);
      prisma.memoryAccessLog.count.mockResolvedValue(5);
      prisma.memoryAccessLog.findMany.mockResolvedValue([
        { memoryId: 'mem-1' },
        { memoryId: 'mem-2' },
        { memoryId: 'mem-1' }, // duplicate
      ]);

      const result = await service.getSessionSummary('agent:main:subagent:abc');

      expect(result.sessionKey).toBe('agent:main:subagent:abc');
      expect(result.status).toBe('COMPLETED');
      expect(result.memoriesCreated).toBe(5);
      expect(result.memoriesAccessed).toBe(3);
      expect(result.uniqueMemories).toBe(2);
      expect(result.uniqueMemoriesAccessed).toBe(2);
      expect(result.duration).toBe(45 * 60 * 1000);
      expect(result.topTopics).toEqual([]);
    });

    it('should handle unknown session', async () => {
      prisma.agentSession.findUnique.mockResolvedValue(null);

      const result = await service.getSessionSummary('nonexistent');

      expect(result.status).toBe('UNKNOWN');
      expect(result.memoriesCreated).toBe(0);
    });
  });

  describe('fire-and-forget methods', () => {
    it('logCreated should not throw on failure', async () => {
      prisma.agentSession.findUnique.mockRejectedValue(new Error('DB down'));

      // Should not throw - fire and forget
      await service.logCreated('mem-1', 'agent:main');

      // Give the async operation time to complete
      await new Promise((r) => setTimeout(r, 50));
    });

    it('logRecalled should batch log multiple memory IDs', async () => {
      prisma.agentSession.findUnique.mockResolvedValue({ id: 'session-id-1' });
      prisma.memoryAccessLog.createMany.mockResolvedValue({ count: 2 });

      await service.logRecalled(
        ['mem-1', 'mem-2'],
        'agent:main',
        'search query',
      );

      await new Promise((r) => setTimeout(r, 50));
      expect(prisma.memoryAccessLog.createMany).toHaveBeenCalled();
    });

    it('logInjected should include tokensCost', async () => {
      prisma.agentSession.findUnique.mockResolvedValue({ id: 'session-id-1' });
      prisma.memoryAccessLog.createMany.mockResolvedValue({ count: 1 });

      await service.logInjected(['mem-1'], 'agent:main', 'context load', 500);

      await new Promise((r) => setTimeout(r, 50));
      expect(prisma.memoryAccessLog.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            memoryId: 'mem-1',
            accessType: 'INJECTED',
            tokensCost: 500,
          }),
        ],
      });
    });
  });
});

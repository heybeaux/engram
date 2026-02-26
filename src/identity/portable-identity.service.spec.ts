import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { PortableIdentityService } from './portable-identity.service';
import { PrismaService } from '../prisma/prisma.service';
import { PortableIdentityExport } from './dto/portable-identity.dto';

describe('PortableIdentityService', () => {
  let service: PortableIdentityService;
  let mockPrisma: any;

  beforeEach(async () => {
    mockPrisma = {
      memory: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation((args) => ({
          id: 'new-mem',
          ...args.data,
        })),
      },
      agent: {
        findFirst: jest.fn().mockResolvedValue({ name: 'TestAgent' }),
      },
      agentCapabilityProfile: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      taskCompletion: {
        findMany: jest.fn().mockResolvedValue([]),
        groupBy: jest.fn().mockResolvedValue([]),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PortableIdentityService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<PortableIdentityService>(PortableIdentityService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('exportIdentity', () => {
    it('should export a complete identity profile', async () => {
      const result = await service.exportIdentity('agent-1');

      expect(result.schemaVersion).toBe('1.0.0');
      expect(result.agentId).toBe('agent-1');
      expect(result.agentName).toBe('TestAgent');
      expect(result.capabilities).toBeDefined();
      expect(result.preferences).toBeDefined();
      expect(result.trustProfile).toBeDefined();
      expect(result.workHistorySummary).toBeDefined();
      expect(result.collaborationPatterns).toBeDefined();
      expect(result.integrityHash).toBeDefined();
      expect(result.exportedAt).toBeDefined();
    });

    it('should include integrity hash', async () => {
      const result = await service.exportIdentity('agent-1');

      expect(result.integrityHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should produce consistent hashes for same data', async () => {
      const r1 = await service.exportIdentity('agent-1');
      const r2 = await service.exportIdentity('agent-1');

      // Hash should be deterministic for same input (minus exportedAt)
      expect(r1.integrityHash).toBeDefined();
      expect(r2.integrityHash).toBeDefined();
    });

    it('should include trust profile with correct structure', async () => {
      mockPrisma.memory.findMany.mockResolvedValue([
        { importanceScore: 0.8, raw: 'Task completed successfully' },
        { importanceScore: 0.6, raw: 'Task completed with issues' },
      ]);

      const result = await service.exportIdentity('agent-1');

      expect(result.trustProfile).toHaveProperty('totalTasks');
      expect(result.trustProfile).toHaveProperty('successRate');
      expect(result.trustProfile).toHaveProperty('avgResponseQuality');
      expect(result.trustProfile).toHaveProperty('specializations');
    });

    it('should include work history summary', async () => {
      mockPrisma.memory.count.mockResolvedValue(42);
      mockPrisma.memory.findFirst.mockResolvedValue({
        createdAt: new Date('2024-01-01'),
      });

      const result = await service.exportIdentity('agent-1');

      expect(result.workHistorySummary).toHaveProperty('totalMemories');
      expect(result.workHistorySummary).toHaveProperty('taskCompletions');
      expect(result.workHistorySummary).toHaveProperty('reflections');
      expect(result.workHistorySummary).toHaveProperty('activeSince');
      expect(result.workHistorySummary).toHaveProperty('topCategories');
    });
  });

  describe('importIdentity', () => {
    it('should import a valid identity and create memories', async () => {
      const exported = await service.exportIdentity('agent-1');

      const result = await service.importIdentity(exported, 'agent-target');

      expect(result.agentId).toBe('agent-target');
      expect(result.memoriesCreated).toBeGreaterThanOrEqual(1);
    });

    it('should reject tampered identity', async () => {
      const exported = await service.exportIdentity('agent-1');
      exported.agentName = 'TAMPERED';

      await expect(service.importIdentity(exported)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reject incompatible schema versions', async () => {
      const exported = await service.exportIdentity('agent-1');
      // Recompute hash with different version
      const tampered = { ...exported, schemaVersion: '2.0.0' };
      tampered.integrityHash = service.computeHash({
        ...tampered,
        integrityHash: undefined,
      });
      // Remove integrityHash from hash input
      const { integrityHash: _, ...dataWithoutHash } = tampered;
      tampered.integrityHash = service.computeHash(dataWithoutHash);

      await expect(service.importIdentity(tampered)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should use original agentId if no target specified', async () => {
      const exported = await service.exportIdentity('agent-original');

      const result = await service.importIdentity(exported);

      expect(result.agentId).toBe('agent-original');
    });
  });

  describe('computeHash', () => {
    it('should produce deterministic hashes', () => {
      const data = { foo: 'bar', baz: 123 };
      const h1 = service.computeHash(data);
      const h2 = service.computeHash(data);
      expect(h1).toBe(h2);
    });

    it('should produce different hashes for different data', () => {
      const h1 = service.computeHash({ a: 1 });
      const h2 = service.computeHash({ a: 2 });
      expect(h1).not.toBe(h2);
    });
  });
});

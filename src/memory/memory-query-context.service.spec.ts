import { MemoryQueryContextService } from './memory-query-context.service';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryLayer, SubjectType } from '@prisma/client';

describe('MemoryQueryContextService', () => {
  let service: MemoryQueryContextService;
  let prisma: jest.Mocked<PrismaService>;

  beforeEach(() => {
    prisma = {
      memory: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    } as any;

    service = new MemoryQueryContextService(prisma);
  });

  describe('selectMemoriesForBudget', () => {
    const makeMemory = (id: string, raw: string, overrides: any = {}) => ({
      id,
      raw,
      layer: MemoryLayer.IDENTITY,
      safetyCritical: false,
      priority: 3,
      ...overrides,
    });

    it('should select memories within budget', () => {
      const candidates = [
        makeMemory('m1', 'short text'),
        makeMemory('m2', 'another short text'),
      ];

      const result = service.selectMemoriesForBudget(
        candidates as any,
        1000,
        0,
      );
      expect(result.selected).toHaveLength(2);
      expect(result.evicted).toHaveLength(0);
    });

    it('should evict memories exceeding budget', () => {
      const candidates = [
        makeMemory('m1', 'x'.repeat(4000)), // ~1000 tokens
        makeMemory('m2', 'short text'), // ~3 tokens
      ];

      const result = service.selectMemoriesForBudget(candidates as any, 500, 0);
      expect(result.evicted.length).toBeGreaterThan(0);
    });

    it('should prioritize safety-critical memories', () => {
      const candidates = [
        makeMemory('m1', 'safety critical', { safetyCritical: true }),
        makeMemory('m2', 'regular'),
      ];

      const result = service.selectMemoriesForBudget(
        candidates as any,
        1000,
        0,
      );
      expect(result.selected[0].id).toBe('m1');
    });

    it('should reserve budget for constraints', () => {
      const candidates = [
        makeMemory('m1', 'constraint', { priority: 1 }),
        makeMemory('m2', 'regular text'),
      ];

      const result = service.selectMemoriesForBudget(
        candidates as any,
        1000,
        200,
      );
      expect(result.selected).toHaveLength(2);
    });
  });

  describe('formatContext', () => {
    it('should format identity memories under User Identity heading', () => {
      const memories = [
        { raw: 'I like coffee', layer: MemoryLayer.IDENTITY },
      ] as any;

      const result = service.formatContext(memories, 4000);
      expect(result.text).toContain('## User Identity');
      expect(result.text).toContain('- I like coffee');
    });

    it('should format project memories under Current Project heading', () => {
      const memories = [
        { raw: 'Using React', layer: MemoryLayer.PROJECT },
      ] as any;

      const result = service.formatContext(memories, 4000);
      expect(result.text).toContain('## Current Project');
      expect(result.text).toContain('- Using React');
    });

    it('should format session memories under Recent Context heading', () => {
      const memories = [
        { raw: 'Discussed API design', layer: MemoryLayer.SESSION },
      ] as any;

      const result = service.formatContext(memories, 4000);
      expect(result.text).toContain('## Recent Context');
      expect(result.text).toContain('- Discussed API design');
    });

    it('should respect token budget', () => {
      const memories = [
        { raw: 'First memory', layer: MemoryLayer.IDENTITY },
        { raw: 'x '.repeat(5000), layer: MemoryLayer.IDENTITY },
      ] as any;

      const result = service.formatContext(memories, 10);
      expect(result.tokens).toBeLessThanOrEqual(10);
    });

    it('should return empty text for no memories', () => {
      const result = service.formatContext([], 4000);
      expect(result.text).toBe('');
      expect(result.tokens).toBe(0);
    });
  });

  describe('loadContext', () => {
    it('should query all layers in parallel', async () => {
      prisma.memory.findMany = jest.fn().mockResolvedValue([]);

      const result = await service.loadContext('user-123', {});
      expect(result.memoriesIncluded).toBe(0);
      expect(result.layers.identity).toBe(0);
      expect(result.layers.project).toBe(0);
      expect(result.layers.session).toBe(0);
    });

    it('should include project layer when projectId is provided', async () => {
      const projectMemory = {
        id: 'pm1',
        raw: 'Project fact',
        layer: MemoryLayer.PROJECT,
        safetyCritical: false,
        priority: 3,
      };

      prisma.memory.findMany = jest.fn().mockImplementation((args: any) => {
        if (args?.where?.layer === MemoryLayer.PROJECT) {
          return Promise.resolve([projectMemory]);
        }
        return Promise.resolve([]);
      });

      const result = await service.loadContext('user-123', {
        projectId: 'proj-1',
      });
      expect(result.layers.project).toBe(1);
    });

    it('should respect maxTokens budget', async () => {
      prisma.memory.findMany = jest.fn().mockResolvedValue([]);

      const result = await service.loadContext('user-123', { maxTokens: 100 });
      expect(result.tokenCount).toBeLessThanOrEqual(100);
    });
  });
});

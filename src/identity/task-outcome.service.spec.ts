import { Test, TestingModule } from '@nestjs/testing';
import { TaskOutcomeService } from './task-outcome.service';
import { PrismaService } from '../prisma/prisma.service';

describe('TaskOutcomeService', () => {
  let service: TaskOutcomeService;
  let prisma: jest.Mocked<PrismaService>;

  const mockMemory = {
    id: 'mem-1',
    userId: 'user-1',
    agentId: 'agent-1',
    raw: 'Task completed: deploy API — outcome: success',
    layer: 'TASK',
    memoryType: 'TASK_OUTCOME',
    metadata: {
      taskDescription: 'deploy API',
      outcome: 'success',
      durationMs: 5000,
      lessonsLearned: ['check staging first'],
      capabilitiesUsed: ['deployment', 'testing'],
    },
    createdAt: new Date('2026-02-20'),
    updatedAt: new Date('2026-02-20'),
  };

  beforeEach(async () => {
    const mockPrisma = {
      memory: {
        create: jest.fn().mockResolvedValue(mockMemory),
        findMany: jest.fn().mockResolvedValue([mockMemory]),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TaskOutcomeService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get(TaskOutcomeService);
    prisma = module.get(PrismaService);
  });

  describe('create', () => {
    it('should create a TASK_OUTCOME memory with metadata', async () => {
      const result = await service.create('user-1', 'agent-1', {
        taskDescription: 'deploy API',
        outcome: 'success',
        durationMs: 5000,
        lessonsLearned: ['check staging first'],
        capabilitiesUsed: ['deployment', 'testing'],
      });

      expect(result.id).toBe('mem-1');
      expect(result.taskDescription).toBe('deploy API');
      expect(result.outcome).toBe('success');
      expect(result.durationMs).toBe(5000);

      expect(prisma.memory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            memoryType: 'TASK_OUTCOME',
            layer: 'TASK',
            subjectType: 'AGENT',
          }),
        }),
      );
    });
  });

  describe('list', () => {
    it('excludes hidden task outcomes', async () => {
      (prisma.memory.findMany as jest.Mock).mockImplementation(
        ({ where }: any) => {
          expect(where.userHidden).toBe(false);
          return Promise.resolve([]);
        },
      );
      expect(await service.list('user-1', 'agent-1')).toEqual([]);
    });

    it('should list task outcomes ordered by date', async () => {
      const results = await service.list('user-1', 'agent-1');
      expect(results).toHaveLength(1);
      expect(results[0].taskDescription).toBe('deploy API');
      expect(results[0].outcome).toBe('success');
    });
  });

  describe('detectTaskCompletion', () => {
    it('should detect "completed" pattern', () => {
      const result = TaskOutcomeService.detectTaskCompletion(
        'Successfully completed the API migration.',
      );
      expect(result).not.toBeNull();
      expect(result!.taskDescription).toContain('API migration');
      expect(result!.outcome).toBe('success');
    });

    it('should detect failure patterns', () => {
      const result = TaskOutcomeService.detectTaskCompletion(
        "Completed the deploy but it didn't work properly.",
      );
      expect(result).not.toBeNull();
      expect(result!.outcome).toBe('failure');
    });

    it('should return null for non-task text', () => {
      const result = TaskOutcomeService.detectTaskCompletion(
        'I prefer dark mode in all apps.',
      );
      expect(result).toBeNull();
    });
  });
});

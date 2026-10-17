import { Test, TestingModule } from '@nestjs/testing';
import { SelfAssessmentService } from './self-assessment.service';
import { PrismaService } from '../prisma/prisma.service';

describe('SelfAssessmentService', () => {
  let service: SelfAssessmentService;
  let prisma: jest.Mocked<PrismaService>;

  const mockMemory = {
    id: 'mem-1',
    userId: 'user-1',
    agentId: 'agent-1',
    raw: 'Self-assessment for code_review: rating 7/10 (confidence: 0.8)',
    memoryType: 'SELF_ASSESSMENT',
    metadata: {
      area: 'code_review',
      selfRating: 7,
      confidence: 0.8,
      evidence: ['reviewed 50 PRs'],
      goals: ['improve security review skills'],
    },
    createdAt: new Date('2026-02-20'),
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
        SelfAssessmentService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get(SelfAssessmentService);
    prisma = module.get(PrismaService);
  });

  describe('create', () => {
    it('should create a SELF_ASSESSMENT memory', async () => {
      const result = await service.create('user-1', 'agent-1', {
        area: 'code_review',
        selfRating: 7,
        confidence: 0.8,
        evidence: ['reviewed 50 PRs'],
        goals: ['improve security review skills'],
      });

      expect(result.id).toBe('mem-1');
      expect(result.area).toBe('code_review');
      expect(result.selfRating).toBe(7);
      expect(result.confidence).toBe(0.8);

      expect(prisma.memory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            memoryType: 'SELF_ASSESSMENT',
            layer: 'IDENTITY',
            subjectType: 'AGENT',
          }),
        }),
      );
    });
  });

  describe('list', () => {
    it('excludes hidden self-assessments', async () => {
      (prisma.memory.findMany as jest.Mock).mockImplementation(
        ({ where }: any) => {
          expect(where.userHidden).toBe(false);
          return Promise.resolve([]);
        },
      );
      expect(await service.list('user-1', 'agent-1')).toEqual([]);
    });

    it('should list self-assessments', async () => {
      const results = await service.list('user-1', 'agent-1');
      expect(results).toHaveLength(1);
      expect(results[0].area).toBe('code_review');
    });

    it('should filter by area', async () => {
      const results = await service.list('user-1', 'agent-1', {
        area: 'writing',
      });
      expect(results).toHaveLength(0); // mock returns code_review, not writing
    });
  });

  describe('getLatestByArea', () => {
    it('should deduplicate by area returning latest', async () => {
      const results = await service.getLatestByArea('user-1', 'agent-1');
      expect(results).toHaveLength(1);
      expect(results[0].area).toBe('code_review');
    });
  });
});

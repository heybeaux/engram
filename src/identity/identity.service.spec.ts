import { IdentityService } from './identity.service';

describe('IdentityService', () => {
  let service: IdentityService;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      agent: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'agent-1',
          name: 'TestAgent',
          createdAt: new Date('2024-12-01'),
        }),
      },
      memory: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    const mockTaskOutcome = {
      create: jest.fn().mockResolvedValue({
        id: 'stub-outcome',
        taskDescription: 'deploy',
        outcome: 'success',
      }),
      list: jest.fn().mockResolvedValue([]),
    } as any;

    const mockSelfAssessment = {
      create: jest.fn().mockResolvedValue({
        id: 'stub-assessment',
        area: 'coding',
        selfRating: 8,
      }),
      getLatestByArea: jest.fn().mockResolvedValue([]),
    } as any;

    const mockCapabilityProfile = {
      getProfile: jest
        .fn()
        .mockResolvedValue({ agentId: 'agent-1', capabilities: [] }),
      updateFromTaskOutcome: jest.fn().mockResolvedValue(undefined),
    } as any;

    const mockWorkStyle = {
      getWorkStyle: jest.fn().mockResolvedValue([]),
      extractFromTaskOutcome: jest.fn().mockResolvedValue(undefined),
    } as any;

    service = new IdentityService(
      prisma,
      mockTaskOutcome,
      mockSelfAssessment,
      mockCapabilityProfile,
      mockWorkStyle,
    );
  });

  describe('bootstrap', () => {
    it('should return empty object for now', async () => {
      const result = await service.bootstrap('agent-1', 'user-1');
      expect(result).toEqual({});
    });

    it('should handle missing parameters', async () => {
      const result = await service.bootstrap();
      expect(result).toEqual({});
    });
  });

  describe('recordTaskOutcome', () => {
    it('should return stub result for test compatibility', async () => {
      const dto = {
        taskDescription: 'deploy',
        outcome: 'success' as const,
        durationMs: 5000,
      };

      const result = await service.recordTaskOutcome('user-1', 'agent-1', dto);

      expect(result.id).toBe('stub-outcome');
      expect(result.taskDescription).toBe('deploy');
      expect(result.outcome).toBe('success');
    });
  });

  describe('getIdentityProfile', () => {
    it('should return stub profile for test compatibility', async () => {
      const profile = await service.getIdentityProfile('agent-1', 'user-1');

      expect(profile.agentId).toBe('agent-1');
      expect(profile.name).toBe('TestAgent');
      expect(profile.capabilities).toEqual([]);
      expect(profile.preferences).toEqual([]);
      expect(profile.trustSignals).toBeDefined();
      expect(profile.trustSignals?.totalMemories).toBe(0);
    });
  });

  describe('recordSelfAssessment', () => {
    it('should return stub result for test compatibility', async () => {
      const dto = {
        area: 'coding',
        selfRating: 8,
        confidence: 0.9,
      };

      const result = await service.recordSelfAssessment(
        'user-1',
        'agent-1',
        dto,
      );

      expect(result.id).toBe('stub-assessment');
      expect(result.area).toBe('coding');
      expect(result.selfRating).toBe(8);
    });
  });

  describe('getCapabilities', () => {
    it('should return stub capabilities for test compatibility', async () => {
      const result = await service.getCapabilities('agent-1', 'user-1');

      expect(result.agentId).toBe('agent-1');
      expect(result.capabilities).toEqual([]);
    });
  });
});

import { IdentityController } from '../identity.controller';

describe('GET /v1/identity/agents', () => {
  let controller: IdentityController;
  let mockPrisma: any;
  let mockTrustProfileService: any;

  beforeEach(() => {
    mockPrisma = {
      agent: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'agent-1',
            name: 'TestAgent',
            apiKeyHint: 'am_...abc',
            createdAt: new Date('2025-01-01'),
            updatedAt: new Date('2025-01-02'),
          },
        ]),
      },
      agentCapabilityProfile: {
        findMany: jest.fn().mockResolvedValue([
          {
            capability: 'code_review',
            confidence: 0.85,
            evidenceCount: 10,
            lastUsedAt: new Date('2025-01-02'),
          },
        ]),
      },
      memory: {
        count: jest.fn().mockResolvedValue(42),
        findFirst: jest
          .fn()
          .mockResolvedValue({ createdAt: new Date('2025-01-02') }),
      },
    };

    mockTrustProfileService = {
      getProfile: jest.fn().mockResolvedValue({
        agentId: 'agent-1',
        overallTrust: 0.9,
        domains: [],
        totalTasksCompleted: 5,
        lastUpdatedAt: new Date(),
      }),
    };

    controller = new IdentityController(
      mockPrisma,
      {} as any, // teamProfileService
      {} as any, // delegationRecallService
      {} as any, // portableIdentityService
      {} as any, // taskCompletionService
      {} as any, // delegationTemplateService
      mockTrustProfileService,
      {} as any, // delegationContractService
      {} as any, // challengeService
      {} as any, // identityService
    );
  });

  it('should return agents with capabilities and trust summary for authenticated account', async () => {
    const req = { accountId: 'acc-1', agent: null };
    const result = await controller.listAgents(req);

    expect(result).toHaveProperty('agents');
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].id).toBe('agent-1');
    expect(result.agents[0].name).toBe('TestAgent');
    expect(result.agents[0].capabilities).toHaveLength(1);
    expect(result.agents[0].capabilities[0].capability).toBe('code_review');
    expect(result.agents[0].trustSummary.overallTrust).toBe(0.9);
  });

  it('should return single agent when no accountId but agent is on request', async () => {
    const req = {
      accountId: null,
      agent: {
        id: 'agent-2',
        name: 'Solo',
        apiKeyHint: 'am_...xyz',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    };
    const result = await controller.listAgents(req);

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].id).toBe('agent-2');
  });

  it('should return empty array when no auth context', async () => {
    const req = { accountId: null, agent: null };
    const result = await controller.listAgents(req);
    expect(result).toEqual({ agents: [] });
  });
});

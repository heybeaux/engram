import { IdentityController } from './identity.controller';
import { TaskOutcome } from './dto/task-completion.dto';

describe('IdentityController', () => {
  let controller: IdentityController;
  let taskCompletionService: any;
  let delegationTemplateService: any;
  let trustProfileService: any;
  let delegationContractService: any;
  let challengeService: any;
  let teamProfileService: any;

  beforeEach(() => {
    teamProfileService = {
      createTeam: jest.fn().mockResolvedValue({ id: 'team_1', name: 'Test' }),
      getTeam: jest.fn().mockResolvedValue({
        id: 'team_1',
        name: 'Test',
        agentIds: ['a', 'b'],
      }),
      getTeamCapabilities: jest
        .fn()
        .mockResolvedValue([
          { name: 'coding', score: 0.8, contributors: ['a'] },
        ]),
      listTeams: jest.fn().mockResolvedValue([{ id: 'team_1', name: 'Test' }]),
      getCollaborationPairs: jest
        .fn()
        .mockResolvedValue([
          { agentA: 'a', agentB: 'b', taskCount: 5, successRate: 0.9 },
        ]),
    };
    const delegationRecallService = { recall: jest.fn() } as any;
    const portableIdentityService = {
      exportIdentity: jest.fn(),
      importIdentity: jest.fn(),
    } as any;

    taskCompletionService = {
      create: jest.fn().mockResolvedValue({ id: 'tc_1' }),
      query: jest.fn().mockResolvedValue([]),
    };
    delegationTemplateService = {
      suggest: jest.fn().mockResolvedValue({
        suggestedAgent: 'agent-a',
        confidence: 0.8,
      }),
    };
    trustProfileService = {
      getProfile: jest.fn().mockResolvedValue({
        agentId: 'agent-a',
        overallTrust: 0.9,
        domains: [],
      }),
    };

    delegationContractService = {
      create: jest
        .fn()
        .mockResolvedValue({ id: 'contract_1', status: 'pending' }),
      listAll: jest.fn().mockReturnValue([
        { id: 'c1', status: 'pending', delegatedTo: 'agent-a' },
        { id: 'c2', status: 'completed', delegatedTo: 'agent-b' },
      ]),
      getById: jest
        .fn()
        .mockReturnValue({ id: 'contract_1', status: 'pending' }),
      complete: jest
        .fn()
        .mockResolvedValue({ id: 'contract_1', status: 'completed' }),
    };

    challengeService = {
      create: jest
        .fn()
        .mockResolvedValue({ id: 'challenge_1', challengeType: 'unsafe' }),
      getById: jest
        .fn()
        .mockReturnValue({ id: 'challenge_1', challengeType: 'unsafe' }),
      listAll: jest.fn().mockReturnValue([
        { id: 'ch1', contractId: 'c1', resolution: null },
        { id: 'ch2', contractId: 'c2', resolution: 'accepted' },
      ]),
      resolve: jest
        .fn()
        .mockResolvedValue({ id: 'challenge_1', resolution: 'accepted' }),
    };

    controller = new IdentityController(
      {} as any, // PrismaService
      teamProfileService,
      delegationRecallService,
      portableIdentityService,
      taskCompletionService,
      delegationTemplateService,
      trustProfileService,
      delegationContractService,
      challengeService,
      {} as any, // identityService
    );
  });

  // === HEY-281: Contracts ===

  describe('POST /contracts', () => {
    it('should create a delegation contract', async () => {
      const result = await controller.createContract({
        taskDescription: 'Build feature',
        expectedOutputs: ['code'],
        successCriteria: ['tests pass'],
        timeout: 60000,
        delegatedTo: 'agent-a',
      });
      expect(result.id).toBe('contract_1');
      expect(delegationContractService.create).toHaveBeenCalled();
    });
  });

  describe('GET /contracts', () => {
    it('should list all contracts wrapped in { contracts }', async () => {
      const result = await controller.listContracts();
      expect(result.contracts).toHaveLength(2);
    });

    it('should filter by status', async () => {
      const result = await controller.listContracts('pending');
      expect(result.contracts).toHaveLength(1);
      expect(result.contracts[0].id).toBe('c1');
    });

    it('should filter by agentId', async () => {
      const result = await controller.listContracts(undefined, 'agent-b');
      expect(result.contracts).toHaveLength(1);
      expect(result.contracts[0].id).toBe('c2');
    });

    it('should filter by isTemplate', async () => {
      delegationContractService.listAll.mockReturnValue([
        {
          id: 'c1',
          status: 'pending',
          delegatedTo: 'agent-a',
          isTemplate: true,
        },
        {
          id: 'c2',
          status: 'completed',
          delegatedTo: 'agent-b',
          isTemplate: false,
        },
      ]);
      const result = await controller.listContracts(
        undefined,
        undefined,
        'true',
      );
      expect(result.contracts).toHaveLength(1);
      expect(result.contracts[0].id).toBe('c1');
    });
  });

  describe('GET /contracts/:id', () => {
    it('should get contract by ID', async () => {
      const result = await controller.getContract('contract_1');
      expect(result.id).toBe('contract_1');
    });
  });

  describe('PUT /contracts/:id', () => {
    it('should update a contract', async () => {
      delegationContractService.update = jest
        .fn()
        .mockReturnValue({ id: 'contract_1', taskDescription: 'Updated' });
      const result = await controller.updateContract('contract_1', {
        taskDescription: 'Updated',
      });
      expect(result.taskDescription).toBe('Updated');
      expect(delegationContractService.update).toHaveBeenCalledWith(
        'contract_1',
        { taskDescription: 'Updated' },
      );
    });
  });

  describe('POST /contracts/:id/complete', () => {
    it('should complete a contract', async () => {
      const result = await controller.completeContract('contract_1', {
        status: 'completed',
        result: 'Done',
      });
      expect(result.status).toBe('completed');
    });
  });

  // === HEY-282: Challenges ===

  describe('POST /challenges', () => {
    it('should create a challenge', async () => {
      const result = await controller.createChallenge({
        taskDescription: 'Dangerous task',
        challengeType: 'unsafe',
        reasoning: 'Too risky',
      });
      expect(result.id).toBe('challenge_1');
    });
  });

  describe('GET /challenges', () => {
    it('should list all challenges wrapped in { challenges }', async () => {
      const result = await controller.listChallenges();
      expect(result.challenges).toHaveLength(2);
    });

    it('should filter by contractId', async () => {
      challengeService.listAll.mockReturnValue([
        { id: 'ch1', contractId: 'c1', resolution: null },
      ]);
      const result = await controller.listChallenges('c1');
      expect(challengeService.listAll).toHaveBeenCalledWith({
        contractId: 'c1',
      });
    });

    it('should filter by resolved status', async () => {
      const result = await controller.listChallenges(undefined, 'resolved');
      expect(result.challenges).toHaveLength(1);
      expect(result.challenges[0].id).toBe('ch2');
    });

    it('should filter by open status', async () => {
      const result = await controller.listChallenges(undefined, 'open');
      expect(result.challenges).toHaveLength(1);
      expect(result.challenges[0].id).toBe('ch1');
    });

    it('should filter by type', async () => {
      challengeService.listAll.mockReturnValue([
        { id: 'ch1', challengeType: 'unsafe', resolution: null },
        {
          id: 'ch2',
          challengeType: 'capability_mismatch',
          resolution: 'accepted',
        },
      ]);
      const result = await controller.listChallenges(
        undefined,
        undefined,
        'unsafe',
      );
      expect(result.challenges).toHaveLength(1);
      expect(result.challenges[0].id).toBe('ch1');
    });
  });

  describe('GET /challenges/:id', () => {
    it('should get a challenge by ID', async () => {
      challengeService.getById.mockReturnValue({
        id: 'challenge_1',
        challengeType: 'unsafe',
      });
      const result = await controller.getChallenge('challenge_1');
      expect(result.id).toBe('challenge_1');
    });
  });

  describe('POST /challenges/:id/resolve', () => {
    it('should resolve a challenge', async () => {
      const result = await controller.resolveChallenge('challenge_1', {
        resolution: 'accepted',
        resolvedBy: 'human',
      });
      expect(result.resolution).toBe('accepted');
    });
  });

  // === HEY-283: Teams ===

  describe('GET /teams', () => {
    it('should list all teams', async () => {
      const result = await controller.listTeams();
      expect(result).toHaveLength(1);
      expect(teamProfileService.listTeams).toHaveBeenCalled();
    });
  });

  describe('DELETE /teams/:id', () => {
    it('should delete a team', async () => {
      teamProfileService.deleteTeam = jest.fn().mockResolvedValue(undefined);
      await controller.deleteTeam('team_1');
      expect(teamProfileService.deleteTeam).toHaveBeenCalledWith('team_1');
    });
  });

  describe('GET /teams/:id/collaboration', () => {
    it('should return collaboration pairs', async () => {
      const result = await controller.getTeamCollaboration('team_1');
      expect(result).toHaveLength(1);
      expect(result[0].successRate).toBe(0.9);
      expect(teamProfileService.getTeam).toHaveBeenCalledWith('team_1');
      expect(teamProfileService.getCollaborationPairs).toHaveBeenCalledWith([
        'a',
        'b',
      ]);
    });
  });

  // === Existing tests ===

  describe('POST /task-completions', () => {
    it('should create a task completion', async () => {
      const result = await controller.createTaskCompletion({
        taskId: 'task-1',
        delegatedTo: 'agent-a',
        delegatedBy: 'agent-b',
        taskDescription: 'Test task',
        outcome: TaskOutcome.SUCCESS,
        durationMs: 5000,
      });

      expect(result).toEqual({ id: 'tc_1' });
      expect(taskCompletionService.create).toHaveBeenCalled();
    });
  });

  describe('GET /task-completions', () => {
    it('should query completions', async () => {
      const result = await controller.queryTaskCompletions({
        agentId: 'agent-a',
      });

      expect(result).toEqual([]);
      expect(taskCompletionService.query).toHaveBeenCalledWith({
        agentId: 'agent-a',
      });
    });
  });

  describe('GET /delegation-templates', () => {
    it('should return delegation template', async () => {
      const result = await controller.getDelegationTemplates('Build auth');

      expect('suggestedAgent' in result && result.suggestedAgent).toBe(
        'agent-a',
      );
      expect(delegationTemplateService.suggest).toHaveBeenCalledWith(
        'Build auth',
      );
    });

    it('should return error when no taskDescription', async () => {
      const result = await controller.getDelegationTemplates('');

      expect(result).toEqual({
        error: 'taskDescription query parameter is required',
      });
    });
  });

  describe('GET /agents/:id/trust-profile', () => {
    it('should return trust profile', async () => {
      const result = await controller.getTrustProfile('agent-a');

      expect(result.agentId).toBe('agent-a');
      expect(trustProfileService.getProfile).toHaveBeenCalledWith('agent-a');
    });
  });
});

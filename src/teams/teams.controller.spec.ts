import { TeamsController } from './teams.controller';
import { TeamsService } from './teams.service';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockTeamsService = {
  create: jest.fn(),
  findAll: jest.fn(),
  findOne: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
  addMember: jest.fn(),
  removeMember: jest.fn(),
  recordCollaboration: jest.fn(),
  getCollaborations: jest.fn(),
};

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('TeamsController', () => {
  let controller: TeamsController;

  const userId = 'user-1';
  const teamId = 'team-1';
  const now = new Date('2026-01-01');

  const mockTeam = {
    id: teamId,
    name: 'Alpha Team',
    description: 'Test team',
    userId,
    sharedCapabilities: ['code_review'],
    trustScore: 0.85,
    collaborationCount: 5,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    members: [],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new TeamsController(
      mockTeamsService as unknown as TeamsService,
    );
  });

  // ── Guard enforcement ──────────────────────────────────────────────────────

  describe('Guard enforcement', () => {
    it('should apply ApiKeyOrJwtGuard at class level', () => {
      const guards: any[] =
        Reflect.getMetadata('__guards__', TeamsController) ?? [];
      const names = guards.map((g) =>
        typeof g === 'function' ? g.name : g?.constructor?.name,
      );
      expect(names).toContain(ApiKeyOrJwtGuard.name);
    });

    it('should apply RateLimitGuard at class level', () => {
      const guards: any[] =
        Reflect.getMetadata('__guards__', TeamsController) ?? [];
      const names = guards.map((g) =>
        typeof g === 'function' ? g.name : g?.constructor?.name,
      );
      expect(names).toContain(RateLimitGuard.name);
    });
  });

  // ── create ─────────────────────────────────────────────────────────────────

  describe('create', () => {
    const dto = { name: 'Alpha Team', description: 'Test' } as any;

    it('should create and return a team', async () => {
      mockTeamsService.create.mockResolvedValue(mockTeam);
      const result = await controller.create(userId, dto);
      expect(result).toEqual(mockTeam);
      expect(mockTeamsService.create).toHaveBeenCalledWith(userId, dto);
    });

    it('should propagate service errors', async () => {
      mockTeamsService.create.mockRejectedValue(new Error('create failed'));
      await expect(controller.create(userId, dto)).rejects.toThrow(
        'create failed',
      );
    });
  });

  // ── findAll ────────────────────────────────────────────────────────────────

  describe('findAll', () => {
    it('should return all teams for user', async () => {
      mockTeamsService.findAll.mockResolvedValue([mockTeam]);
      const result = await controller.findAll(userId);
      expect(result).toEqual([mockTeam]);
      expect(mockTeamsService.findAll).toHaveBeenCalledWith(userId);
    });

    it('should return empty array when user has no teams', async () => {
      mockTeamsService.findAll.mockResolvedValue([]);
      const result = await controller.findAll(userId);
      expect(result).toEqual([]);
    });

    it('should propagate errors', async () => {
      mockTeamsService.findAll.mockRejectedValue(new Error('db error'));
      await expect(controller.findAll(userId)).rejects.toThrow('db error');
    });
  });

  // ── findOne ────────────────────────────────────────────────────────────────

  describe('findOne', () => {
    it('should return a single team', async () => {
      mockTeamsService.findOne.mockResolvedValue(mockTeam);
      const result = await controller.findOne(userId, teamId);
      expect(result).toEqual(mockTeam);
      expect(mockTeamsService.findOne).toHaveBeenCalledWith(userId, teamId);
    });

    it('should propagate NotFoundException from service', async () => {
      const { NotFoundException } = require('@nestjs/common');
      mockTeamsService.findOne.mockRejectedValue(
        new NotFoundException('Team not found'),
      );
      await expect(controller.findOne(userId, 'nonexistent')).rejects.toThrow(
        'Team not found',
      );
    });
  });

  // ── update ─────────────────────────────────────────────────────────────────

  describe('update', () => {
    const dto = { name: 'Updated Team' } as any;

    it('should update and return the team', async () => {
      const updated = { ...mockTeam, name: 'Updated Team' };
      mockTeamsService.update.mockResolvedValue(updated);
      const result = await controller.update(userId, teamId, dto);
      expect(result).toEqual(updated);
      expect(mockTeamsService.update).toHaveBeenCalledWith(userId, teamId, dto);
    });

    it('should propagate service errors', async () => {
      mockTeamsService.update.mockRejectedValue(new Error('update failed'));
      await expect(controller.update(userId, teamId, dto)).rejects.toThrow(
        'update failed',
      );
    });
  });

  // ── remove ─────────────────────────────────────────────────────────────────

  describe('remove', () => {
    it('should soft delete team', async () => {
      const softDeleted = { ...mockTeam, deletedAt: now };
      mockTeamsService.remove.mockResolvedValue(softDeleted);
      const result = await controller.remove(userId, teamId);
      expect(result).toEqual(softDeleted);
      expect(mockTeamsService.remove).toHaveBeenCalledWith(userId, teamId);
    });

    it('should propagate errors', async () => {
      mockTeamsService.remove.mockRejectedValue(new Error('delete failed'));
      await expect(controller.remove(userId, teamId)).rejects.toThrow(
        'delete failed',
      );
    });
  });

  // ── addMember ──────────────────────────────────────────────────────────────

  describe('addMember', () => {
    const dto = { agentId: 'agent-x', role: 'contributor' } as any;
    const member = {
      id: 'mem-1',
      teamId,
      agentId: 'agent-x',
      role: 'contributor',
      joinedAt: now,
    };

    it('should add and return member', async () => {
      mockTeamsService.addMember.mockResolvedValue(member);
      const result = await controller.addMember(userId, teamId, dto);
      expect(result).toEqual(member);
      expect(mockTeamsService.addMember).toHaveBeenCalledWith(
        userId,
        teamId,
        dto,
      );
    });

    it('should propagate errors', async () => {
      mockTeamsService.addMember.mockRejectedValue(
        new Error('member add failed'),
      );
      await expect(controller.addMember(userId, teamId, dto)).rejects.toThrow(
        'member add failed',
      );
    });
  });

  // ── removeMember ───────────────────────────────────────────────────────────

  describe('removeMember', () => {
    const memberId = 'mem-1';

    it('should remove member and return result', async () => {
      const removed = { id: memberId, teamId, agentId: 'agent-x' };
      mockTeamsService.removeMember.mockResolvedValue(removed);
      const result = await controller.removeMember(userId, teamId, memberId);
      expect(result).toEqual(removed);
      expect(mockTeamsService.removeMember).toHaveBeenCalledWith(
        userId,
        teamId,
        memberId,
      );
    });

    it('should propagate errors', async () => {
      mockTeamsService.removeMember.mockRejectedValue(new Error('not found'));
      await expect(
        controller.removeMember(userId, teamId, memberId),
      ).rejects.toThrow('not found');
    });
  });

  // ── recordCollaboration ────────────────────────────────────────────────────

  describe('recordCollaboration', () => {
    const dto = {
      taskDescription: 'Fix bug',
      participantAgentIds: ['agent-a', 'agent-b'],
      outcome: 'success',
      score: 0.9,
    } as any;

    const collab = { id: 'collab-1', teamId, ...dto, createdAt: now };

    it('should record and return collaboration', async () => {
      mockTeamsService.recordCollaboration.mockResolvedValue(collab);
      const result = await controller.recordCollaboration(userId, teamId, dto);
      expect(result).toEqual(collab);
      expect(mockTeamsService.recordCollaboration).toHaveBeenCalledWith(
        userId,
        teamId,
        dto,
      );
    });

    it('should propagate errors', async () => {
      mockTeamsService.recordCollaboration.mockRejectedValue(
        new Error('collab error'),
      );
      await expect(
        controller.recordCollaboration(userId, teamId, dto),
      ).rejects.toThrow('collab error');
    });
  });

  // ── getCollaborations ──────────────────────────────────────────────────────

  describe('getCollaborations', () => {
    const collabs = [
      { id: 'c1', teamId, taskDescription: 'Task A', createdAt: now },
      { id: 'c2', teamId, taskDescription: 'Task B', createdAt: now },
    ];

    it('should return collaborations with default limit 50', async () => {
      mockTeamsService.getCollaborations.mockResolvedValue(collabs);
      const result = await controller.getCollaborations(userId, teamId);
      expect(result).toEqual(collabs);
      expect(mockTeamsService.getCollaborations).toHaveBeenCalledWith(
        userId,
        teamId,
        50,
      );
    });

    it('should parse and pass custom limit', async () => {
      mockTeamsService.getCollaborations.mockResolvedValue(collabs);
      await controller.getCollaborations(userId, teamId, '20');
      expect(mockTeamsService.getCollaborations).toHaveBeenCalledWith(
        userId,
        teamId,
        20,
      );
    });

    it('should return empty array when no collaborations', async () => {
      mockTeamsService.getCollaborations.mockResolvedValue([]);
      const result = await controller.getCollaborations(userId, teamId);
      expect(result).toEqual([]);
    });

    it('should propagate errors', async () => {
      mockTeamsService.getCollaborations.mockRejectedValue(
        new Error('collab fetch error'),
      );
      await expect(
        controller.getCollaborations(userId, teamId),
      ).rejects.toThrow('collab fetch error');
    });
  });
});

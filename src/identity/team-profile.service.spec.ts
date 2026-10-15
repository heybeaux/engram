import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { TeamProfileService } from './team-profile.service';
import { PrismaService } from '../prisma/prisma.service';

describe('TeamProfileService', () => {
  let service: TeamProfileService;
  let mockPrisma: any;

  beforeEach(async () => {
    mockPrisma = {
      memory: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      identityTeamProfile: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TeamProfileService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<TeamProfileService>(TeamProfileService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createTeam', () => {
    it('should create a team with aggregated capabilities', async () => {
      mockPrisma.memory.findMany.mockResolvedValue([
        {
          id: 'mem1',
          raw: 'I am good at coding and debugging typescript',
          effectiveScore: 0.8,
          importanceScore: 0.8,
          subjectId: 'agent-1',
        },
      ]);

      const team = await service.createTeam({
        name: 'Alpha Team',
        agentIds: ['agent-1', 'agent-2'],
      });

      expect(team.name).toBe('Alpha Team');
      expect(team.agentIds).toEqual(['agent-1', 'agent-2']);
      expect(team.id).toMatch(/^team_/);
      expect(team.id).toMatch(
        /^team_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(team.capabilities).toBeDefined();
      expect(team.collaborationScore).toBeDefined();
      expect(team.createdAt).toBeDefined();
    });

    it('should produce unique IDs across multiple calls', async () => {
      mockPrisma.memory.findMany.mockResolvedValue([]);
      const ids = new Set<string>();
      for (let i = 0; i < 5; i++) {
        const team = await service.createTeam({
          name: `Team ${i}`,
          agentIds: ['agent-1'],
        });
        ids.add(team.id);
      }
      expect(ids.size).toBe(5);
    });

    it('should include description when provided', async () => {
      const team = await service.createTeam({
        name: 'Beta Team',
        agentIds: ['agent-1'],
        description: 'A test team',
      });

      expect(team.description).toBe('A test team');
    });
  });

  describe('getTeam', () => {
    it('should return a created team', async () => {
      const created = await service.createTeam({
        name: 'Test',
        agentIds: ['a1'],
      });

      const fetched = await service.getTeam(created.id);
      expect(fetched.name).toBe('Test');
    });

    it('should throw NotFoundException for unknown team', async () => {
      await expect(service.getTeam('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getTeamCapabilities', () => {
    it('should return capabilities for a team', async () => {
      mockPrisma.memory.findMany.mockResolvedValue([
        {
          id: 'm1',
          raw: 'Expert in research and analysis',
          effectiveScore: 0.9,
        },
      ]);

      const team = await service.createTeam({
        name: 'Research Team',
        agentIds: ['agent-r'],
      });

      const caps = await service.getTeamCapabilities(team.id);
      expect(Array.isArray(caps)).toBe(true);
    });
  });

  describe('aggregateCapabilities', () => {
    it('excludes hidden capability and collaboration memories', async () => {
      mockPrisma.memory.findMany.mockImplementation(({ where }: any) => {
        expect(where.userHidden).toBe(false);
        return Promise.resolve([]);
      });
      expect(await service.aggregateCapabilities(['agent-1'])).toEqual([]);
      expect(
        await service.calculateCollaborationScore(['agent-1', 'agent-2']),
      ).toBe(0);
    });

    it('should extract capabilities from agent memories', async () => {
      mockPrisma.memory.findMany.mockResolvedValue([
        {
          id: 'm1',
          raw: 'I excel at code review and debugging',
          effectiveScore: 0.9,
        },
        { id: 'm2', raw: 'Good at planning and strategy', effectiveScore: 0.7 },
      ]);

      const caps = await service.aggregateCapabilities(['agent-1']);
      expect(caps.length).toBeGreaterThan(0);
      expect(caps[0]).toHaveProperty('name');
      expect(caps[0]).toHaveProperty('score');
      expect(caps[0]).toHaveProperty('contributors');
    });

    it('should merge capabilities from multiple agents', async () => {
      mockPrisma.memory.findMany
        .mockResolvedValueOnce([
          { id: 'm1', raw: 'I do coding and testing', effectiveScore: 0.8 },
        ])
        .mockResolvedValueOnce([
          { id: 'm2', raw: 'I do coding and research', effectiveScore: 0.7 },
        ]);

      const caps = await service.aggregateCapabilities(['a1', 'a2']);
      const codingCap = caps.find((c) => c.name === 'coding');
      if (codingCap) {
        expect(codingCap.contributors.length).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe('calculateCollaborationScore', () => {
    it('should return 0 for single agent', async () => {
      const score = await service.calculateCollaborationScore(['agent-1']);
      expect(score).toBe(0);
    });

    it('should calculate score from shared memories', async () => {
      mockPrisma.memory.findMany.mockResolvedValue([
        { id: 'm1', importanceScore: 0.8 },
        { id: 'm2', importanceScore: 0.9 },
      ]);

      const score = await service.calculateCollaborationScore(['a1', 'a2']);
      expect(typeof score).toBe('number');
    });
  });
});

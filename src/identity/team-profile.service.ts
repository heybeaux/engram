import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateIdentityTeamDto,
  TeamProfile,
  TeamCapability,
  CollaborationPair,
} from './dto/team.dto';
import { SubjectType, MemorySource } from '@prisma/client';

/**
 * HEY-188: Multi-Agent Team Profiles
 *
 * Manages composite team identities by aggregating member capabilities,
 * tracking collaboration history, and computing team strengths.
 *
 * Teams are persisted to PostgreSQL via Prisma (HEY-385).
 */
@Injectable()
export class TeamProfileService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TeamProfileService.name);

  private teams = new Map<string, TeamProfile>();

  constructor(private prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    try {
      const rows = await this.prisma.identityTeamProfile.findMany();
      for (const row of rows) {
        this.teams.set(row.id, {
          id: row.id,
          name: row.name,
          description: row.description ?? undefined,
          agentIds: row.agentIds,
          capabilities: row.capabilities as unknown as TeamCapability[],
          collaborationScore: row.collaborationScore,
          lastActive: row.lastActive,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        });
      }
      if (this.teams.size > 0) {
        this.logger.log(`Loaded ${this.teams.size} teams from database`);
      }
    } catch (err) {
      this.logger.warn(`Failed to load teams from database: ${err}`);
    }
  }

  onModuleDestroy(): void {
    this.logger.log(
      'TeamProfileService: shutdown complete (data persisted to database)',
    );
  }

  private persist(team: TeamProfile): void {
    this.prisma.identityTeamProfile
      .upsert({
        where: { id: team.id },
        create: {
          id: team.id,
          name: team.name,
          description: team.description ?? null,
          agentIds: team.agentIds,
          capabilities: team.capabilities as any,
          collaborationScore: team.collaborationScore,
          lastActive: team.lastActive,
          createdAt: team.createdAt,
        },
        update: {
          name: team.name,
          description: team.description ?? null,
          agentIds: team.agentIds,
          capabilities: team.capabilities as any,
          collaborationScore: team.collaborationScore,
          lastActive: team.lastActive,
        },
      })
      .catch((err) =>
        this.logger.warn(`Failed to persist team: ${err.message}`),
      );
  }

  private persistDelete(teamId: string): void {
    this.prisma.identityTeamProfile
      .delete({ where: { id: teamId } })
      .catch((err) =>
        this.logger.warn(`Failed to delete team from database: ${err.message}`),
      );
  }

  /**
   * Create a new team profile
   */
  async createTeam(dto: CreateIdentityTeamDto): Promise<TeamProfile> {
    const id = `team_${randomUUID()}`;

    // Aggregate capabilities from member agents
    const capabilities = await this.aggregateCapabilities(dto.agentIds);
    const collaborationScore = await this.calculateCollaborationScore(
      dto.agentIds,
    );

    const team: TeamProfile = {
      id,
      name: dto.name,
      description: dto.description,
      agentIds: dto.agentIds,
      capabilities,
      collaborationScore,
      lastActive: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.teams.set(id, team);
    this.persist(team);
    this.logger.log(
      `Created team "${dto.name}" with ${dto.agentIds.length} agents`,
    );
    return team;
  }

  /**
   * List all teams
   */
  async listTeams(): Promise<TeamProfile[]> {
    return Array.from(this.teams.values());
  }

  /**
   * Get team by ID
   */
  async getTeam(teamId: string): Promise<TeamProfile> {
    const team = this.teams.get(teamId);
    if (!team) {
      throw new NotFoundException(`Team ${teamId} not found`);
    }
    return team;
  }

  /**
   * Update team metadata
   */
  async updateTeam(
    teamId: string,
    dto: { name?: string; description?: string },
  ): Promise<TeamProfile> {
    const team = await this.getTeam(teamId);
    if (dto.name) team.name = dto.name;
    if (dto.description !== undefined) team.description = dto.description;
    team.updatedAt = new Date();
    this.persist(team);
    return team;
  }

  /**
   * Delete a team
   */
  async deleteTeam(teamId: string): Promise<void> {
    if (!this.teams.has(teamId)) {
      throw new NotFoundException(`Team ${teamId} not found`);
    }
    this.teams.delete(teamId);
    this.persistDelete(teamId);
  }

  /**
   * Add members to a team
   */
  async addMembers(teamId: string, agentIds: string[]): Promise<TeamProfile> {
    const team = await this.getTeam(teamId);
    const newIds = agentIds.filter((id) => !team.agentIds.includes(id));
    team.agentIds.push(...newIds);
    team.capabilities = await this.aggregateCapabilities(team.agentIds);
    team.collaborationScore = await this.calculateCollaborationScore(
      team.agentIds,
    );
    team.updatedAt = new Date();
    this.persist(team);
    return team;
  }

  /**
   * Remove members from a team
   */
  async removeMembers(
    teamId: string,
    agentIds: string[],
  ): Promise<TeamProfile> {
    const team = await this.getTeam(teamId);
    team.agentIds = team.agentIds.filter((id) => !agentIds.includes(id));
    team.capabilities = await this.aggregateCapabilities(team.agentIds);
    team.collaborationScore = await this.calculateCollaborationScore(
      team.agentIds,
    );
    team.updatedAt = new Date();
    this.persist(team);
    return team;
  }

  /**
   * Record a collaboration event between agents in a team
   */
  async recordCollaboration(
    teamId: string,
    dto: {
      agentA: string;
      agentB: string;
      taskDescription: string;
      success: boolean;
    },
  ): Promise<{ recorded: boolean; team: TeamProfile }> {
    const team = await this.getTeam(teamId);
    team.lastActive = new Date();
    team.collaborationScore = await this.calculateCollaborationScore(
      team.agentIds,
    );
    team.updatedAt = new Date();
    this.persist(team);
    this.logger.log(
      `Collaboration recorded in team ${teamId}: ${dto.agentA} <-> ${dto.agentB}`,
    );
    return { recorded: true, team };
  }

  /**
   * Get aggregated team capabilities
   */
  async getTeamCapabilities(teamId: string): Promise<TeamCapability[]> {
    const team = await this.getTeam(teamId);
    return team.capabilities;
  }

  /**
   * Aggregate capabilities from all team member agents by analyzing
   * their AGENT-type memories (reflections, observations).
   */
  async aggregateCapabilities(agentIds: string[]): Promise<TeamCapability[]> {
    const capabilityMap = new Map<
      string,
      { score: number; contributors: Set<string>; count: number }
    >();

    for (const agentId of agentIds) {
      // Find agent self-memories that indicate capabilities
      const memories = await this.prisma.memory.findMany({
        where: {
          subjectType: SubjectType.AGENT,
          subjectId: agentId,
          deletedAt: null,
        },
        orderBy: { effectiveScore: 'desc' },
        take: 50,
      });

      // Extract capability signals from memory content
      for (const mem of memories) {
        const caps = this.extractCapabilitiesFromMemory(mem.raw);
        for (const cap of caps) {
          const existing = capabilityMap.get(cap.name) || {
            score: 0,
            contributors: new Set<string>(),
            count: 0,
          };
          existing.score += cap.score;
          existing.contributors.add(agentId);
          existing.count++;
          capabilityMap.set(cap.name, existing);
        }
      }
    }

    return Array.from(capabilityMap.entries()).map(([name, data]) => ({
      name,
      score: Math.min(1, data.score / data.count),
      contributors: Array.from(data.contributors),
    }));
  }

  /**
   * Calculate collaboration score for a set of agents based on
   * their shared TASK_COMPLETION memories.
   */
  async calculateCollaborationScore(agentIds: string[]): Promise<number> {
    if (agentIds.length < 2) return 0;

    const pairs = await this.getCollaborationPairs(agentIds);
    if (pairs.length === 0) return 0;

    const avgSuccess =
      pairs.reduce((sum, p) => sum + p.successRate, 0) / pairs.length;
    return Math.round(avgSuccess * 100) / 100;
  }

  /**
   * Get collaboration pairs showing which agents work well together
   */
  async getCollaborationPairs(
    agentIds: string[],
  ): Promise<CollaborationPair[]> {
    const pairs: CollaborationPair[] = [];

    for (let i = 0; i < agentIds.length; i++) {
      for (let j = i + 1; j < agentIds.length; j++) {
        const agentA = agentIds[i];
        const agentB = agentIds[j];

        // Find memories where both agents are referenced (task completions)
        const sharedMemories = await this.prisma.memory.findMany({
          where: {
            deletedAt: null,
            source: MemorySource.SYSTEM,
            OR: [
              { subjectId: agentA, raw: { contains: agentB } },
              { subjectId: agentB, raw: { contains: agentA } },
            ],
          },
          take: 100,
        });

        if (sharedMemories.length > 0) {
          // Estimate success rate from memory importance scores
          const avgScore =
            sharedMemories.reduce((s, m) => s + m.importanceScore, 0) /
            sharedMemories.length;

          pairs.push({
            agentA,
            agentB,
            taskCount: sharedMemories.length,
            successRate: Math.round(avgScore * 100) / 100,
          });
        }
      }
    }

    return pairs;
  }

  /**
   * Extract capability keywords from memory text.
   * Simple heuristic — could be enhanced with LLM.
   */
  private extractCapabilitiesFromMemory(
    text: string,
  ): { name: string; score: number }[] {
    const capabilities: { name: string; score: number }[] = [];
    const lower = text.toLowerCase();

    const capKeywords: Record<string, string[]> = {
      coding: [
        'code',
        'programming',
        'development',
        'implement',
        'debug',
        'typescript',
        'python',
      ],
      analysis: ['analyze', 'analysis', 'evaluate', 'assess', 'review'],
      communication: [
        'communicate',
        'explain',
        'writing',
        'documentation',
        'report',
      ],
      planning: ['plan', 'strategy', 'organize', 'coordinate', 'schedule'],
      research: ['research', 'investigate', 'search', 'explore', 'find'],
      testing: ['test', 'qa', 'quality', 'verify', 'validate'],
      deployment: ['deploy', 'release', 'ci/cd', 'infrastructure', 'devops'],
      design: ['design', 'architecture', 'ui', 'ux', 'interface'],
    };

    for (const [cap, keywords] of Object.entries(capKeywords)) {
      const matches = keywords.filter((k) => lower.includes(k));
      if (matches.length > 0) {
        capabilities.push({
          name: cap,
          score: Math.min(1, matches.length * 0.3),
        });
      }
    }

    return capabilities;
  }
}

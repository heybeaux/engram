import {
  Controller,
  Post,
  Get,
  Put,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Req,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { PrismaService } from '../prisma/prisma.service';
import { TeamProfileService } from './team-profile.service';
import { DelegationRecallService } from './delegation-recall.service';
import { PortableIdentityService } from './portable-identity.service';
import { TaskCompletionService } from './task-completion.service';
import { DelegationTemplateService } from './delegation-template.service';
import { TrustProfileService } from './trust-profile.service';
import { DelegationContractService } from './delegation-contract.service';
import { ChallengeService } from './challenge.service';
import { IdentityService } from './identity.service';
import { CreateTeamDto } from './dto/team.dto';
import { ImportIdentityDto } from './dto/portable-identity.dto';
import {
  CreateTaskCompletionDto,
  QueryTaskCompletionsDto,
} from './dto/task-completion.dto';
import {
  CreateDelegationContractDto,
  UpdateDelegationContractDto,
  CompleteContractRequestDto,
} from './dto/delegation-contract.dto';
import {
  CreateChallengeRequestDto,
  ResolveChallengeRequestDto,
} from './dto/challenge.dto';

@ApiTags('identity')
@UseGuards(ApiKeyOrJwtGuard)
@Controller('v1/identity')
export class IdentityController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly teamProfileService: TeamProfileService,
    private readonly delegationRecallService: DelegationRecallService,
    private readonly portableIdentityService: PortableIdentityService,
    private readonly taskCompletionService: TaskCompletionService,
    private readonly delegationTemplateService: DelegationTemplateService,
    private readonly trustProfileService: TrustProfileService,
    private readonly delegationContractService: DelegationContractService,
    private readonly challengeService: ChallengeService,
    private readonly identityService: IdentityService,
  ) {}

  // === Bootstrap Endpoint ===

  @Get('bootstrap')
  @ApiOperation({
    summary: 'Bootstrap identity data for agent/user pair',
  })
  @ApiQuery({ name: 'agentId', required: false, description: 'Agent ID' })
  @ApiQuery({ name: 'userId', required: false, description: 'User ID' })
  async bootstrap(
    @Query('agentId') agentId?: string,
    @Query('userId') userId?: string,
  ) {
    return this.identityService.bootstrap(agentId, userId);
  }

  // === Agents list with capability & trust summaries ===

  @Get('agents')
  @ApiOperation({
    summary: 'List all agents with capability profiles and trust summaries',
  })
  async listAgents(@Req() req: any) {
    const accountId = req.accountId;
    const agentFromReq = req.agent;

    // Find agents: scoped to account if available, otherwise just the authenticated agent
    let agents: any[];
    if (accountId) {
      agents = await this.prisma.agent.findMany({
        where: { accountId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          name: true,
          apiKeyHint: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    } else if (agentFromReq) {
      agents = [
        {
          id: agentFromReq.id,
          name: agentFromReq.name,
          apiKeyHint: agentFromReq.apiKeyHint,
          createdAt: agentFromReq.createdAt,
          updatedAt: agentFromReq.updatedAt,
        },
      ];
    } else {
      return { agents: [] };
    }

    // Enrich each agent with capability profiles and trust summaries
    const enriched = await Promise.all(
      agents.map(async (agent) => {
        // Capability profiles
        const capabilities = await this.prisma.agentCapabilityProfile
          ?.findMany?.({
            where: { agentId: agent.id },
            orderBy: { confidence: 'desc' },
            take: 10,
            select: {
              capability: true,
              confidence: true,
              evidenceCount: true,
              lastUsedAt: true,
            },
          })
          .catch(() => []);

        // Trust summary from TrustProfileService
        let trustSummary: any = null;
        try {
          trustSummary = await this.trustProfileService.getProfile(agent.id);
        } catch {
          trustSummary = null;
        }

        // Memory count and last active
        // Memories link to users via userId; users link to agents via agentId
        // First get all userIds for this agent, then count their memories
        let memoryCount = 0;
        let lastActive: Date | null = null;
        try {
          const agentUsers = await this.prisma.user.findMany({
            where: { agentId: agent.id },
            select: { id: true },
          });
          const userIds = agentUsers.map((u) => u.id);
          if (userIds.length > 0) {
            memoryCount = await this.prisma.memory.count({
              where: { userId: { in: userIds }, deletedAt: null },
            });
            const lastMemory = await this.prisma.memory.findFirst({
              where: { userId: { in: userIds }, deletedAt: null },
              orderBy: { createdAt: 'desc' },
              select: { createdAt: true },
            });
            lastActive = lastMemory?.createdAt || null;
          }
        } catch {
          // Fallback to defaults
        }

        return {
          id: agent.id,
          name: agent.name,
          apiKeyHint: agent.apiKeyHint,
          createdAt: agent.createdAt,
          updatedAt: agent.updatedAt,
          memoryCount,
          lastActive,
          capabilities: capabilities || [],
          trustSummary,
        };
      }),
    );

    return { agents: enriched };
  }

  // === Get single agent by ID ===

  @Get('agents/:id')
  @ApiOperation({
    summary: 'Get a single agent with capability profiles and trust summary',
  })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  async getAgent(@Param('id') id: string, @Req() req: any) {
    const accountId = req.accountId;
    const agentFromReq = req.agent;

    // Find the agent, scoped to account
    const where: any = { id, deletedAt: null };
    if (accountId) {
      where.accountId = accountId;
    } else if (agentFromReq && agentFromReq.id !== id) {
      return { statusCode: 404, message: 'Agent not found' };
    }

    const agent = await this.prisma.agent.findFirst({
      where,
      select: {
        id: true,
        name: true,
        apiKeyHint: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!agent) {
      return { statusCode: 404, message: 'Agent not found' };
    }

    // Enrich with capabilities and trust summary
    const capabilities = await this.prisma.agentCapabilityProfile
      ?.findMany?.({
        where: { agentId: agent.id },
        orderBy: { confidence: 'desc' },
        take: 10,
        select: {
          capability: true,
          confidence: true,
          evidenceCount: true,
          lastUsedAt: true,
        },
      })
      .catch(() => []);

    let trustSummary: any = null;
    try {
      trustSummary = await this.trustProfileService.getProfile(agent.id);
    } catch {
      trustSummary = null;
    }

    return {
      id: agent.id,
      name: agent.name,
      apiKeyHint: agent.apiKeyHint,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
      capabilities: (capabilities || []).map((c: any) => c.capability),
      trustSummary,
    };
  }

  // === HEY-281: Delegation Contracts CRUD ===

  @Post('contracts')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a delegation contract' })
  async createContract(@Body() dto: CreateDelegationContractDto) {
    return this.delegationContractService.create(dto);
  }

  @Get('contracts')
  @ApiOperation({ summary: 'List delegation contracts' })
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'Filter by status',
  })
  @ApiQuery({
    name: 'agentId',
    required: false,
    description: 'Filter by delegated agent ID',
  })
  @ApiQuery({
    name: 'isTemplate',
    required: false,
    description: 'Filter by template flag',
  })
  async listContracts(
    @Query('status') status?: string,
    @Query('agentId') agentId?: string,
    @Query('isTemplate') isTemplate?: string,
  ) {
    let contracts = this.delegationContractService.listAll();
    if (status) {
      contracts = contracts.filter((c) => c.status === status);
    }
    if (agentId) {
      contracts = contracts.filter((c) => c.delegatedTo === agentId);
    }
    if (isTemplate !== undefined) {
      const flag = isTemplate === 'true';
      contracts = contracts.filter((c) => (c as any).isTemplate === flag);
    }
    return { contracts };
  }

  @Get('contracts/:id')
  @ApiOperation({ summary: 'Get a delegation contract by ID' })
  @ApiParam({ name: 'id', description: 'Contract ID' })
  async getContract(@Param('id') id: string) {
    return this.delegationContractService.getById(id);
  }

  @Put('contracts/:id')
  @ApiOperation({ summary: 'Update a delegation contract' })
  @ApiParam({ name: 'id', description: 'Contract ID' })
  async updateContract(
    @Param('id') id: string,
    @Body() dto: UpdateDelegationContractDto,
  ) {
    return this.delegationContractService.update(id, dto);
  }

  @Post('contracts/:id/complete')
  @ApiOperation({ summary: 'Complete or fail a delegation contract' })
  @ApiParam({ name: 'id', description: 'Contract ID' })
  async completeContract(
    @Param('id') id: string,
    @Body() dto: CompleteContractRequestDto,
  ) {
    return this.delegationContractService.complete(id, dto);
  }

  // === HEY-282: Challenges CRUD ===

  @Post('challenges')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a challenge' })
  async createChallenge(@Body() dto: CreateChallengeRequestDto) {
    return this.challengeService.create(dto);
  }

  @Get('challenges')
  @ApiOperation({ summary: 'List challenges' })
  @ApiQuery({
    name: 'contractId',
    required: false,
    description: 'Filter by contract ID',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'Filter by resolution status (open/resolved/dismissed)',
  })
  @ApiQuery({
    name: 'type',
    required: false,
    description: 'Filter by challenge type',
  })
  async listChallenges(
    @Query('contractId') contractId?: string,
    @Query('status') status?: string,
    @Query('type') type?: string,
  ) {
    let challenges = this.challengeService.listAll({ contractId });
    if (status === 'resolved') {
      challenges = challenges.filter((c) => c.resolution != null);
    } else if (status === 'unresolved' || status === 'open') {
      challenges = challenges.filter((c) => c.resolution == null);
    } else if (status === 'dismissed') {
      challenges = challenges.filter((c) => c.resolution === 'dismissed');
    }
    if (type) {
      challenges = challenges.filter((c) => c.challengeType === type);
    }
    return { challenges };
  }

  @Get('challenges/:id')
  @ApiOperation({ summary: 'Get a challenge by ID' })
  @ApiParam({ name: 'id', description: 'Challenge ID' })
  async getChallenge(@Param('id') id: string) {
    return this.challengeService.getById(id);
  }

  @Post('challenges/:id/resolve')
  @ApiOperation({ summary: 'Resolve a challenge' })
  @ApiParam({ name: 'id', description: 'Challenge ID' })
  async resolveChallenge(
    @Param('id') id: string,
    @Body() dto: ResolveChallengeRequestDto,
  ) {
    return this.challengeService.resolve(id, dto);
  }

  // === HEY-283: Team Endpoints ===

  @Get('teams')
  @ApiOperation({ summary: 'List all teams' })
  async listTeams() {
    return this.teamProfileService.listTeams();
  }

  @Post('teams')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a team profile' })
  async createTeam(@Body() dto: CreateTeamDto) {
    return this.teamProfileService.createTeam(dto);
  }

  @Get('teams/:id')
  @ApiOperation({ summary: 'Get a team profile' })
  @ApiParam({ name: 'id', description: 'Team ID' })
  async getTeam(@Param('id') id: string) {
    return this.teamProfileService.getTeam(id);
  }

  @Delete('teams/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a team' })
  @ApiParam({ name: 'id', description: 'Team ID' })
  async deleteTeam(@Param('id') id: string) {
    await this.teamProfileService.deleteTeam(id);
  }

  @Get('teams/:id/capabilities')
  @ApiOperation({ summary: 'Get aggregated team capabilities' })
  @ApiParam({ name: 'id', description: 'Team ID' })
  async getTeamCapabilities(@Param('id') id: string) {
    return this.teamProfileService.getTeamCapabilities(id);
  }

  @Get('teams/:id/collaboration')
  @ApiOperation({ summary: 'Get collaboration pair scores for a team' })
  @ApiParam({ name: 'id', description: 'Team ID' })
  async getTeamCollaboration(@Param('id') id: string) {
    const team = await this.teamProfileService.getTeam(id);
    return this.teamProfileService.getCollaborationPairs(team.agentIds);
  }

  // === HEY-182: Task Completion Tracking ===

  @Post('task-completions')
  @HttpCode(201)
  @ApiOperation({ summary: 'Record a task completion' })
  async createTaskCompletion(@Body() dto: CreateTaskCompletionDto) {
    return this.taskCompletionService.create(dto);
  }

  @Get('task-completions')
  @ApiOperation({ summary: 'Query task completions' })
  @ApiQuery({ name: 'agentId', required: false })
  @ApiQuery({ name: 'taskId', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  async queryTaskCompletions(@Query() query: QueryTaskCompletionsDto) {
    return this.taskCompletionService.query(query);
  }

  // === HEY-183: Delegation Templates ===

  @Get('delegation-templates')
  @ApiOperation({ summary: 'Get delegation template suggestions for a task' })
  @ApiQuery({
    name: 'taskDescription',
    description: 'Task to get suggestions for',
    required: true,
  })
  async getDelegationTemplates(
    @Query('taskDescription') taskDescription: string,
  ) {
    if (!taskDescription) {
      return { error: 'taskDescription query parameter is required' };
    }
    return this.delegationTemplateService.suggest(taskDescription);
  }

  // === HEY-284: Trust History + Bulk Trust ===

  @Get('agents/:id/trust-history')
  @ApiOperation({ summary: 'Get trust score history for an agent over time' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  @ApiQuery({
    name: 'days',
    required: false,
    type: Number,
    description: 'Number of days of history (default 30)',
  })
  async getTrustHistory(
    @Param('id') agentId: string,
    @Query('days') days?: string,
  ) {
    return this.trustProfileService.getTrustHistory(
      agentId,
      days ? parseInt(days, 10) : 30,
    );
  }

  @Get('trust/bulk')
  @ApiOperation({ summary: 'Get trust profiles for multiple agents' })
  @ApiQuery({
    name: 'agentIds',
    required: true,
    description: 'Comma-separated agent IDs',
  })
  async getBulkTrust(@Query('agentIds') agentIds: string) {
    const ids = agentIds
      ? agentIds
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
      : [];
    return this.trustProfileService.getBulkProfiles(ids);
  }

  // === HEY-184: Trust Profiles ===

  @Get('agents/:id/trust-profile')
  @ApiOperation({ summary: 'Get domain-specific trust profile for an agent' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  async getTrustProfile(@Param('id') agentId: string) {
    return this.trustProfileService.getProfile(agentId);
  }

  // === HEY-189: Delegation-Aware Recall ===

  @Get('delegation-recall')
  @ApiOperation({ summary: 'Get delegation-aware recall for a task' })
  @ApiQuery({ name: 'task', description: 'Task description', required: true })
  @ApiQuery({ name: 'userId', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async delegationRecall(
    @Query('task') task: string,
    @Query('userId') userId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.delegationRecallService.recall(
      task,
      userId,
      limit ? parseInt(limit, 10) : 5,
    );
  }

  // === HEY-190: Portable Agent Identity ===

  @Get('agents/:id/export')
  @ApiOperation({ summary: 'Export agent identity' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  async exportIdentity(@Param('id') id: string) {
    return this.portableIdentityService.exportIdentity(id);
  }

  @Post('agents/import')
  @HttpCode(200)
  @ApiOperation({ summary: 'Import agent identity' })
  async importIdentity(@Body() dto: ImportIdentityDto) {
    return this.portableIdentityService.importIdentity(
      dto.identity,
      dto.targetAgentId,
    );
  }
}

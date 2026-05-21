import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AccountService } from './account.service.js';
import { AccountJwtGuard } from './account.guard.js';
import {
  RegisterDto,
  LoginDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  ChangePasswordDto,
  UpdateAccountDto,
} from './account.dto.js';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('auth')
@Controller('v1')
export class AccountController {
  constructor(
    private readonly accountService: AccountService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('auth/me')
  @UseGuards(ApiKeyOrJwtGuard)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Get current authenticated user info (via API key or JWT)',
  })
  async getMe(@Req() req: any) {
    const accountId = req.accountId;
    if (!accountId) {
      return {
        id: 'local',
        email: 'local@localhost',
        plan: 'self-hosted',
        name: 'Local User',
      };
    }
    const account = await this.accountService.getAccount(accountId);
    const response: any = {
      id: account.id,
      email: account.email,
      plan: account.plan || 'free',
      name: account.name || '',
    };
    if (req.isInstanceKey) {
      response.isInstanceKey = true;
      response.scopes = req.instanceKeyScopes;
    }
    return response;
  }

  @Get('auth/setup-status')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Check if initial setup is needed (no auth required)',
  })
  async getSetupStatus() {
    return this.accountService.getSetupStatus();
  }

  @Post('auth/register')
  @HttpCode(201)
  @UseGuards(RateLimitGuard)
  @RateLimit(5) // 5 per minute per IP
  @ApiOperation({ summary: 'Register a new account' })
  async register(@Body() body: RegisterDto) {
    return this.accountService.register(
      body.email,
      body.password,
      body.name,
      body.plan,
      body.accessCode,
    );
  }

  @Post('auth/login')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @RateLimit(10) // 10 per minute per IP
  @ApiOperation({ summary: 'Login and get JWT' })
  async login(@Body() body: LoginDto) {
    return this.accountService.login(body.email, body.password);
  }

  @Post('auth/forgot-password')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @RateLimit(3)
  @ApiOperation({ summary: 'Request password reset email' })
  async forgotPassword(@Body() body: ForgotPasswordDto) {
    return this.accountService.forgotPassword(body.email);
  }

  @Post('auth/reset-password')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @RateLimit(3)
  @ApiOperation({ summary: 'Reset password with token' })
  async resetPassword(@Body() body: ResetPasswordDto) {
    return this.accountService.resetPassword(body.token, body.newPassword);
  }

  @Get('account')
  @UseGuards(AccountJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get account info and usage' })
  async getAccount(@Req() req: any) {
    return this.accountService.getAccount(req.accountId);
  }

  @Get('account/api-keys')
  @UseGuards(AccountJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List API keys (agents)' })
  async listApiKeys(@Req() req: any) {
    return this.accountService.listApiKeys(req.accountId);
  }

  @Post('account/change-password')
  @UseGuards(AccountJwtGuard)
  @ApiBearerAuth()
  @HttpCode(200)
  @ApiOperation({ summary: 'Change password (authenticated)' })
  async changePassword(@Req() req: any, @Body() body: ChangePasswordDto) {
    return this.accountService.changePassword(
      req.accountId,
      body.currentPassword,
      body.newPassword,
    );
  }

  @Delete('account')
  @UseGuards(AccountJwtGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete account and all data' })
  async deleteAccount(@Req() req: any) {
    await this.accountService.deleteAccount(req.accountId);
  }

  @Post('account/api-keys')
  @UseGuards(AccountJwtGuard)
  @ApiBearerAuth()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a new API key (agent)' })
  async createApiKey(@Req() req: any, @Body() body: { name?: string }) {
    return this.accountService.createApiKey(req.accountId, body.name);
  }

  @Delete('account/api-keys/:id')
  @UseGuards(AccountJwtGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an API key (agent)' })
  async deleteApiKey(@Req() req: any, @Param('id') id: string) {
    await this.accountService.deleteApiKey(req.accountId, id);
  }

  @Patch('account')
  @UseGuards(AccountJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update account profile' })
  async updateAccount(@Req() req: any, @Body() body: UpdateAccountDto) {
    return this.accountService.updateAccount(req.accountId, body);
  }

  // =========================================================================
  // Account Agents (instance key or JWT)
  // =========================================================================

  @Get('account/agents')
  @UseGuards(ApiKeyOrJwtGuard)
  @ApiOperation({
    summary: 'List agents with memory counts (instance key or JWT)',
  })
  async listAgents(@Req() req: any) {
    const accountId = req.accountId;
    if (!accountId) {
      return { agents: [] };
    }

    const agents = await this.prisma.agent.findMany({
      where: { accountId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        apiKeyHint: true,
        createdAt: true,
      },
    });

    // Get memory counts per agent (Memory.agentId tracks the calling agent)
    const agentIds = agents.map((a) => a.id);
    const memoryCounts = await this.prisma.memory.groupBy({
      by: ['agentId'],
      where: {
        agentId: { in: agentIds },
        deletedAt: null,
      },
      _count: { _all: true },
    });

    const agentMemoryCounts = new Map<string, number>();
    for (const mc of memoryCounts) {
      if (mc.agentId) {
        agentMemoryCounts.set(mc.agentId, mc._count._all);
      }
    }

    // Users now belong to accounts (not individual agents)
    const totalUsers = await this.prisma.user.count({
      where: { accountId, deletedAt: null },
    });

    return {
      agents: agents.map((a) => ({
        id: a.id,
        name: a.name,
        apiKeyHint: a.apiKeyHint || null,
        memoryCount: agentMemoryCounts.get(a.id) || 0,
        userCount: totalUsers,
        createdAt: a.createdAt,
      })),
    };
  }

  // =========================================================================
  // Instance API Keys
  // =========================================================================

  @Get('account/instance-keys')
  @UseGuards(AccountJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List instance API keys' })
  async listInstanceKeys(@Req() req: any) {
    return this.accountService.listInstanceKeys(req.accountId);
  }

  @Post('account/instance-keys')
  @UseGuards(AccountJwtGuard)
  @ApiBearerAuth()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create an instance API key' })
  async createInstanceKey(
    @Req() req: any,
    @Body() body: { name: string; scopes?: string[] },
  ) {
    return this.accountService.createInstanceKey(
      req.accountId,
      body.name,
      body.scopes,
    );
  }

  @Delete('account/instance-keys/:id')
  @UseGuards(AccountJwtGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an instance API key' })
  async deleteInstanceKey(@Req() req: any, @Param('id') id: string) {
    await this.accountService.deleteInstanceKey(req.accountId, id);
  }

  // =========================================================================
  // Instance Sync Keys
  // =========================================================================

  @Post('account/sync-keys')
  @UseGuards(ApiKeyOrJwtGuard)
  @ApiBearerAuth()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create an instance sync key' })
  async createSyncKey(@Req() req: any, @Body() body: { instanceName: string }) {
    return this.accountService.createSyncKey(req.accountId, body.instanceName);
  }

  @Get('account/sync-keys')
  @UseGuards(AccountJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List instance sync keys (hints only)' })
  async listSyncKeys(@Req() req: any) {
    return this.accountService.listSyncKeys(req.accountId);
  }

  @Delete('account/sync-keys/:id')
  @UseGuards(AccountJwtGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke an instance sync key' })
  async revokeSyncKey(@Req() req: any, @Param('id') id: string) {
    await this.accountService.revokeSyncKey(req.accountId, id);
  }
}

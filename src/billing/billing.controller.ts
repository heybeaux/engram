import {
  Controller,
  Get,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Logger,
  UseGuards,
  Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { PlanService } from './plan.service';
import { PlanType, PLAN_DEFAULTS, PLAN_DESCRIPTIONS } from './plan.types';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';

@ApiTags('Billing')
@Controller('v1')
export class BillingController {
  private readonly logger = new Logger(BillingController.name);

  constructor(private readonly planService: PlanService) {}

  /**
   * GET /v1/account/plan
   *
   * Returns the current plan, limits, usage, and available features.
   * Requires authentication.
   */
  @Get('account/plan')
  @UseGuards(ApiKeyOrJwtGuard)
  @ApiOperation({ summary: 'Get current account plan and usage' })
  @ApiResponse({
    status: 200,
    description: 'Current plan details with usage and limits',
  })
  async getAccountPlan(@Req() req: any) {
    const accountId: string | undefined =
      req.accountId ?? req.agent?.accountId;

    // Default to DEVELOPER if no account context (local/self-hosted)
    const plan = accountId
      ? await this.planService.getAccountPlan(accountId)
      : { plan: PlanType.DEVELOPER, limits: PLAN_DEFAULTS[PlanType.DEVELOPER] };

    // Fetch live usage
    const usage = await this.resolveUsage(accountId);

    return {
      plan: plan.plan,
      limits: {
        maxProfiles: plan.limits.maxProfiles,
        maxTeamMembers: plan.limits.maxTeamMembers,
        apiRateLimit: plan.limits.apiRateLimit,
      },
      usage,
      features: plan.limits.features,
      upgradeAvailable: plan.plan !== PlanType.BUSINESS,
      description: PLAN_DESCRIPTIONS[plan.plan],
    };
  }

  /**
   * POST /v1/account/upgrade
   *
   * Returns a Stripe Checkout URL for plan upgrades.
   * Placeholder until Stripe integration is complete.
   */
  @Post('account/upgrade')
  @UseGuards(ApiKeyOrJwtGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Initiate plan upgrade (returns checkout URL)' })
  @ApiResponse({
    status: 200,
    description: 'Stripe checkout URL for plan upgrade',
  })
  async upgradePlan(
    @Req() req: any,
    @Body() body: { plan?: PlanType } = {},
  ) {
    const accountId: string | undefined =
      req.accountId ?? req.agent?.accountId;

    const targetPlan = body.plan ?? PlanType.TEAM;

    this.logger.log(
      `Upgrade requested: account=${accountId ?? 'unknown'} → ${targetPlan}`,
    );

    // TODO(ENG-stripe): integrate with StripeService to create real checkout session
    return {
      checkoutUrl: `https://app.engram.ai/settings/billing?upgrade=${targetPlan}`,
      plan: targetPlan,
      message:
        'Stripe integration coming soon. Visit the URL to complete your upgrade.',
    };
  }

  /**
   * POST /v1/webhooks/stripe
   *
   * Stripe webhook receiver. Logs the event and returns 200.
   * Placeholder — real event handling will be added with Stripe integration.
   */
  @Post('webhooks/stripe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Stripe webhook receiver (placeholder)' })
  @ApiResponse({ status: 200, description: 'Event received' })
  async stripeWebhook(@Req() req: any, @Body() body: any) {
    const eventType = body?.type ?? 'unknown';
    this.logger.log(`[Stripe webhook] event=${eventType}`);
    // TODO(ENG-stripe): verify webhook signature, dispatch to StripeService
    return { received: true };
  }

  // ── Private helpers ─────────────────────────────────────────────────

  private async resolveUsage(accountId?: string): Promise<{
    profileCount: number;
    teamMemberCount: number;
  }> {
    if (!accountId) {
      return { profileCount: 0, teamMemberCount: 1 };
    }
    // Placeholder — real counts will come from DB queries once profile/team tables
    // are fully wired to accounts.
    return {
      profileCount: 0,
      teamMemberCount: 1,
    };
  }
}

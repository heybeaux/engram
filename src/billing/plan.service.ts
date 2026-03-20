import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PlanType, PlanLimits, PLAN_DEFAULTS } from './plan.types';

export interface AccountPlan {
  plan: PlanType;
  limits: PlanLimits;
}

export interface LimitCheckResult {
  allowed: boolean;
  limit: number;
  current: number;
}

/**
 * PlanService resolves account plans and enforces feature/resource limits.
 *
 * Currently all accounts default to DEVELOPER (free tier).
 * This will be wired to Stripe subscription status once billing goes live.
 */
@Injectable()
export class PlanService {
  private readonly logger = new Logger(PlanService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get the current plan and limits for an account.
   *
   * Placeholder: always returns DEVELOPER until Stripe integration lands.
   * Future: look up account.plan → map to PlanType → return limits.
   */
  async getAccountPlan(accountId: string): Promise<AccountPlan> {
    // TODO(ENG-stripe): query account.plan from DB and map to PlanType
    // const account = await this.prisma.account.findUnique({
    //   where: { id: accountId },
    //   select: { plan: true },
    // });
    // const planType = this.mapDbPlanToType(account?.plan);

    const plan = PlanType.DEVELOPER;
    return {
      plan,
      limits: PLAN_DEFAULTS[plan],
    };
  }

  /**
   * Check whether a resource count is within the account's plan limit.
   *
   * @param accountId - The account to check
   * @param resource  - Resource name (e.g. 'profiles', 'teamMembers')
   * @param currentCount - Current usage count
   */
  async checkLimit(
    accountId: string,
    resource: string,
    currentCount: number,
  ): Promise<LimitCheckResult> {
    const { limits } = await this.getAccountPlan(accountId);

    const limitMap: Record<string, number> = {
      profiles: limits.maxProfiles,
      teamMembers: limits.maxTeamMembers,
    };

    const limit = limitMap[resource] ?? -1;

    // -1 = unlimited
    const allowed = limit === -1 || currentCount < limit;

    return { allowed, limit, current: currentCount };
  }

  /**
   * Check whether a feature is enabled for the account's current plan.
   */
  async checkFeature(accountId: string, feature: string): Promise<boolean> {
    const { limits } = await this.getAccountPlan(accountId);
    return limits.features[feature] ?? false;
  }

  /**
   * Map a DB Plan value to the billing PlanType enum.
   * Used once Stripe integration is live.
   */
  // private mapDbPlanToType(dbPlan?: string | null): PlanType {
  //   switch (dbPlan) {
  //     case 'PRO':
  //     case 'SCALE':
  //       return PlanType.TEAM;
  //     case 'STARTER':
  //       return PlanType.TEAM;
  //     case 'FREE':
  //     default:
  //       return PlanType.DEVELOPER;
  //   }
  // }
}

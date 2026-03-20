import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PlanService } from './plan.service';
import { PlanType, PLAN_DEFAULTS, PAID_PLANS } from './plan.types';
import { REQUIRES_PLAN_KEY, REQUIRES_FEATURE_KEY } from './plan.decorators';

export interface UpgradeRequiredBody {
  error: 'upgrade_required';
  requiredPlan: PlanType;
  upgradeUrl: string;
  message: string;
}

/**
 * PlanGuard enforces plan and feature requirements on routes.
 *
 * Apply at controller or handler level alongside an auth guard.
 * Reads @RequiresPlan() and @RequiresFeature() metadata set by decorators.
 *
 * Returns HTTP 402 Payment Required when the account's plan is insufficient.
 *
 * @example
 * // At handler level:
 * @UseGuards(ApiKeyOrJwtGuard, PlanGuard)
 * @RequiresPlan(PlanType.TEAM)
 * @Post('bulk-import')
 * async bulkImport() {}
 *
 * // At controller level:
 * @UseGuards(ApiKeyOrJwtGuard, PlanGuard)
 * @RequiresFeature('cloudSync')
 * @Controller('v1/sync')
 * export class SyncController {}
 */
@Injectable()
export class PlanGuard implements CanActivate {
  private readonly logger = new Logger(PlanGuard.name);
  private readonly upgradeUrl = '/settings/billing';

  constructor(
    private readonly reflector: Reflector,
    private readonly planService: PlanService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPlan = this.reflector.getAllAndOverride<PlanType | undefined>(
      REQUIRES_PLAN_KEY,
      [context.getHandler(), context.getClass()],
    );

    const requiredFeature = this.reflector.getAllAndOverride<
      string | undefined
    >(REQUIRES_FEATURE_KEY, [context.getHandler(), context.getClass()]);

    // No billing metadata — allow through
    if (!requiredPlan && !requiredFeature) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const accountId: string | undefined =
      request.accountId ?? request.agent?.accountId;

    if (!accountId) {
      // No account context — block (auth guard should have caught this first)
      this.throwUpgradeRequired(
        requiredPlan ?? PlanType.TEAM,
        'Account context required for this endpoint',
      );
    }

    const { plan, limits } = await this.planService.getAccountPlan(accountId);

    // Check plan tier requirement
    if (requiredPlan) {
      const planOrder: PlanType[] = [
        PlanType.DEVELOPER,
        PlanType.TEAM,
        PlanType.BUSINESS,
      ];
      const currentIndex = planOrder.indexOf(plan);
      const requiredIndex = planOrder.indexOf(requiredPlan);

      if (currentIndex < requiredIndex) {
        this.logger.debug(
          `Account ${accountId} on ${plan} blocked from ${requiredPlan} endpoint`,
        );
        this.throwUpgradeRequired(
          requiredPlan,
          `This feature requires the ${requiredPlan.charAt(0) + requiredPlan.slice(1).toLowerCase()} plan`,
        );
      }
    }

    // Check feature flag requirement
    if (requiredFeature) {
      const featureEnabled = limits.features[requiredFeature] ?? false;
      if (!featureEnabled) {
        // Find the lowest plan that enables this feature
        const minPlan = this.findMinPlanForFeature(requiredFeature);
        this.logger.debug(
          `Account ${accountId} on ${plan} blocked from feature "${requiredFeature}"`,
        );
        this.throwUpgradeRequired(
          minPlan,
          `This feature requires the ${minPlan.charAt(0) + minPlan.slice(1).toLowerCase()} plan`,
        );
      }
    }

    return true;
  }

  private throwUpgradeRequired(requiredPlan: PlanType, message: string): never {
    const body: UpgradeRequiredBody = {
      error: 'upgrade_required',
      requiredPlan,
      upgradeUrl: this.upgradeUrl,
      message,
    };
    throw new HttpException(body, HttpStatus.PAYMENT_REQUIRED);
  }

  private findMinPlanForFeature(feature: string): PlanType {
    const order: PlanType[] = [
      PlanType.DEVELOPER,
      PlanType.TEAM,
      PlanType.BUSINESS,
    ];
    for (const plan of order) {
      if (PLAN_DEFAULTS[plan].features[feature]) {
        return plan;
      }
    }
    return PlanType.TEAM;
  }
}

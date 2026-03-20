import { SetMetadata } from '@nestjs/common';
import { PlanType } from './plan.types';

/** Metadata key for plan requirement */
export const REQUIRES_PLAN_KEY = 'requiresPlan';
/** Metadata key for feature requirement */
export const REQUIRES_FEATURE_KEY = 'requiresFeature';

/**
 * Guard routes behind a minimum plan tier.
 *
 * @example
 * @RequiresPlan(PlanType.TEAM)
 * @Post('bulk-import')
 * async bulkImport(...) {}
 */
export const RequiresPlan = (plan: PlanType) =>
  SetMetadata(REQUIRES_PLAN_KEY, plan);

/**
 * Guard routes behind a specific feature flag.
 *
 * @example
 * @RequiresFeature('cloudSync')
 * @Get('sync')
 * async sync(...) {}
 */
export const RequiresFeature = (feature: string) =>
  SetMetadata(REQUIRES_FEATURE_KEY, feature);

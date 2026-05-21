/**
 * Billing plan types and limits for Engram pricing tiers.
 *
 * This is a code-level abstraction on top of the existing DB Plan enum.
 * Intentionally separate so the billing layer can evolve independently
 * of the Prisma schema.
 */

export enum PlanType {
  DEVELOPER = 'DEVELOPER',
  TEAM = 'TEAM',
  BUSINESS = 'BUSINESS',
}

export interface PlanLimits {
  /** Max entity profiles. -1 = unlimited */
  maxProfiles: number;
  /** Max team members. -1 = unlimited */
  maxTeamMembers: number;
  /** API requests per minute */
  apiRateLimit: number;
  /** Feature flags */
  features: Record<string, boolean>;
}

export const PLAN_DEFAULTS: Record<PlanType, PlanLimits> = {
  [PlanType.DEVELOPER]: {
    maxProfiles: 50,
    maxTeamMembers: 1,
    apiRateLimit: 100,
    features: {
      bulkImport: false,
      cloudSync: false,
      advancedAnalytics: false,
      sso: false,
    },
  },
  [PlanType.TEAM]: {
    maxProfiles: -1,
    maxTeamMembers: -1,
    apiRateLimit: 1000,
    features: {
      bulkImport: true,
      cloudSync: true,
      advancedAnalytics: true,
      sso: false,
    },
  },
  [PlanType.BUSINESS]: {
    maxProfiles: -1,
    maxTeamMembers: -1,
    apiRateLimit: 5000,
    features: {
      bulkImport: true,
      cloudSync: true,
      advancedAnalytics: true,
      sso: true,
    },
  },
};

/** Plans that require a paid subscription */
export const PAID_PLANS: PlanType[] = [PlanType.TEAM, PlanType.BUSINESS];

/** Human-readable plan descriptions */
export const PLAN_DESCRIPTIONS: Record<PlanType, string> = {
  [PlanType.DEVELOPER]: 'Local-only, single user, full API access — Free',
  [PlanType.TEAM]:
    'Cloud sync, team features, unlimited profiles — $49/mo + $15/seat',
  [PlanType.BUSINESS]: 'SSO, dedicated support, SLA — Custom pricing',
};

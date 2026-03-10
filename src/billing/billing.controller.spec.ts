import { Test, TestingModule } from '@nestjs/testing';
import { BillingController } from './billing.controller';
import { PlanService } from './plan.service';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { PlanType, PLAN_DEFAULTS } from './plan.types';

const mockPlanService = {
  getAccountPlan: jest.fn(),
};

describe('BillingController', () => {
  let controller: BillingController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BillingController],
      providers: [{ provide: PlanService, useValue: mockPlanService }],
    })
      .overrideGuard(ApiKeyOrJwtGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<BillingController>(BillingController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── GET /v1/account/plan ──────────────────────────────────────────────

  describe('getAccountPlan', () => {
    it('returns plan info for authenticated account', async () => {
      mockPlanService.getAccountPlan.mockResolvedValue({
        plan: PlanType.DEVELOPER,
        limits: PLAN_DEFAULTS[PlanType.DEVELOPER],
      });

      const req = { accountId: 'acc_123' };
      const result = await controller.getAccountPlan(req);

      expect(result.plan).toBe(PlanType.DEVELOPER);
      expect(result.limits.maxProfiles).toBe(50);
      expect(result.limits.maxTeamMembers).toBe(1);
      expect(result.limits.apiRateLimit).toBe(100);
      expect(result.features.bulkImport).toBe(false);
      expect(result.features.cloudSync).toBe(false);
      expect(result.upgradeAvailable).toBe(true);
    });

    it('upgradeAvailable is false for BUSINESS plan', async () => {
      mockPlanService.getAccountPlan.mockResolvedValue({
        plan: PlanType.BUSINESS,
        limits: PLAN_DEFAULTS[PlanType.BUSINESS],
      });

      const req = { accountId: 'acc_biz' };
      const result = await controller.getAccountPlan(req);
      expect(result.upgradeAvailable).toBe(false);
    });

    it('returns DEVELOPER defaults when no accountId present', async () => {
      const req = {};
      const result = await controller.getAccountPlan(req);
      expect(result.plan).toBe(PlanType.DEVELOPER);
    });

    it('returns usage fields', async () => {
      mockPlanService.getAccountPlan.mockResolvedValue({
        plan: PlanType.DEVELOPER,
        limits: PLAN_DEFAULTS[PlanType.DEVELOPER],
      });

      const req = { accountId: 'acc_123' };
      const result = await controller.getAccountPlan(req);
      expect(result.usage).toBeDefined();
      expect(typeof result.usage.profileCount).toBe('number');
      expect(typeof result.usage.teamMemberCount).toBe('number');
    });
  });

  // ── POST /v1/account/upgrade ──────────────────────────────────────────

  describe('upgradePlan', () => {
    it('returns a checkout URL', async () => {
      const req = { accountId: 'acc_123' };
      const result = await controller.upgradePlan(req, { plan: PlanType.TEAM });

      expect(result.checkoutUrl).toBeDefined();
      expect(typeof result.checkoutUrl).toBe('string');
      expect(result.plan).toBe(PlanType.TEAM);
    });

    it('defaults to TEAM plan when no plan specified', async () => {
      const req = { accountId: 'acc_123' };
      const result = await controller.upgradePlan(req, {});
      expect(result.plan).toBe(PlanType.TEAM);
    });

    it('returns a message', async () => {
      const req = { accountId: 'acc_123' };
      const result = await controller.upgradePlan(req, {});
      expect(result.message).toBeDefined();
    });
  });

  // ── POST /v1/webhooks/stripe ──────────────────────────────────────────

  describe('stripeWebhook', () => {
    it('returns { received: true }', async () => {
      const req = {};
      const body = { type: 'checkout.session.completed', data: {} };
      const result = await controller.stripeWebhook(req, body);
      expect(result.received).toBe(true);
    });

    it('handles unknown event types gracefully', async () => {
      const req = {};
      const result = await controller.stripeWebhook(req, {});
      expect(result.received).toBe(true);
    });
  });
});

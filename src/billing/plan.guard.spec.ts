import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PlanGuard } from './plan.guard';
import { PlanService } from './plan.service';
import { PlanType, PLAN_DEFAULTS } from './plan.types';
import { REQUIRES_PLAN_KEY, REQUIRES_FEATURE_KEY } from './plan.decorators';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeContext(
  accountId: string | undefined,
  planMetadata?: PlanType,
  featureMetadata?: string,
): ExecutionContext {
  const handler = {};
  const classTarget = {};

  const request = {
    accountId,
    agent: accountId ? { accountId } : undefined,
  };

  return {
    getHandler: () => handler,
    getClass: () => classTarget,
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const mockPlanService = {
  getAccountPlan: jest.fn(),
};

describe('PlanGuard', () => {
  let guard: PlanGuard;
  let reflector: Reflector;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlanGuard,
        { provide: PlanService, useValue: mockPlanService },
        Reflector,
      ],
    }).compile();

    guard = module.get<PlanGuard>(PlanGuard);
    reflector = module.get<Reflector>(Reflector);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── No billing metadata ──────────────────────────────────────────────

  describe('when no billing metadata is set', () => {
    it('passes through without calling PlanService', async () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
      const ctx = makeContext('acc_123');

      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
      expect(mockPlanService.getAccountPlan).not.toHaveBeenCalled();
    });
  });

  // ── @RequiresPlan ────────────────────────────────────────────────────

  describe('@RequiresPlan', () => {
    beforeEach(() => {
      // Feature check returns undefined (not set)
      jest
        .spyOn(reflector, 'getAllAndOverride')
        .mockImplementation((key) => {
          if (key === REQUIRES_PLAN_KEY) return PlanType.TEAM;
          return undefined;
        });
    });

    it('allows a TEAM account to access TEAM endpoint', async () => {
      mockPlanService.getAccountPlan.mockResolvedValue({
        plan: PlanType.TEAM,
        limits: PLAN_DEFAULTS[PlanType.TEAM],
      });

      const ctx = makeContext('acc_team');
      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
    });

    it('allows a BUSINESS account to access TEAM endpoint', async () => {
      mockPlanService.getAccountPlan.mockResolvedValue({
        plan: PlanType.BUSINESS,
        limits: PLAN_DEFAULTS[PlanType.BUSINESS],
      });

      const ctx = makeContext('acc_biz');
      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
    });

    it('blocks a DEVELOPER account from TEAM endpoint with 402', async () => {
      mockPlanService.getAccountPlan.mockResolvedValue({
        plan: PlanType.DEVELOPER,
        limits: PLAN_DEFAULTS[PlanType.DEVELOPER],
      });

      const ctx = makeContext('acc_dev');

      await expect(guard.canActivate(ctx)).rejects.toThrow(HttpException);

      try {
        await guard.canActivate(ctx);
      } catch (err: any) {
        expect(err.getStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
        const body = err.getResponse();
        expect(body.error).toBe('upgrade_required');
        expect(body.requiredPlan).toBe(PlanType.TEAM);
        expect(body.upgradeUrl).toBeDefined();
        expect(body.message).toBeDefined();
      }
    });

    it('blocks DEVELOPER from BUSINESS endpoint', async () => {
      jest
        .spyOn(reflector, 'getAllAndOverride')
        .mockImplementation((key) => {
          if (key === REQUIRES_PLAN_KEY) return PlanType.BUSINESS;
          return undefined;
        });

      mockPlanService.getAccountPlan.mockResolvedValue({
        plan: PlanType.DEVELOPER,
        limits: PLAN_DEFAULTS[PlanType.DEVELOPER],
      });

      const ctx = makeContext('acc_dev');
      await expect(guard.canActivate(ctx)).rejects.toThrow(HttpException);
    });

    it('blocks TEAM from BUSINESS endpoint', async () => {
      jest
        .spyOn(reflector, 'getAllAndOverride')
        .mockImplementation((key) => {
          if (key === REQUIRES_PLAN_KEY) return PlanType.BUSINESS;
          return undefined;
        });

      mockPlanService.getAccountPlan.mockResolvedValue({
        plan: PlanType.TEAM,
        limits: PLAN_DEFAULTS[PlanType.TEAM],
      });

      const ctx = makeContext('acc_team');
      await expect(guard.canActivate(ctx)).rejects.toThrow(HttpException);
    });
  });

  // ── @RequiresFeature ─────────────────────────────────────────────────

  describe('@RequiresFeature', () => {
    beforeEach(() => {
      jest
        .spyOn(reflector, 'getAllAndOverride')
        .mockImplementation((key) => {
          if (key === REQUIRES_FEATURE_KEY) return 'bulkImport';
          return undefined;
        });
    });

    it('blocks DEVELOPER account from bulkImport endpoint with 402', async () => {
      mockPlanService.getAccountPlan.mockResolvedValue({
        plan: PlanType.DEVELOPER,
        limits: PLAN_DEFAULTS[PlanType.DEVELOPER],
      });

      const ctx = makeContext('acc_dev');

      try {
        await guard.canActivate(ctx);
        fail('Should have thrown');
      } catch (err: any) {
        expect(err.getStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
        const body = err.getResponse();
        expect(body.error).toBe('upgrade_required');
      }
    });

    it('allows TEAM account to use bulkImport', async () => {
      mockPlanService.getAccountPlan.mockResolvedValue({
        plan: PlanType.TEAM,
        limits: PLAN_DEFAULTS[PlanType.TEAM],
      });

      const ctx = makeContext('acc_team');
      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
    });

    it('blocks DEVELOPER from sso feature', async () => {
      jest
        .spyOn(reflector, 'getAllAndOverride')
        .mockImplementation((key) => {
          if (key === REQUIRES_FEATURE_KEY) return 'sso';
          return undefined;
        });

      mockPlanService.getAccountPlan.mockResolvedValue({
        plan: PlanType.DEVELOPER,
        limits: PLAN_DEFAULTS[PlanType.DEVELOPER],
      });

      const ctx = makeContext('acc_dev');
      await expect(guard.canActivate(ctx)).rejects.toThrow(HttpException);
    });

    it('blocks TEAM from sso feature (BUSINESS only)', async () => {
      jest
        .spyOn(reflector, 'getAllAndOverride')
        .mockImplementation((key) => {
          if (key === REQUIRES_FEATURE_KEY) return 'sso';
          return undefined;
        });

      mockPlanService.getAccountPlan.mockResolvedValue({
        plan: PlanType.TEAM,
        limits: PLAN_DEFAULTS[PlanType.TEAM],
      });

      const ctx = makeContext('acc_team');
      await expect(guard.canActivate(ctx)).rejects.toThrow(HttpException);
    });

    it('allows BUSINESS to use sso feature', async () => {
      jest
        .spyOn(reflector, 'getAllAndOverride')
        .mockImplementation((key) => {
          if (key === REQUIRES_FEATURE_KEY) return 'sso';
          return undefined;
        });

      mockPlanService.getAccountPlan.mockResolvedValue({
        plan: PlanType.BUSINESS,
        limits: PLAN_DEFAULTS[PlanType.BUSINESS],
      });

      const ctx = makeContext('acc_biz');
      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
    });
  });

  // ── 402 response shape ────────────────────────────────────────────────

  describe('402 response body', () => {
    it('contains all required fields', async () => {
      jest
        .spyOn(reflector, 'getAllAndOverride')
        .mockImplementation((key) => {
          if (key === REQUIRES_PLAN_KEY) return PlanType.TEAM;
          return undefined;
        });

      mockPlanService.getAccountPlan.mockResolvedValue({
        plan: PlanType.DEVELOPER,
        limits: PLAN_DEFAULTS[PlanType.DEVELOPER],
      });

      const ctx = makeContext('acc_dev');

      try {
        await guard.canActivate(ctx);
      } catch (err: any) {
        const body = err.getResponse();
        expect(body).toMatchObject({
          error: 'upgrade_required',
          requiredPlan: PlanType.TEAM,
          upgradeUrl: expect.stringContaining('billing'),
          message: expect.any(String),
        });
      }
    });
  });
});

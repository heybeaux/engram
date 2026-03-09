import { Test, TestingModule } from '@nestjs/testing';
import { PlanService } from './plan.service';
import { PrismaService } from '../prisma/prisma.service';
import { PlanType, PLAN_DEFAULTS } from './plan.types';

const mockPrisma = {
  account: {
    findUnique: jest.fn(),
  },
};

describe('PlanService', () => {
  let service: PlanService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlanService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<PlanService>(PlanService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── getAccountPlan ───────────────────────────────────────────────────

  describe('getAccountPlan', () => {
    it('returns DEVELOPER plan for any account (placeholder)', async () => {
      const result = await service.getAccountPlan('acc_123');
      expect(result.plan).toBe(PlanType.DEVELOPER);
    });

    it('returns correct limits for DEVELOPER tier', async () => {
      const { limits } = await service.getAccountPlan('acc_123');
      expect(limits.maxProfiles).toBe(50);
      expect(limits.maxTeamMembers).toBe(1);
      expect(limits.apiRateLimit).toBe(100);
    });

    it('DEVELOPER plan has bulkImport disabled', async () => {
      const { limits } = await service.getAccountPlan('acc_any');
      expect(limits.features.bulkImport).toBe(false);
    });

    it('DEVELOPER plan has cloudSync disabled', async () => {
      const { limits } = await service.getAccountPlan('acc_any');
      expect(limits.features.cloudSync).toBe(false);
    });

    it('TEAM plan has bulkImport enabled', () => {
      expect(PLAN_DEFAULTS[PlanType.TEAM].features.bulkImport).toBe(true);
    });

    it('TEAM plan has unlimited profiles', () => {
      expect(PLAN_DEFAULTS[PlanType.TEAM].maxProfiles).toBe(-1);
    });

    it('BUSINESS plan has sso enabled', () => {
      expect(PLAN_DEFAULTS[PlanType.BUSINESS].features.sso).toBe(true);
    });
  });

  // ── checkLimit ───────────────────────────────────────────────────────

  describe('checkLimit', () => {
    it('blocks when profile count equals the limit', async () => {
      const result = await service.checkLimit('acc_free', 'profiles', 50);
      expect(result.allowed).toBe(false);
      expect(result.limit).toBe(50);
      expect(result.current).toBe(50);
    });

    it('blocks when profile count exceeds the limit', async () => {
      const result = await service.checkLimit('acc_free', 'profiles', 99);
      expect(result.allowed).toBe(false);
    });

    it('allows when profile count is below the limit', async () => {
      const result = await service.checkLimit('acc_free', 'profiles', 49);
      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(50);
      expect(result.current).toBe(49);
    });

    it('allows at count 0', async () => {
      const result = await service.checkLimit('acc_free', 'profiles', 0);
      expect(result.allowed).toBe(true);
    });

    it('returns limit=-1 and allows for unknown resource', async () => {
      const result = await service.checkLimit('acc_free', 'unknownResource', 9999);
      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(-1);
    });
  });

  // ── checkFeature ─────────────────────────────────────────────────────

  describe('checkFeature', () => {
    it('returns false for bulkImport on DEVELOPER plan', async () => {
      const allowed = await service.checkFeature('acc_dev', 'bulkImport');
      expect(allowed).toBe(false);
    });

    it('returns false for cloudSync on DEVELOPER plan', async () => {
      const allowed = await service.checkFeature('acc_dev', 'cloudSync');
      expect(allowed).toBe(false);
    });

    it('returns false for unknown feature', async () => {
      const allowed = await service.checkFeature('acc_dev', 'nonExistentFeature');
      expect(allowed).toBe(false);
    });
  });

  // ── PLAN_DEFAULTS sanity checks ───────────────────────────────────────

  describe('PLAN_DEFAULTS', () => {
    it('has correct apiRateLimit for all tiers', () => {
      expect(PLAN_DEFAULTS[PlanType.DEVELOPER].apiRateLimit).toBe(100);
      expect(PLAN_DEFAULTS[PlanType.TEAM].apiRateLimit).toBe(1000);
      expect(PLAN_DEFAULTS[PlanType.BUSINESS].apiRateLimit).toBe(5000);
    });

    it('BUSINESS has all features enabled', () => {
      const features = PLAN_DEFAULTS[PlanType.BUSINESS].features;
      expect(features.bulkImport).toBe(true);
      expect(features.cloudSync).toBe(true);
      expect(features.advancedAnalytics).toBe(true);
      expect(features.sso).toBe(true);
    });
  });
});

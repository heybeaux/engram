import 'reflect-metadata';
import {
  REQUIRES_PLAN_KEY,
  REQUIRES_FEATURE_KEY,
  RequiresPlan,
  RequiresFeature,
} from './plan.decorators';
import { PlanType } from './plan.types';

// NestJS SetMetadata attaches metadata TO the decorated function (target[propertyKey]),
// not to the prototype with a property descriptor key.
// Read it back via: Reflect.getMetadata(key, prototype[methodName])
const getMeta = (key: string, proto: any, methodName: string) =>
  Reflect.getMetadata(key, proto[methodName]);

describe('Plan decorators', () => {
  // ── RequiresPlan ─────────────────────────────────────────────────────────────

  describe('RequiresPlan', () => {
    it('sets REQUIRES_PLAN_KEY metadata with the given plan on a method', () => {
      class TestController {
        @RequiresPlan(PlanType.TEAM)
        teamEndpoint() {}
      }
      expect(
        getMeta(REQUIRES_PLAN_KEY, TestController.prototype, 'teamEndpoint'),
      ).toBe(PlanType.TEAM);
    });

    it('sets REQUIRES_PLAN_KEY metadata with BUSINESS plan', () => {
      class TestController {
        @RequiresPlan(PlanType.BUSINESS)
        businessEndpoint() {}
      }
      expect(
        getMeta(
          REQUIRES_PLAN_KEY,
          TestController.prototype,
          'businessEndpoint',
        ),
      ).toBe(PlanType.BUSINESS);
    });

    it('sets REQUIRES_PLAN_KEY metadata with DEVELOPER plan', () => {
      class TestController {
        @RequiresPlan(PlanType.DEVELOPER)
        devEndpoint() {}
      }
      expect(
        getMeta(REQUIRES_PLAN_KEY, TestController.prototype, 'devEndpoint'),
      ).toBe(PlanType.DEVELOPER);
    });

    it('does NOT set REQUIRES_FEATURE_KEY metadata when using RequiresPlan', () => {
      class TestController {
        @RequiresPlan(PlanType.TEAM)
        mixedEndpoint() {}
      }
      expect(
        getMeta(
          REQUIRES_FEATURE_KEY,
          TestController.prototype,
          'mixedEndpoint',
        ),
      ).toBeUndefined();
    });

    it('different methods get independent plan metadata', () => {
      class TestController {
        @RequiresPlan(PlanType.DEVELOPER)
        endpointA() {}

        @RequiresPlan(PlanType.BUSINESS)
        endpointB() {}
      }
      expect(
        getMeta(REQUIRES_PLAN_KEY, TestController.prototype, 'endpointA'),
      ).toBe(PlanType.DEVELOPER);
      expect(
        getMeta(REQUIRES_PLAN_KEY, TestController.prototype, 'endpointB'),
      ).toBe(PlanType.BUSINESS);
    });
  });

  // ── RequiresFeature ──────────────────────────────────────────────────────────

  describe('RequiresFeature', () => {
    it('sets REQUIRES_FEATURE_KEY metadata with the given feature name', () => {
      class TestController {
        @RequiresFeature('cloudSync')
        syncEndpoint() {}
      }
      expect(
        getMeta(REQUIRES_FEATURE_KEY, TestController.prototype, 'syncEndpoint'),
      ).toBe('cloudSync');
    });

    it('sets REQUIRES_FEATURE_KEY for sso feature', () => {
      class TestController {
        @RequiresFeature('sso')
        ssoEndpoint() {}
      }
      expect(
        getMeta(REQUIRES_FEATURE_KEY, TestController.prototype, 'ssoEndpoint'),
      ).toBe('sso');
    });

    it('does NOT set REQUIRES_PLAN_KEY when using RequiresFeature', () => {
      class TestController {
        @RequiresFeature('bulkImport')
        bulkEndpoint() {}
      }
      expect(
        getMeta(REQUIRES_PLAN_KEY, TestController.prototype, 'bulkEndpoint'),
      ).toBeUndefined();
    });

    it('different methods get independent feature metadata', () => {
      class TestController {
        @RequiresFeature('cloudSync')
        syncEndpoint() {}

        @RequiresFeature('advancedAnalytics')
        analyticsEndpoint() {}
      }
      expect(
        getMeta(REQUIRES_FEATURE_KEY, TestController.prototype, 'syncEndpoint'),
      ).toBe('cloudSync');
      expect(
        getMeta(
          REQUIRES_FEATURE_KEY,
          TestController.prototype,
          'analyticsEndpoint',
        ),
      ).toBe('advancedAnalytics');
    });

    it('handles arbitrary feature flag strings', () => {
      class TestController {
        @RequiresFeature('experimental_feature_xyz')
        expEndpoint() {}
      }
      expect(
        getMeta(REQUIRES_FEATURE_KEY, TestController.prototype, 'expEndpoint'),
      ).toBe('experimental_feature_xyz');
    });
  });

  // ── Constant exports ─────────────────────────────────────────────────────────

  describe('metadata key constants', () => {
    it('REQUIRES_PLAN_KEY is a non-empty string', () => {
      expect(typeof REQUIRES_PLAN_KEY).toBe('string');
      expect(REQUIRES_PLAN_KEY.length).toBeGreaterThan(0);
    });

    it('REQUIRES_FEATURE_KEY is a non-empty string', () => {
      expect(typeof REQUIRES_FEATURE_KEY).toBe('string');
      expect(REQUIRES_FEATURE_KEY.length).toBeGreaterThan(0);
    });

    it('REQUIRES_PLAN_KEY and REQUIRES_FEATURE_KEY are distinct', () => {
      expect(REQUIRES_PLAN_KEY).not.toBe(REQUIRES_FEATURE_KEY);
    });
  });
});

/**
 * GIN-38 — FeedbackController (anticipatory) auth tests
 *
 * Covers:
 *  1. Guard rejects unauthenticated requests with UnauthorizedException (401)
 *  2. Authenticated happy paths with user resolved from req.user.id / req.userId
 *  3. Service errors propagate correctly once authenticated
 */
import { Test, TestingModule } from '@nestjs/testing';
import {
  ExecutionContext,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { FeedbackController } from './feedback.controller';
import { FeedbackService } from './feedback.service';
import { ApiKeyOrJwtGuard } from '../../common/guards/api-key-or-jwt.guard';

// ── Guard fixtures ─────────────────────────────────────────────────────────

/** Simulates ApiKeyOrJwtGuard throwing when no valid credentials are supplied. */
const rejectingGuard = {
  canActivate: (_ctx: ExecutionContext): never => {
    throw new UnauthorizedException(
      'Missing authentication: provide X-AM-API-Key or Authorization Bearer token',
    );
  },
};

/** Simulates ApiKeyOrJwtGuard accepting a request and attaching user context. */
const allowingGuard = {
  canActivate: (ctx: ExecutionContext): boolean => {
    const req = ctx.switchToHttp().getRequest();
    req.user = { id: 'user-1' };
    req.accountId = 'acc-1';
    return true;
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────

async function buildController(guardOverride: object, serviceOverride: object) {
  const module: TestingModule = await Test.createTestingModule({
    controllers: [FeedbackController],
    providers: [{ provide: FeedbackService, useValue: serviceOverride }],
  })
    .overrideGuard(ApiKeyOrJwtGuard)
    .useValue(guardOverride)
    .compile();

  return module.get<FeedbackController>(FeedbackController);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('FeedbackController (anticipatory)', () => {
  let mockFeedbackService: { recordFeedback: jest.Mock };

  beforeEach(() => {
    mockFeedbackService = { recordFeedback: jest.fn() };
  });

  afterEach(() => jest.clearAllMocks());

  // ── GIN-38: unauthenticated requests ────────────────────────────────────

  describe('GIN-38 — ApiKeyOrJwtGuard rejects unauthenticated requests', () => {
    it('guard throws UnauthorizedException (401) when no credentials supplied', () => {
      const fakeCtx = {
        switchToHttp: () => ({ getRequest: () => ({ headers: {}, ip: '8.8.8.8' }) }),
      } as unknown as ExecutionContext;

      expect(() => rejectingGuard.canActivate(fakeCtx)).toThrow(UnauthorizedException);
    });

    it('guard error carries HTTP status 401', () => {
      const fakeCtx = {
        switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
      } as unknown as ExecutionContext;

      try {
        rejectingGuard.canActivate(fakeCtx);
        fail('Expected UnauthorizedException');
      } catch (err: any) {
        expect(err).toBeInstanceOf(UnauthorizedException);
        expect(err.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
      }
    });

    it('guard error message matches standard format', () => {
      const fakeCtx = {
        switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
      } as unknown as ExecutionContext;

      expect(() => rejectingGuard.canActivate(fakeCtx)).toThrow(
        'Missing authentication: provide X-AM-API-Key or Authorization Bearer token',
      );
    });
  });

  // ── Authenticated happy paths ────────────────────────────────────────────

  describe('authenticated — POST /anticipatory/feedback', () => {
    let controller: FeedbackController;

    beforeEach(async () => {
      controller = await buildController(allowingGuard, mockFeedbackService);
    });

    it('records feedback and returns { ok: true }', async () => {
      const dto = { memoryId: 'mem-1', recallId: 'recall-1', wasUseful: true };
      const req = { user: { id: 'user-1' } };
      mockFeedbackService.recordFeedback.mockResolvedValue(undefined);

      const result = await controller.submitFeedback(dto as any, req);

      expect(result).toEqual({ ok: true });
      expect(mockFeedbackService.recordFeedback).toHaveBeenCalledWith(
        'mem-1',
        'recall-1',
        true,
        'user-1',
      );
    });

    it('resolves userId from req.user.id (primary path — set by ApiKeyOrJwtGuard)', async () => {
      const dto = { memoryId: 'mem-2', recallId: 'r-2', wasUseful: false };
      const req = { user: { id: 'auth-user' } };
      mockFeedbackService.recordFeedback.mockResolvedValue(undefined);

      await controller.submitFeedback(dto as any, req);

      expect(mockFeedbackService.recordFeedback).toHaveBeenCalledWith(
        'mem-2',
        'r-2',
        false,
        'auth-user',
      );
    });

    it('falls back to req.user.userId (legacy shape)', async () => {
      const dto = { memoryId: 'mem-3', recallId: 'r-3', wasUseful: true };
      const req = { user: { userId: 'legacy-user' } };
      mockFeedbackService.recordFeedback.mockResolvedValue(undefined);

      await controller.submitFeedback(dto as any, req);

      expect(mockFeedbackService.recordFeedback).toHaveBeenCalledWith(
        'mem-3',
        'r-3',
        true,
        'legacy-user',
      );
    });

    it('falls back to req.userId (flat shape)', async () => {
      const dto = { memoryId: 'mem-4', recallId: undefined, wasUseful: false };
      const req = { userId: 'flat-user' };
      mockFeedbackService.recordFeedback.mockResolvedValue(undefined);

      await controller.submitFeedback(dto as any, req);

      expect(mockFeedbackService.recordFeedback).toHaveBeenCalledWith(
        'mem-4',
        undefined,
        false,
        'flat-user',
      );
    });

    it('defaults userId to "unknown" when all paths are absent', async () => {
      const dto = { memoryId: 'mem-5', recallId: 'r-5', wasUseful: false };
      const req = {};
      mockFeedbackService.recordFeedback.mockResolvedValue(undefined);

      await controller.submitFeedback(dto as any, req);

      expect(mockFeedbackService.recordFeedback).toHaveBeenCalledWith(
        'mem-5',
        'r-5',
        false,
        'unknown',
      );
    });
  });

  // ── Service errors propagate ─────────────────────────────────────────────

  describe('service errors propagate once authenticated', () => {
    let controller: FeedbackController;

    beforeEach(async () => {
      controller = await buildController(allowingGuard, mockFeedbackService);
    });

    it('propagates service Error', async () => {
      const dto = { memoryId: 'mem-err', recallId: 'r-err', wasUseful: true };
      const req = { user: { id: 'user-1' } };
      mockFeedbackService.recordFeedback.mockRejectedValue(new Error('DB write failed'));

      await expect(controller.submitFeedback(dto as any, req)).rejects.toThrow(
        'DB write failed',
      );
    });
  });

  // ── 401 response body structure ──────────────────────────────────────────

  describe('401 response body', () => {
    it('UnauthorizedException carries status 401 and descriptive message', () => {
      const err = new UnauthorizedException(
        'Missing authentication: provide X-AM-API-Key or Authorization Bearer token',
      );
      expect(err.getStatus()).toBe(401);
      const body = err.getResponse() as any;
      // NestJS shapes response as { statusCode, message, error }
      const statusCode = typeof body === 'object' ? body.statusCode : err.getStatus();
      expect(statusCode).toBe(401);
    });
  });
});

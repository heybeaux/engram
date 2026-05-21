import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Extracts the internal user ID from the request
 * (set by ApiKeyGuard after validating X-AM-User-ID)
 */
export const UserId = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): string | null => {
    const request = ctx.switchToHttp().getRequest();
    // ENG-109: Return null instead of throwing when userId is not resolved.
    // The guard should always set a user, but if it doesn't (e.g. no
    // X-AM-User-ID header and no default user), callers handle null gracefully.
    return request.user?.id ?? request.userId ?? null;
  },
);

/**
 * Extracts the agent from the request
 */
export const Agent = createParamDecorator(
  (data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    return request.agent;
  },
);

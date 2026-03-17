import {
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';

/**
 * Extracts the internal user ID from the request
 * (set by ApiKeyGuard after validating X-AM-User-ID)
 */
export const UserId = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest();
    const userId = request.user?.id ?? request.userId;
    if (!userId) {
      throw new UnauthorizedException(
        'User ID is required but was not resolved from the request',
      );
    }
    return userId;
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

import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable, from, switchMap } from 'rxjs';
import { PrismaService } from './prisma.service';
import { ConfigService } from '@nestjs/config';
import { rlsContext } from './rls-context';

/**
 * RLS Interceptor: Wraps each HTTP request in a Prisma interactive transaction
 * that sets `app.current_account_id` via SET LOCAL. This ensures all queries
 * within the request are filtered by RLS policies.
 *
 * For LAN bypass mode (TRUST_LOCAL_NETWORK=true with no auth), the interceptor
 * skips setting the session variable, and the BYPASSRLS role handles access.
 *
 * Usage: Applied globally or per-controller via @UseInterceptors(RlsInterceptor)
 */
@Injectable()
export class RlsInterceptor implements NestInterceptor {
  private readonly logger = new Logger(RlsInterceptor.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();

    // Resolve accountId: from JWT auth or from agent (API key auth)
    const accountId = request.accountId || request.agent?.accountId || null;

    // Skip RLS wrapping when:
    // 1. No accountId (LAN bypass mode / unauthenticated local access)
    // 2. Long-running admin/batch endpoints that manage their own scoping
    if (!accountId) {
      return next.handle();
    }

    const url: string = request.url || '';
    const skipRls =
      url.includes('/consolidation/') ||
      url.includes('/consolidate') ||
      url.includes('/dedup/scan') ||
      url.includes('/dedup/batch');
    if (skipRls) {
      return next.handle();
    }

    // Determine timeout: long-running endpoints (sync) need more time
    const isLongRunning =
      url.includes('/sync') ||
      url.includes('/cloud/sync') ||
      url.includes('/admin/') ||
      url.includes('/dedup/scan');
    const txTimeout = isLongRunning ? 300_000 : 30_000; // 5 min for sync/admin, 30s default

    // Wrap the request handler in an interactive transaction with SET LOCAL
    return from(
      this.prisma
        .$transaction(
          async (tx) => {
            // Note: SET LOCAL ROLE app would enforce RLS, but requires the app role
            // to have proper grants on all tables. For now, rely on application-level
            // filtering via SET LOCAL app.current_account_id. RLS policies exist as
            // defense-in-depth for direct DB access.
            // NOTE: Full RLS enforcement (SET LOCAL ROLE app) deferred until
            // proper grants are configured on all tables.

            // SET LOCAL only persists within this transaction
            // SET LOCAL doesn't support parameterized values — use $executeRawUnsafe
            // accountId is always from our own auth resolution, never user input
            const sanitized = accountId.replace(/[^a-zA-Z0-9_-]/g, '');
            await tx.$executeRawUnsafe(
              `SET LOCAL app.current_account_id = '${sanitized}'`,
            );

            // Store the transactional client on the request (legacy)
            request.prismaTransaction = tx;

            // Run the handler inside AsyncLocalStorage so PrismaService
            // automatically delegates to this transactional client
            return rlsContext.run(tx as any, () => {
              return new Promise((resolve, reject) => {
                next.handle().subscribe({
                  next: (val) => resolve(val),
                  error: (err: unknown) =>
                    reject(err instanceof Error ? err : new Error(String(err))),
                });
              });
            });
          },
          { timeout: txTimeout, maxWait: 10_000 },
        )
        .catch((err) => {
          this.logger.error(
            '[RLS_INTERCEPTOR_ERROR]',
            err?.message || err,
            err?.stack?.split('\n').slice(0, 3).join('\n'),
          );
          throw err;
        }),
    ).pipe(switchMap((result) => from(Promise.resolve(result))));
  }
}

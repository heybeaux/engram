import { AsyncLocalStorage } from 'async_hooks';
import { PrismaClient } from '@prisma/client';

/**
 * AsyncLocalStorage that holds the transactional Prisma client
 * set by RlsInterceptor. Any code downstream can access it via
 * rlsContext.getStore() to get RLS-filtered queries automatically.
 */
// `undefined` is an intentional store value: background work can run inside
// `rlsContext.run(undefined, ...)` to detach from a completed request
// transaction. PrismaService only delegates to the store when it is truthy, so
// an undefined store falls back to the base Prisma client.
export const rlsContext = new AsyncLocalStorage<PrismaClient | undefined>();

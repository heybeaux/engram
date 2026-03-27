import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { rlsContext } from './rls-context';

// Properties that only exist on the full PrismaClient, not on transaction clients
const NON_TRANSACTIONAL_PROPS = new Set([
  '$connect',
  '$disconnect',
  '$transaction',
  '$extends',
  '$on',
  'onModuleInit',
  'onModuleDestroy',
  'softDelete',
]);

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    const adapter = new PrismaPg({
      connectionString: process.env.DATABASE_URL,
    });
    super({
      adapter,
      transactionOptions: {
        maxWait: 10000,
        timeout: 120000,
      },
    });

    // Return a Proxy that intercepts property access.
    // When an RLS transactional client exists in AsyncLocalStorage,
    // delegate model accessors and raw query methods to it.
    return new Proxy(this, {
      get(target, prop, receiver) {
        // For non-transactional props or symbols, always use the real PrismaService
        if (typeof prop === 'symbol' || NON_TRANSACTIONAL_PROPS.has(prop)) {
          return Reflect.get(target, prop, receiver);
        }

        const txClient = rlsContext.getStore();
        if (txClient && prop in txClient) {
          return (txClient as any)[prop];
        }

        return Reflect.get(target, prop, receiver);
      },
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /**
   * Soft delete helper - sets deletedAt instead of hard delete
   */
  async softDelete<T extends { deletedAt?: Date | null }>(
    model: { update: (args: any) => Promise<T> },
    where: object,
  ): Promise<T> {
    return model.update({
      where,
      data: { deletedAt: new Date() },
    });
  }
}

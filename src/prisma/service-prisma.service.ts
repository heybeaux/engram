import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * Dedicated Prisma client for internal background jobs (Dream Cycle, etc.).
 * Does NOT use the RLS proxy or AsyncLocalStorage.
 * Connects as the `engram_service` PostgreSQL role (BYPASSRLS).
 * NEVER inject into HTTP controllers or user-facing services.
 */
@Injectable()
export class ServicePrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ServicePrismaService.name);

  constructor() {
    const connectionString =
      process.env.DATABASE_URL_SERVICE || process.env.DATABASE_URL;
    const adapter = new PrismaPg({ connectionString });
    super({ adapter });
  }

  async onModuleInit() {
    if (!process.env.DATABASE_URL_SERVICE) {
      this.logger.warn(
        'DATABASE_URL_SERVICE not set — ServicePrismaService will use DATABASE_URL (RLS may apply)',
      );
    }
    await this.$connect();
    this.logger.log('ServicePrismaService connected (BYPASSRLS role)');
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

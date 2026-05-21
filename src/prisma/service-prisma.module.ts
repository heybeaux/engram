import { Module } from '@nestjs/common';
import { ServicePrismaService } from './service-prisma.service';

/**
 * Provides ServicePrismaService for background/system jobs.
 * Import ONLY in modules that run background jobs.
 * Do NOT import in AppModule.
 */
@Module({
  providers: [ServicePrismaService],
  exports: [ServicePrismaService],
})
export class ServicePrismaModule {}

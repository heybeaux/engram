import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MemoryModule } from '../memory/memory.module';
import { ServicePrismaModule } from '../prisma/service-prisma.module';
import { HealthController } from './health.controller';
import { EmbedHealthService } from './embed-health.service';
import { EmbeddingRetryService } from './embedding-retry.service';
import { HealthMetricsService } from './health-metrics.service';
import { HealthMetricsController } from './health-metrics.controller';

@Module({
  imports: [PrismaModule, MemoryModule, ServicePrismaModule],
  controllers: [HealthController, HealthMetricsController],
  providers: [EmbedHealthService, EmbeddingRetryService, HealthMetricsService],
  exports: [EmbedHealthService, HealthMetricsService],
})
export class HealthModule {}

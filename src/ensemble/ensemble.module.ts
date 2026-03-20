/**
 * Ensemble Module
 *
 * Multi-model embedding and RRF fusion for improved memory retrieval.
 * Uses pgvector for storage (replaced Pinecone).
 * Includes nightly batch re-embedding with checkpointing and drift detection.
 *
 * Enable with ENSEMBLE_ENABLED=true environment variable.
 * Enable nightly re-embed with ENSEMBLE_REEMBED_ENABLED=true.
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { ServicePrismaModule } from '../prisma/service-prisma.module';
import { EnsembleService } from './ensemble.service';
import { EnsembleController } from './ensemble.controller';
import { NightlyReembedService } from './nightly-reembed.service';
import { CheckpointService } from './checkpoint.service';
import { DriftDetectionService } from './drift-detection.service';
import { ModelRegistryService } from './model-registry.service';
import { PgVectorEnsembleProvider } from './pgvector-ensemble.provider';
import { AccountModule } from '../account/account.module';

@Module({
  imports: [AccountModule, ConfigModule, PrismaModule, ServicePrismaModule],
  controllers: [EnsembleController],
  providers: [
    PgVectorEnsembleProvider,
    EnsembleService,
    NightlyReembedService,
    CheckpointService,
    DriftDetectionService,
    ModelRegistryService,
  ],
  exports: [
    EnsembleService,
    NightlyReembedService,
    DriftDetectionService,
    ModelRegistryService,
    PgVectorEnsembleProvider,
  ],
})
export class EnsembleModule {}

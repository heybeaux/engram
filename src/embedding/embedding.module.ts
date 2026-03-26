/**
 * Embedding Module
 *
 * Provides a unified embedding interface via EmbeddingService.
 * Provider is selected by EMBEDDING_PROVIDER env var (default: 'local').
 *
 * Global module — available to all other modules without explicit import.
 */

import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EmbeddingService } from './embedding.service';
import { LocalEmbedProvider } from './local-embed.provider';
import { OpenAIEmbedProvider } from './openai-embed.provider';
import { CloudEnsembleService } from './cloud-ensemble.service';
import { CloudEnsembleEmbedProvider } from './cloud-ensemble-embed.provider';
import { EmbeddingProxyController } from './embedding-proxy.controller';

@Global()
@Module({
  imports: [ConfigModule],
  controllers: [EmbeddingProxyController],
  providers: [
    LocalEmbedProvider,
    OpenAIEmbedProvider,
    CloudEnsembleService,
    CloudEnsembleEmbedProvider,
    EmbeddingService,
  ],
  exports: [EmbeddingService, CloudEnsembleService],
})
export class EmbeddingModule {}

import { Global, Module } from '@nestjs/common';
import { VectorService } from './vector.service';
import { PgVectorProvider } from './providers/pgvector.provider';
import { PineconeProvider } from './providers/pinecone.provider';
import { HybridSearchService } from './hybrid-search.service';
import { EmbeddingWriteService } from './embedding-write.service';

@Global()
@Module({
  providers: [
    VectorService,
    PgVectorProvider,
    PineconeProvider,
    HybridSearchService,
    EmbeddingWriteService,
  ],
  exports: [VectorService, HybridSearchService, EmbeddingWriteService],
})
export class VectorModule {}

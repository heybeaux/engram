import { Global, Module } from '@nestjs/common';
import { VectorService } from './vector.service';
import { PgVectorProvider } from './providers/pgvector.provider';
import { PineconeProvider } from './providers/pinecone.provider';
import { HybridSearchService } from './hybrid-search.service';

@Global()
@Module({
  providers: [
    VectorService,
    PgVectorProvider,
    PineconeProvider,
    HybridSearchService,
  ],
  exports: [VectorService, HybridSearchService],
})
export class VectorModule {}

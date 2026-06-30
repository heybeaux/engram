/**
 * createTestApp — bootstrap a NestJS test module for e2e / integration tests.
 *
 * Provides:
 *  - Real PrismaService (uses DATABASE_URL from environment)
 *  - CachedEmbeddingService swapped in for real embedding calls
 *  - ValidationPipe applied globally
 *  - Full AppModule imported so all guards / interceptors are in place
 *
 * Usage:
 *   const { app, prisma } = await createTestApp();
 *   // ... use request(app.getHttpServer())
 *   await app.close();
 */

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { EmbeddingService } from '../../src/memory/embedding.service';
import { ElasticsearchService } from '../../src/search/elasticsearch.service';
import { CachedEmbeddingService } from './cached-embedding.service';

export interface TestApp {
  app: INestApplication;
  prisma: PrismaService;
}

/**
 * Bootstrap the full NestJS application for integration testing.
 *
 * @param overrideEmbedding - If true (default), swap real EmbeddingService for
 *                            CachedEmbeddingService so tests don't hit external APIs.
 */
export interface TestProviderOverride {
  provide: unknown;
  useValue: unknown;
}

export interface CreateTestAppOptions {
  overrideEmbedding?: boolean;
  overrideProviders?: TestProviderOverride[];
}

export async function createTestApp(
  overrideEmbeddingOrOptions: boolean | CreateTestAppOptions = true,
): Promise<TestApp> {
  const options: CreateTestAppOptions =
    typeof overrideEmbeddingOrOptions === 'boolean'
      ? { overrideEmbedding: overrideEmbeddingOrOptions }
      : overrideEmbeddingOrOptions;
  const overrideEmbedding = options.overrideEmbedding ?? true;

  const builder = Test.createTestingModule({
    imports: [AppModule],
  });

  if (overrideEmbedding) {
    builder.overrideProvider(EmbeddingService).useClass(CachedEmbeddingService);
  }

  builder.overrideProvider(ElasticsearchService).useValue({
    onModuleInit: async () => {},
    indexMemory: async () => {},
    deleteMemory: async () => {},
    keywordSearch: async () => [],
  });

  for (const provider of options.overrideProviders ?? []) {
    builder
      .overrideProvider(provider.provide as never)
      .useValue(provider.useValue);
  }

  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ transform: true }));
  await app.init();

  const prisma = app.get(PrismaService);

  return { app, prisma };
}

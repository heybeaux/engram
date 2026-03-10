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
export async function createTestApp(
  overrideEmbedding = true,
): Promise<TestApp> {
  const builder = Test.createTestingModule({
    imports: [AppModule],
  });

  if (overrideEmbedding) {
    builder.overrideProvider(EmbeddingService).useClass(CachedEmbeddingService);
  }

  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ transform: true }));
  await app.init();

  const prisma = app.get(PrismaService);

  return { app, prisma };
}

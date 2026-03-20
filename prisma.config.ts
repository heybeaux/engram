import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: './prisma/schema.prisma',
  migrations: {
    path: './prisma/migrations',
  },
  // Conditionally include datasource.url — Prisma v7 eagerly evaluates this
  // at import time, which breaks Railway Docker builds (no env vars injected).
  // When DATABASE_URL is present (CI, runtime), include it so `migrate deploy`
  // works. When absent (Railway build step), omit it and let schema.prisma handle it.
  ...(process.env.DATABASE_URL
    ? {
        datasource: {
          url: process.env.DATABASE_URL,
        },
      }
    : {}),
});

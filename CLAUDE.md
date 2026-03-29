# CLAUDE.md — Engram

## Project
NestJS + Prisma + PostgreSQL + pgvector. Semantic memory service for AI agents.

## Commands
```bash
npm test                # Jest (57 spec files)
npm run build           # nest build
npm run lint            # eslint --fix
npm run start:dev       # nest start --watch
npm run migrate:deploy  # prisma migrate deploy (SAFE)
npm run migrate:safe    # wrapper script
```

## Architecture
`src/{module}/` — each module has `.controller.ts`, `.service.ts`, `.module.ts`, `.spec.ts` alongside.

Modules (57): account, agent, agent-recall, agent-session, analytics, anticipatory, auto, awareness, billing, challenge, cloud-link, cloud-sync, clustering, common, consolidation, correction, dashboard, deduplication, delegation, embedding, ensemble, entity-profile, eval, events, feedback, fog-index, graph, health, hierarchy, identity, import, import-v2, inbound-email, instance, llm, memory, memory-access-log, memory-pool, monitoring, multi-query, prefetch, prisma, queue, rate-limit, reembedding, retrieval-signals, scoped-context, scripts, session-indexing, storage, stripe, summarization, teams, timeline, utils, vector, webhooks.

Entry: `src/main.ts` → `src/app.module.ts`.

## Rules
1. **Every change needs tests.** No exceptions.
2. **Every DTO needs class-validator decorators.** `whitelist: true` strips undecorated properties — if you add a field without a decorator it silently disappears.
3. **Migrations must be idempotent.** Use `IF NOT EXISTS`, `DROP POLICY IF EXISTS` + `CREATE POLICY`. Never `CREATE POLICY IF NOT EXISTS` — that's invalid PostgreSQL syntax.
4. **NEVER run `prisma migrate dev` on prod.** It resets the database. Use `prisma migrate deploy` only. The `premigrate:dev` script blocks accidental runs.
5. **User identification**: `x-am-user-id` header convention throughout.

## Known Gotchas
- **PrefetchCacheService maxSize=0** → infinite loop. Always validate cache config.
- **`CREATE POLICY IF NOT EXISTS`** is NOT valid PostgreSQL. Use `DROP POLICY IF EXISTS ... ; CREATE POLICY ...`.
- **`prisma migrate dev` disaster**: wiped 543 memories in production. That's why `premigrate:dev` exits with error.
- **BigInt from Prisma raw queries**: `$queryRaw` returns `BigInt` for COUNT — convert with `Number()`.

## Testing Patterns
```typescript
// Standard pattern: TestingModule with manual mocks
const module: TestingModule = await Test.createTestingModule({
  providers: [
    ServiceUnderTest,
    { provide: PrismaService, useValue: mockPrisma },
    { provide: ConfigService, useValue: mockConfig },
  ],
}).compile();
```
- Mock PrismaService with jest.fn() per model method
- Mock LLMService, EmbeddingService similarly
- Use `jest.clearAllMocks()` in `beforeEach`
- Pure services (no DI needed) can be instantiated directly (see TemporalParserService)

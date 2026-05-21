# Engram Memory Pool Overhaul — Scope

**Date:** 2026-05-20  
**Status:** DRAFT  
**Branch:** staging  
**Ticket prefix:** ENG-MP (new series)

---

## Overview

The memory pool infrastructure exists in schema and API but has two categories of problems: (1) authorization bugs that make cross-user sharing impossible in practice, and (2) missing ergonomic features (agent-level grants, bulk membership). This document covers the three in-sprint tasks and defers one schema migration to a future sprint.

---

## Task 1: Fix Pool-Only Query Mode

### Background

`POST /v1/recall` accepts `poolIds?: string[]` and `agentSessionKey?: string`. When `poolIds` is given, `pgvector.provider.ts` adds a `JOIN memory_pool_memberships mpm ON mpm.memory_id = m.id AND mpm.pool_id IN (...)` to the SQL. That JOIN is the correct authorization boundary for pool-scoped queries.

`hybrid-search.service.ts` does the same for its `textSearch` path.

### Problem

Despite the JOIN, both providers still include `m.user_id = $N` (or `m.user_id IN (...)`) in `memoryWhereClause` / `whereClause` unconditionally. The userId is always passed down from `memory-query.service.ts` regardless of whether `poolIds` is set.

Result: if agent A (user="whalehawk") adds memories to a pool and grants that pool to agent B (user="beaux"), agent B's recall with `poolIds` still hits the `user_id` filter and returns zero results, because none of the pool members have `user_id = 'beaux'`.

Second bug in the same task: `getAccessiblePoolIds` in `memory-pool.service.ts` resolves SHARED pools by ANDing on `userId`:

```typescript
// Current (line ~152–160)
const sharedPools = grantedPoolIds.length > 0
  ? await this.prisma.memoryPool.findMany({
      where: {
        id: { in: grantedPoolIds },
        userId,              // <-- kills cross-user sharing
        visibility: 'SHARED',
        archivedAt: null,
      },
      ...
    })
  : [];
```

The `userId` filter here means "only return granted SHARED pools that this user owns" — which defeats the entire purpose of granting access across users.

### Solution

**`src/vector/providers/pgvector.provider.ts`**

In the `search` method, move `user_id` filter construction into a conditional block. When `options.filter?.poolIds` is non-empty, omit the `user_id` clause entirely; the pool membership JOIN provides the scope. Only `m.deleted_at IS NULL` should remain unconditional.

```typescript
// Replace the unconditional memoryWhereClause construction with:
let memoryWhereClause: string;
if (options.filter?.poolIds && options.filter.poolIds.length > 0) {
  // Pool membership JOIN is the auth boundary — no user_id filter needed
  memoryWhereClause = `m.deleted_at IS NULL`;
} else {
  if (userIds.length === 1) {
    memoryWhereClause = `m.user_id = $${paramIndex} AND m.deleted_at IS NULL`;
    params.push(userIds[0]);
    paramIndex++;
  } else {
    const userPlaceholders = userIds.map((_, i) => `$${paramIndex + i}`).join(', ');
    memoryWhereClause = `m.user_id IN (${userPlaceholders}) AND m.deleted_at IS NULL`;
    params.push(...userIds);
    paramIndex += userIds.length;
  }
}
```

Apply the same pattern to the fallback query's `WHERE` block (the `UNION ALL` branch).

**`src/vector/hybrid-search.service.ts`**

In `textSearch`, apply the same conditional. When `options.filter?.poolIds` is non-empty, set `whereClause = 'm.deleted_at IS NULL'` and skip the user ID params/placeholders.

**`src/memory-pool/memory-pool.service.ts`**

In `getAccessiblePoolIds`, remove `userId` from the SHARED pool filter:

```typescript
const sharedPools = grantedPoolIds.length > 0
  ? await this.prisma.memoryPool.findMany({
      where: {
        id: { in: grantedPoolIds },
        // Do NOT filter by userId — the grant is the authorization
        visibility: 'SHARED',
        archivedAt: null,
      },
      select: { id: true },
    })
  : [];
```

**`src/memory/memory-query.service.ts`**

No structural changes needed here, but verify the `singleUserId` fallback passed to `getAccessiblePoolIds` (line ~88) is still correct after the service-level fix. The `singleUserId ?? 'default'` string passed there is only used for GLOBAL and PRIVATE pool resolution, both of which remain user-scoped (correct behavior).

Also verify the inline BM25 FTS path (line ~241–263) — this raw SQL uses `WHERE user_id = $1` unconditionally. When `poolIds` is active and there is no userId (pool-only mode), this FTS path should either be skipped or also rewritten to omit the `user_id` filter. Safest for this sprint: skip the inline FTS block when `poolIds` is set and `singleUserId` is undefined.

### Files Changed

- `src/vector/providers/pgvector.provider.ts`
- `src/vector/hybrid-search.service.ts`
- `src/memory-pool/memory-pool.service.ts`
- `src/memory/memory-query.service.ts`

### Acceptance Criteria

- Agent A (user="whalehawk") writes memory M. Agent A creates pool P, adds M to P, grants P to agent B's session with READ permission.
- Agent B (user="beaux") calls `POST /v1/recall` with `{ query: "...", poolIds: ["<P>"] }`.
- Response includes memory M. Response does NOT include memories owned by "beaux" that are not in pool P.
- `getAccessiblePoolIds` called with agent B's session key resolves pool P in its returned set.
- Existing tests: no regression on single-user recall (poolIds not provided).

---

## Task 2: Agent-Level Pool Grants

### Background

`PoolGrant.agentSessionId` is a foreign key to `AgentSession.id`. `AgentSession` records are ephemeral — they represent a specific conversation window or task. When a session ends or is cleaned up, its grants cascade-delete. This means a team of agents cannot hold persistent pool access; every new session would need to be re-granted.

`Agent` records are persistent credentials (keyed by `apiKeyHash`). Grants on `Agent` survive across sessions.

### Problem

There is no way to say "agent Rook always has READ on pool P." Every grant must target a specific session ID. For production multi-agent setups this is unworkable: the granting agent would need to detect every new session spawned by the grantee and issue a new grant.

Additionally, `getAccessiblePoolIds` only checks `agentSession.poolGrants` (session-level grants). It does not check whether the agent itself (resolved from the API key) holds any grants.

### Solution

**Prisma schema — `prisma/schema.prisma`**

Make `agentSessionId` optional on `PoolGrant`. Add `agentId` as an optional FK to `Agent`. Add a new unique constraint for `(poolId, agentId)`. Add a `PoolGrant[]` relation on the `Agent` model. Exactly one of `agentSessionId` or `agentId` must be non-null (enforced at the service layer, not schema level for now).

```prisma
model PoolGrant {
  id             String         @id @default(cuid())
  poolId         String         @map("pool_id")
  agentSessionId String?        @map("agent_session_id")  // nullable now
  agentId        String?        @map("agent_id")           // new
  permission     PoolPermission @default(READ)
  grantedBy      String         @map("granted_by")
  grantedAt      DateTime       @default(now()) @map("granted_at")
  expiresAt      DateTime?      @map("expires_at")

  pool         MemoryPool    @relation(fields: [poolId], references: [id], onDelete: Cascade)
  agentSession AgentSession? @relation(fields: [agentSessionId], references: [id], onDelete: Cascade)
  agent        Agent?        @relation(fields: [agentId], references: [id], onDelete: Cascade)

  @@unique([poolId, agentSessionId])
  @@unique([poolId, agentId])            // new
  @@map("pool_grants")
}

model Agent {
  // ... existing fields ...
  poolGrants PoolGrant[]  // new relation
}
```

**DTO — `src/memory-pool/dto/memory-pool.dto.ts`**

Make `agentSessionId` optional and add `agentId` as an alternative:

```typescript
export class GrantPoolAccessDto {
  @IsString()
  @IsOptional()
  agentSessionId?: string;  // AgentSession.id

  @IsString()
  @IsOptional()
  agentId?: string;         // Agent.id

  @ApiPropertyOptional({ enum: ['READ', 'WRITE', 'ADMIN'], type: String })
  @IsEnum(PoolPermission)
  @IsOptional()
  permission?: string;

  @IsString()
  grantedBy: string;
}
```

Add a class-level validator (or manual check in the service) that exactly one of `agentSessionId` / `agentId` is present.

**Service — `src/memory-pool/memory-pool.service.ts`**

Update `grantAccess` to branch on which identifier was provided:

```typescript
async grantAccess(poolId: string, dto: GrantPoolAccessDto) {
  await this.getById(poolId);

  if (!dto.agentSessionId && !dto.agentId) {
    throw new BadRequestException('Provide either agentSessionId or agentId');
  }
  if (dto.agentSessionId && dto.agentId) {
    throw new BadRequestException('Provide only one of agentSessionId or agentId');
  }

  if (dto.agentSessionId) {
    return this.prisma.poolGrant.upsert({
      where: { poolId_agentSessionId: { poolId, agentSessionId: dto.agentSessionId } },
      update: { permission: (dto.permission ?? 'READ') as any, grantedBy: dto.grantedBy },
      create: { poolId, agentSessionId: dto.agentSessionId, permission: (dto.permission ?? 'READ') as any, grantedBy: dto.grantedBy },
    });
  } else {
    return this.prisma.poolGrant.upsert({
      where: { poolId_agentId: { poolId, agentId: dto.agentId! } },
      update: { permission: (dto.permission ?? 'READ') as any, grantedBy: dto.grantedBy },
      create: { poolId, agentId: dto.agentId!, permission: (dto.permission ?? 'READ') as any, grantedBy: dto.grantedBy },
    });
  }
}
```

Update `revokeAccess` similarly — accept either `agentSessionId` or `agentId` as the identifier param, delete the matching row.

Update `getAccessiblePoolIds` signature to also accept `agentId?: string`. When present, query agent-level grants:

```typescript
async getAccessiblePoolIds(
  sessionKey: string,
  userId: string,
  agentId?: string,
): Promise<string[]> {
  // ... existing session grants resolution ...

  // Agent-level grants (persistent)
  let agentGrantedPoolIds: string[] = [];
  if (agentId) {
    const agentGrants = await this.prisma.poolGrant.findMany({
      where: { agentId },
      select: { poolId: true },
    });
    agentGrantedPoolIds = agentGrants.map((g) => g.poolId);
  }

  const allIds = new Set([
    ...globalPools.map((p) => p.id),
    ...sharedPools.map((p) => p.id),
    ...privatePools.map((p) => p.id),
    ...agentGrantedPoolIds,
  ]);

  return Array.from(allIds);
}
```

The `agentId` must be threaded in from the recall path. `memory-query.service.ts` currently calls `this.memoryPoolService.getAccessiblePoolIds(dto.agentSessionKey, singleUserId ?? 'default')`. The API key guard sets `request.agent` (the full `Agent` record). This needs to be plumbed to the query service call site. The exact wiring depends on how `MemoryQueryService.recall` receives auth context — trace from `memory-query.controller.ts` to confirm `request.agent.id` is accessible there and pass it through `QueryMemoryDto` or a separate param.

**Controller — `src/memory-pool/memory-pool.controller.ts`**

Update the revoke endpoint. Currently `DELETE /v1/pools/:id/grant/:sessionId` — the `:sessionId` path param is now ambiguous. Options:
- Keep the path param name as `:granteeId` and accept a query param `?type=session|agent` to differentiate
- Or add a separate `DELETE /v1/pools/:id/grant/agent/:agentId` endpoint

Recommended: add a separate `DELETE /v1/pools/:id/grant/agent/:agentId` endpoint and keep the existing session revoke route unchanged. This avoids a breaking change.

**Migration**

New migration file under `prisma/migrations/`. Name: `<timestamp>_pool_grant_agent_id`.

The migration must:
1. Add `agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE` (nullable)
2. Make `agent_session_id` nullable: `ALTER TABLE pool_grants ALTER COLUMN agent_session_id DROP NOT NULL`
3. Add unique index: `CREATE UNIQUE INDEX pool_grants_pool_id_agent_id_key ON pool_grants(pool_id, agent_id) WHERE agent_id IS NOT NULL`
4. Add index: `CREATE INDEX pool_grants_agent_id_idx ON pool_grants(agent_id)`

Use a partial unique index (WHERE agent_id IS NOT NULL) to avoid false uniqueness conflicts with rows that have `agent_id = NULL`.

### Files Changed

- `prisma/schema.prisma`
- `prisma/migrations/<timestamp>_pool_grant_agent_id/migration.sql` (new)
- `src/memory-pool/dto/memory-pool.dto.ts`
- `src/memory-pool/memory-pool.service.ts`
- `src/memory-pool/memory-pool.controller.ts`
- `src/memory/memory-query.service.ts` (thread `agentId` to pool resolution call)
- `src/memory/dto/query-memory.dto.ts` (verify agentId is plumbable or add field)

### Acceptance Criteria

- `POST /v1/pools/:id/grant` with `{ agentId: "<Agent.id>", permission: "READ", grantedBy: "..." }` creates a `PoolGrant` row with `agentSessionId = NULL`.
- `POST /v1/pools/:id/grant` with `{ agentSessionId: "...", ... }` continues to work as before.
- `POST /v1/pools/:id/grant` with both `agentId` and `agentSessionId` returns 400.
- `POST /v1/pools/:id/grant` with neither returns 400.
- Agent Rook has an agent-level grant on pool P. A new session is created for Rook (new `AgentSession` record). Recall with `agentSessionKey` of the new session still resolves pool P via `getAccessiblePoolIds`.
- `DELETE /v1/pools/:id/grant/agent/:agentId` removes the agent-level grant.
- Existing session-scoped grant/revoke routes are unbroken (no regression).

---

## Task 3: Bulk Add Memories to Pool

### Background

`POST /v1/pools/:id/memories` adds a single memory per call. Populating a pool with 500 existing memories requires 500 sequential HTTP round-trips. No batching primitive exists.

### Problem

Operational friction. When an agent indexes a document corpus or backfills historical memories into a pool, single-add is prohibitively slow. A 100ms round-trip × 500 calls = 50s minimum, plus connection overhead.

### Solution

**New endpoint:** `POST /v1/pools/:id/memories/bulk`

Note: this route must be registered before `POST /v1/pools/:id/memories` in the controller, or NestJS route matching may shadow it. In practice, the distinct path suffix `bulk` prevents collision, but confirm order during implementation.

**Request body:**

```typescript
export class BulkAddMemoriesToPoolDto {
  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)  // guard against abuse
  memoryIds: string[];

  @IsString()
  addedBy: string;
}
```

**Response:**

```typescript
{ added: number, skipped: number }
```

**Service — `src/memory-pool/memory-pool.service.ts`**

```typescript
async addMemoriesBulk(
  poolId: string,
  dto: BulkAddMemoriesToPoolDto,
): Promise<{ added: number; skipped: number }> {
  await this.getById(poolId);

  const data = dto.memoryIds.map((memoryId) => ({
    memoryId,
    poolId,
    addedBy: dto.addedBy,
  }));

  const result = await this.prisma.memoryPoolMembership.createMany({
    data,
    skipDuplicates: true,
  });

  return {
    added: result.count,
    skipped: dto.memoryIds.length - result.count,
  };
}
```

`createMany` with `skipDuplicates: true` maps to `INSERT ... ON CONFLICT DO NOTHING`. Prisma returns the count of actually-inserted rows. `skipped = total - inserted`.

**Controller — `src/memory-pool/memory-pool.controller.ts`**

```typescript
@Post(':id/memories/bulk')
@ApiOperation({ summary: 'Bulk add memories to pool' })
async addMemoriesBulk(
  @Param('id') id: string,
  @Body() dto: BulkAddMemoriesToPoolDto,
) {
  return this.service.addMemoriesBulk(id, dto);
}
```

No migration required. `MemoryPoolMembership` schema is unchanged.

### Files Changed

- `src/memory-pool/memory-pool.controller.ts`
- `src/memory-pool/memory-pool.service.ts`
- `src/memory-pool/dto/memory-pool.dto.ts`

### Acceptance Criteria

- `POST /v1/pools/:id/memories/bulk` with `{ memoryIds: ["a","b","c"], addedBy: "session-key" }` inserts all three. Response: `{ added: 3, skipped: 0 }`.
- Calling the same endpoint again with the same IDs returns `{ added: 0, skipped: 3 }` (no duplicates, no error).
- Mixed case (some new, some duplicate): counts are accurate.
- Empty `memoryIds` array returns 400 (class-validator `@ArrayMinSize(1)`).
- `memoryIds` array > 1000 returns 400 (`@ArrayMaxSize(1000)`).
- Pool not found returns 404 (via `getById` guard).

---

## Future Work: Account-Scoped Pool Ownership (Task 4 — Deferred)

**Not in scope for this sprint.**

`MemoryPool.userId` binds pool ownership to a single user record. The practical consequence: `listByUser` can only return pools the requesting user owns, not pools owned by other users in the same account. If an account-level shared pool is desired (any user in the account can see it), there is no mechanism for it.

The correct fix is to add `accountId String? @map("account_id")` to `MemoryPool` and migrate pool-owning queries to filter by `accountId` rather than `userId`. This involves:

- New nullable `account_id` column on `memory_pools`
- Backfill: for each pool, resolve `userId → User.accountId → set account_id`
- Update `@@unique([userId, name])` constraint — this may need to become `@@unique([accountId, name])` or be dropped if name uniqueness is not enforced at account level
- Update `findOrCreatePool` and `listByUser` (which becomes `listByAccount`)
- Update all callers that pass `userId` to pool creation

This is a breaking schema migration requiring a multi-step deploy (add column, backfill, switch reads, drop old constraint). Schedule for a dedicated sprint with a migration runbook.

---

## Testing

### Task 1

- **Unit:** `PgVectorProvider.search` — mock `prisma.$queryRawUnsafe`, assert that when `options.filter.poolIds` is non-empty the generated SQL string does not contain `user_id` and does contain `JOIN memory_pool_memberships`.
- **Unit:** `HybridSearchService.textSearch` — same assertion for the text search SQL.
- **Unit:** `MemoryPoolService.getAccessiblePoolIds` — mock `prisma.memoryPool.findMany` for the shared-pool case; assert it is called without `userId` in the `where` clause.
- **Integration:** Two users in same account, cross-user pool share scenario. Verify recall with explicit `poolIds` returns cross-user memories.
- **Regression:** Single-user recall without `poolIds` still applies `user_id` filter (existing tests should cover this).

### Task 2

- **Unit:** `MemoryPoolService.grantAccess` — test session branch, agent branch, both-provided error, neither-provided error.
- **Unit:** `MemoryPoolService.revokeAccess` — test both agent and session paths.
- **Unit:** `MemoryPoolService.getAccessiblePoolIds` — assert that when `agentId` is passed, grants on that agent are included in the returned set independent of session.
- **Integration:** Create a pool, grant to `Agent.id`. Spawn a new `AgentSession` for that agent. Call `getAccessiblePoolIds` with the new session key and the agent's ID. Pool is present in result.
- **Schema:** Migration test — existing `PoolGrant` rows (with `agentSessionId`) still work after migration; `agentSessionId` nullable, no existing data broken.

### Task 3

- **Unit:** `MemoryPoolService.addMemoriesBulk` — mock `prisma.memoryPoolMembership.createMany`, assert `skipDuplicates: true`, assert return shape.
- **Unit:** Controller route — `POST /v1/pools/:id/memories/bulk` resolves to `addMemoriesBulk` (not `addMemory`).
- **Integration:** Insert 200 memory IDs in one call, verify count, verify no duplicates on second call.
- **Validation:** Empty array → 400, array of 1001 → 400, missing `addedBy` → 400.

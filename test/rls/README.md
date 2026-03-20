# RLS Isolation Test Suite

## Purpose

Verifies that **no API endpoint leaks data across tenant boundaries**. This suite exists because we shipped RLS bugs to production on March 8, 2026 (dashboard and awareness endpoints exposed cross-account data).

## How It Works

1. **Canary Factory** seeds two users with 25 memories each
2. Each user's memories contain a unique canary string (`RLS_CANARY_A_*` / `RLS_CANARY_B_*`)
3. Every data-reading endpoint is tested in both directions:
   - Request as User A → assert response contains zero `RLS_CANARY_B_` strings
   - Request as User B → assert response contains zero `RLS_CANARY_A_` strings
4. The check uses raw `JSON.stringify()` on the entire response body — no canary can hide in nested objects

## Running

```bash
# Run the full RLS suite
npx jest test/rls/ --runInBand --forceExit

# Run just critical endpoints
npx jest test/rls/ --runInBand --forceExit -t "critical"
```

**Requires:** A running PostgreSQL test database (not production!). The suite refuses to run if `DATABASE_URL` points to Railway/Supabase/Neon.

## Adding New Endpoints

### Automatic
If a new controller adds routes under `/v1/`, the `discoverRoutes()` function will pick them up automatically via NestJS route introspection.

### Manual (for high-risk endpoints)
Add to `CRITICAL_ENDPOINTS` in `endpoint-discovery.ts`:

```typescript
{
  method: 'get',
  path: '/v1/new-endpoint',
  label: 'New endpoint description',
  priority: 'critical',  // or 'high'
}
```

## CI Integration

This suite runs as part of the PR CI pipeline. **Any canary violation is a hard failure** — there are no thresholds or soft warnings. A single leaked canary blocks the merge.

## Files

| File | Purpose |
|------|---------|
| `isolation.e2e-spec.ts` | Main test suite |
| `endpoint-discovery.ts` | Static + dynamic endpoint list |
| `canary-factory.ts` | Seeds test users with canary memories |
| `README.md` | This file |

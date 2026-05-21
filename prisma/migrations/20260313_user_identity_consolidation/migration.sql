-- Migration: user-identity-consolidation
-- Users scoped to accounts, not agents. Fixes fragmented user records.
-- Per spec: heybeaux/ops specs/user-identity-consolidation-spec.md

-- Step 1: Add accountId column (nullable initially to allow backfill)
ALTER TABLE "users" ADD COLUMN "account_id" TEXT;

-- Step 2: Add new columns
ALTER TABLE "users" ADD COLUMN "is_default" BOOLEAN NOT NULL DEFAULT false;

-- Step 3: Backfill account_id from the agent's account
UPDATE "users" u
SET "account_id" = a."account_id"
FROM "agents" a
WHERE u."agent_id" = a."id"
  AND a."account_id" IS NOT NULL;

-- Step 4: For users whose agent has no account, use the first account
UPDATE "users" u
SET "account_id" = (SELECT id FROM "accounts" ORDER BY "created_at" ASC LIMIT 1)
WHERE u."account_id" IS NULL;

-- Step 5: Make account_id NOT NULL now that it's been backfilled
ALTER TABLE "users" ALTER COLUMN "account_id" SET NOT NULL;

-- Step 6: Drop old unique constraint on (agent_id, external_id)
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_agent_id_external_id_key";

-- Step 7: Add new unique constraint on (account_id, external_id)
-- Note: duplicate (account_id, external_id) pairs may exist post-backfill.
-- Run consolidate-users.ts script FIRST to deduplicate, then apply this constraint.
-- The constraint creation is done after deduplication:
-- ALTER TABLE "users" ADD CONSTRAINT "users_account_id_external_id_key" UNIQUE ("account_id", "external_id");

-- Step 8: Add foreign key from users.account_id → accounts.id
ALTER TABLE "users"
  ADD CONSTRAINT "users_account_id_fkey"
  FOREIGN KEY ("account_id")
  REFERENCES "accounts"("id")
  ON DELETE CASCADE;

-- Step 9: Add index on account_id for fast lookups
CREATE INDEX IF NOT EXISTS "users_account_id_idx" ON "users"("account_id");
CREATE INDEX IF NOT EXISTS "users_account_id_external_id_idx" ON "users"("account_id", "external_id");
CREATE INDEX IF NOT EXISTS "users_account_id_is_default_idx" ON "users"("account_id", "is_default");

-- Step 10: Make agent_id nullable (transition period — still populated on old rows)
-- This allows new inserts that don't specify agent_id (users now owned by accounts, not agents).
ALTER TABLE "users" ALTER COLUMN "agent_id" DROP NOT NULL;

-- NOTE: agent_id column is intentionally left in place during transition.
-- After consolidation script is run and verified, a follow-up migration
-- should drop the column and remove the old FK constraint.

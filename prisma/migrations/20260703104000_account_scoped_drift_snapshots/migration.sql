-- Scope new embedding drift snapshots to an account.
-- Existing historical rows remain NULL and are treated as legacy/global.
ALTER TABLE "drift_snapshots"
  ADD COLUMN IF NOT EXISTS "account_id" TEXT;

CREATE INDEX IF NOT EXISTS "drift_snapshots_account_id_model_id_created_at_idx"
  ON "drift_snapshots"("account_id", "model_id", "created_at");

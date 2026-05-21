-- GIN-43: Add optimistic concurrency version counter to memories table
-- Idempotent: only adds the column if it does not already exist.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memories' AND column_name = 'version'
  ) THEN
    ALTER TABLE "memories" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$;

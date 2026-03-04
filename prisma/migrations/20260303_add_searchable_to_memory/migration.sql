-- Add searchable column to Memory table
-- This column controls whether a memory appears in search results.
-- Dream-cycle and consolidation memories are marked non-searchable by the subsequent backfill migration.
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "searchable" BOOLEAN NOT NULL DEFAULT true;

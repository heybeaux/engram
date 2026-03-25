-- Migration: add processedAt watermark to Memory model
-- Phase 0 scalability: tracks when a memory was last processed by the dream cycle.
-- Enables future delta-only processing for stages where it is provably safe.

ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "processed_at" TIMESTAMP(3);

-- Index for efficient delta queries: find unprocessed memories per user
CREATE INDEX IF NOT EXISTS "memories_user_id_processed_at_idx" ON "memories"("user_id", "processed_at");

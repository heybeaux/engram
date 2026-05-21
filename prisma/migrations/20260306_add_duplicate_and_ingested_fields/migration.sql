-- Migration: HEY-462 — Add DUPLICATE embedding status, isDuplicateOf, ingestedAt
-- Moves dedup from synchronous HTTP path into BullMQ embedding worker

-- 1. Add DUPLICATE value to the EmbeddingStatus enum
ALTER TYPE "EmbeddingStatus" ADD VALUE IF NOT EXISTS 'DUPLICATE';

-- 2. Add is_duplicate_of column to memories (nullable FK-style reference to existing memory id)
ALTER TABLE "memories"
  ADD COLUMN IF NOT EXISTS "is_duplicate_of" TEXT,
  ADD COLUMN IF NOT EXISTS "ingested_at" TIMESTAMP(3) NOT NULL DEFAULT NOW();

-- Migration: add_memory_version
-- GIN-43: Adds optimistic concurrency version counter to memories table.
-- This migration was missing when version Int @default(0) was added to
-- schema.prisma in commit 1fe8234, causing P2022 ColumnNotFound errors in CI.

ALTER TABLE memories ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;

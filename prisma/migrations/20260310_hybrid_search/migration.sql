-- Migration: ENG-26 — Hybrid Search (BM25 + pgvector fusion)
-- Adds full-text search index and trigram support for keyword matching

-- 1. Enable pg_trgm extension for fuzzy matching
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. Add generated tsvector column for full-text search
ALTER TABLE memories ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(raw, ''))) STORED;

-- 3. Create GIN index for full-text search
CREATE INDEX IF NOT EXISTS idx_memories_search_vector ON memories USING GIN (search_vector);

-- 4. Create trigram index for fuzzy keyword matching
CREATE INDEX IF NOT EXISTS idx_memories_raw_trgm ON memories USING GIN (raw gin_trgm_ops);

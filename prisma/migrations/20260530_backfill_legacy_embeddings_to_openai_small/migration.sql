-- Backfill legacy memories.embedding (1536-d OpenAI text-embedding-3-small) into
-- the new embedding_openai_small table.
--
-- Context: Production has ~30,926 memories with real 1536-d embeddings in the legacy
-- column. The per-model tables migration (20260525_per_model_embedding_tables) created
-- embedding_openai_small but left it empty. This backfill populates it so the new
-- EmbeddingDiscriminatorService has data to serve immediately after deploy.
--
-- The legacy memories.embedding column is NOT nulled here — that's a later migration
-- once we've verified the per-model tables are serving recall correctly.
--
-- ON CONFLICT DO NOTHING: safe to re-run; the UNIQUE constraint on memory_id prevents
-- duplicate inserts. gen_random_uuid() for id since we have no existing ID to reuse.

INSERT INTO "embedding_openai_small" (
  "id",
  "memory_id",
  "model_version",
  "created_at",
  "embedding"
)
SELECT
  gen_random_uuid()::text,
  m."id",
  'text-embedding-3-small',
  now(),
  m."embedding"
FROM "memories" m
WHERE m."embedding" IS NOT NULL
ON CONFLICT ("memory_id") DO NOTHING;

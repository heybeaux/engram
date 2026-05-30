-- PROD-ONLY: Fake-apply 20260520_memories_embedding_768 without running it.
--
-- Context: That migration ALTERs memories.embedding to vector(768) for the local bge model.
-- On staging, all embeddings were NULL (no local-embed writes), so the type swap was safe.
-- On production, 30,926 of 31,205 rows have real 1536-d OpenAI embeddings — running the
-- ALTER would destroy them. We mark it as applied so Prisma skips it permanently.
--
-- Guard: the INSERT is conditional on the row not already existing, making it idempotent.

INSERT INTO "_prisma_migrations" (
  "id",
  "checksum",
  "finished_at",
  "migration_name",
  "logs",
  "rolled_back_at",
  "started_at",
  "applied_steps_count"
)
SELECT
  gen_random_uuid()::text,
  'skip-on-prod-embeddings-are-1536d-not-768d',
  now(),
  '20260520_memories_embedding_768',
  'Skipped on production: memories.embedding is dimensionless vector with 30926 live 1536-d OpenAI embeddings. ALTER TYPE to vector(768) would corrupt data. Marked applied without execution.',
  NULL,
  now(),
  1
WHERE NOT EXISTS (
  SELECT 1 FROM "_prisma_migrations"
  WHERE "migration_name" = '20260520_memories_embedding_768'
);

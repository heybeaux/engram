-- Resize legacy memories.embedding column from vector(1536) (OpenAI text-embedding-3-small)
-- to vector(768) to match the local bge-base-en-v1.5 provider that pipeline.upsert() writes.
-- All existing values are NULL (no successful local-embed writes ever landed), so this is
-- a pure type swap with no data migration. HNSW index is rebuilt for the new dimension.

DROP INDEX IF EXISTS memories_embedding_idx;
DROP INDEX IF EXISTS memories_embedding_hnsw_idx;

ALTER TABLE memories
  ALTER COLUMN embedding TYPE vector(768);

CREATE INDEX memories_embedding_hnsw_idx
  ON memories
  USING hnsw ((embedding::vector(768)) vector_cosine_ops)
  WITH (m = '16', ef_construction = '64')
  WHERE (embedding IS NOT NULL);

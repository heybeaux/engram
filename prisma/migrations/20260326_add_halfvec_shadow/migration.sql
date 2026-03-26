-- ENG-51: Add halfvec(768) shadow column for benchmarking float16 vs float32
-- Non-destructive: adds a new column alongside existing embedding column

-- Require pgvector >= 0.7.0 for halfvec support
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'vector'
    AND string_to_array(extversion, '.')::int[] >= ARRAY[0,7,0]
  ) THEN
    RAISE EXCEPTION 'pgvector >= 0.7.0 required for halfvec support. Current version: %',
      (SELECT extversion FROM pg_extension WHERE extname = 'vector');
  END IF;
END $$;

-- Add halfvec shadow column to memory_embeddings
ALTER TABLE memory_embeddings ADD COLUMN IF NOT EXISTS embedding_halfvec halfvec(768);

-- Create HNSW index for halfvec cosine similarity search
CREATE INDEX IF NOT EXISTS memory_embeddings_halfvec_idx
ON memory_embeddings USING hnsw (embedding_halfvec halfvec_cosine_ops);

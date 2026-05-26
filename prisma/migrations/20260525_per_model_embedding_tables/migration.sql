-- feat/embed-per-model-tables
-- Per-model embedding tables with fixed dimensions for targeted ANN queries.
-- ivfflat lists tuned to sqrt(N) for an assumed 10k-memory baseline per model.
-- EmbeddingNomic is QUARANTINED — table created for backfill only.
--
-- DO NOT apply with `prisma migrate dev` — shadow DB lacks pgvector superuser.
-- Apply via: psql $DATABASE_URL -f this_file  (ops agent responsibility)

-- ── OpenAI text-embedding-3-small (1536d) ──────────────────────────────────

CREATE TABLE IF NOT EXISTS "embedding_openai_small" (
  "id"            TEXT        NOT NULL,
  "memory_id"     TEXT        NOT NULL,
  "model_version" TEXT        NOT NULL,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "embedding"     vector(1536),

  CONSTRAINT "embedding_openai_small_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "embedding_openai_small_memory_id_key" UNIQUE ("memory_id"),
  CONSTRAINT "embedding_openai_small_memory_id_fkey"
    FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE
);

-- ivfflat: lists ≈ sqrt(10000) = 100
CREATE INDEX IF NOT EXISTS "embedding_openai_small_embedding_ivfflat_idx"
  ON "embedding_openai_small"
  USING ivfflat ("embedding" vector_cosine_ops)
  WITH (lists = 100)
  WHERE "embedding" IS NOT NULL;

-- ── BGE-base-en-v1.5 (768d) ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "embedding_bge_base" (
  "id"            TEXT        NOT NULL,
  "memory_id"     TEXT        NOT NULL,
  "model_version" TEXT        NOT NULL,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "embedding"     vector(768),

  CONSTRAINT "embedding_bge_base_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "embedding_bge_base_memory_id_key" UNIQUE ("memory_id"),
  CONSTRAINT "embedding_bge_base_memory_id_fkey"
    FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE
);

-- ivfflat: lists ≈ sqrt(10000) = 100
CREATE INDEX IF NOT EXISTS "embedding_bge_base_embedding_ivfflat_idx"
  ON "embedding_bge_base"
  USING ivfflat ("embedding" vector_cosine_ops)
  WITH (lists = 100)
  WHERE "embedding" IS NOT NULL;

-- ── all-MiniLM-L6-v2 (384d) ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "embedding_minilm" (
  "id"            TEXT        NOT NULL,
  "memory_id"     TEXT        NOT NULL,
  "model_version" TEXT        NOT NULL,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "embedding"     vector(384),

  CONSTRAINT "embedding_minilm_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "embedding_minilm_memory_id_key" UNIQUE ("memory_id"),
  CONSTRAINT "embedding_minilm_memory_id_fkey"
    FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE
);

-- ivfflat: lists ≈ sqrt(10000) = 100
CREATE INDEX IF NOT EXISTS "embedding_minilm_embedding_ivfflat_idx"
  ON "embedding_minilm"
  USING ivfflat ("embedding" vector_cosine_ops)
  WITH (lists = 100)
  WHERE "embedding" IS NOT NULL;

-- ── nomic-embed-text-v1 (768d) — QUARANTINED ───────────────────────────────
-- Table exists for backfill only. Do not route new writes here.

CREATE TABLE IF NOT EXISTS "embedding_nomic" (
  "id"            TEXT        NOT NULL,
  "memory_id"     TEXT        NOT NULL,
  "model_version" TEXT        NOT NULL,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "embedding"     vector(768),

  CONSTRAINT "embedding_nomic_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "embedding_nomic_memory_id_key" UNIQUE ("memory_id"),
  CONSTRAINT "embedding_nomic_memory_id_fkey"
    FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE
);

-- ivfflat: lists = 50 (smaller — quarantined, lower expected volume)
CREATE INDEX IF NOT EXISTS "embedding_nomic_embedding_ivfflat_idx"
  ON "embedding_nomic"
  USING ivfflat ("embedding" vector_cosine_ops)
  WITH (lists = 50)
  WHERE "embedding" IS NOT NULL;

-- ── Reverse-relation columns on memories ───────────────────────────────────
-- No DDL needed: Prisma reverse relations are virtual (no FK column on memories).
-- The FKs live on the embedding_* tables (memory_id) and reference memories.id.

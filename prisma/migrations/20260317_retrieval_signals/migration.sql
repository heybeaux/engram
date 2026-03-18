-- CreateEnum: RetrievalSignalType
DO $$ BEGIN
  CREATE TYPE "RetrievalSignalType" AS ENUM (
    'RESULT_CONSUMED',
    'RESULT_IGNORED',
    'QUERY_REFORMULATED',
    'RESULT_CITED',
    'NULL_RESULT',
    'EXPLICIT_HIT',
    'EXPLICIT_MISS',
    'EXPLICIT_IRRELEVANT',
    'EXPLICIT_PARTIAL',
    'SESSION_CONTINUATION'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum: QueryType
DO $$ BEGIN
  CREATE TYPE "QueryType" AS ENUM ('FACTUAL', 'SEMANTIC', 'TEMPORAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable: retrieval_signals
CREATE TABLE IF NOT EXISTS "retrieval_signals" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "query_id" TEXT NOT NULL,
    "memory_id" TEXT,
    "signal_type" "RetrievalSignalType" NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL,
    "strategy_id" TEXT,
    "rank" INTEGER,
    "propensity" DOUBLE PRECISION,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "retrieval_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable: retrieval_logs
CREATE TABLE IF NOT EXISTS "retrieval_logs" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "query_text" TEXT NOT NULL,
    "query_type" "QueryType",
    "strategy_config" JSONB,
    "result_count" INTEGER NOT NULL DEFAULT 0,
    "latency_ms" INTEGER NOT NULL,
    "arm_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retrieval_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable: retrieval_strategy_profiles
CREATE TABLE IF NOT EXISTS "retrieval_strategy_profiles" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "rrf_k" DOUBLE PRECISION NOT NULL DEFAULT 60,
    "vector_weight" DOUBLE PRECISION NOT NULL DEFAULT 0.6,
    "bm25_weight" DOUBLE PRECISION NOT NULL DEFAULT 0.4,
    "temporal_decay_enabled" BOOLEAN NOT NULL DEFAULT false,
    "confidence_score" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "signal_count" INTEGER NOT NULL DEFAULT 0,
    "embedding_model_version" TEXT,
    "last_optimized_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "previous_params" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "retrieval_strategy_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "retrieval_signals_account_id_created_at_idx" ON "retrieval_signals"("account_id", "created_at");
CREATE INDEX IF NOT EXISTS "retrieval_signals_query_id_idx" ON "retrieval_signals"("query_id");
CREATE INDEX IF NOT EXISTS "retrieval_signals_memory_id_idx" ON "retrieval_signals"("memory_id");

CREATE INDEX IF NOT EXISTS "retrieval_logs_account_id_created_at_idx" ON "retrieval_logs"("account_id", "created_at");

CREATE UNIQUE INDEX IF NOT EXISTS "retrieval_strategy_profiles_account_id_key" ON "retrieval_strategy_profiles"("account_id");

-- CreateTable
CREATE TABLE IF NOT EXISTS "query_logs" (
    "id" TEXT NOT NULL,
    "query_text" TEXT NOT NULL,
    "query_embedding" DOUBLE PRECISION[],
    "agent_id" TEXT,
    "session_key" TEXT,
    "results_returned" JSONB NOT NULL,
    "result_count" INTEGER NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "query_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "query_logs_agent_id_created_at_idx" ON "query_logs"("agent_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "query_logs_session_key_created_at_idx" ON "query_logs"("session_key", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "query_logs_created_at_idx" ON "query_logs"("created_at");

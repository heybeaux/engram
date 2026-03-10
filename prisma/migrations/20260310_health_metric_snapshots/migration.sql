-- CreateTable: health_metric_snapshots
-- Stores historical point-in-time health metric readings for graphing/trending.

CREATE TABLE "health_metric_snapshots" (
  "id"          TEXT         NOT NULL DEFAULT gen_random_uuid()::text,
  "account_id"  TEXT         NOT NULL,
  "agent_id"    TEXT,
  "metric_name" TEXT         NOT NULL,
  "value"       DOUBLE PRECISION NOT NULL,
  "metadata"    JSONB,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "health_metric_snapshots_pkey" PRIMARY KEY ("id")
);

-- Index on accountId for per-account queries
CREATE INDEX "health_metric_snapshots_account_id_idx"
  ON "health_metric_snapshots"("account_id");

-- Index on agentId for per-agent queries
CREATE INDEX "health_metric_snapshots_agent_id_idx"
  ON "health_metric_snapshots"("agent_id");

-- Composite index for history queries: accountId + metricName + createdAt
CREATE INDEX "health_metric_snapshots_account_metric_time_idx"
  ON "health_metric_snapshots"("account_id", "metric_name", "created_at" DESC);

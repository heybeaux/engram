-- ENG-120: Add memory_edges table for typed graph relationships between memories

CREATE TABLE IF NOT EXISTS "memory_edges" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "source_id" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "edge_type" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "temporal_start" TIMESTAMP(3),
    "temporal_end" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "agent_id" TEXT NOT NULL,

    CONSTRAINT "memory_edges_pkey" PRIMARY KEY ("id")
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS "memory_edges_source_id_idx" ON "memory_edges"("source_id");
CREATE INDEX IF NOT EXISTS "memory_edges_target_id_idx" ON "memory_edges"("target_id");
CREATE INDEX IF NOT EXISTS "memory_edges_edge_type_idx" ON "memory_edges"("edge_type");
CREATE INDEX IF NOT EXISTS "memory_edges_agent_id_idx" ON "memory_edges"("agent_id");

-- Foreign keys with cascade delete
ALTER TABLE "memory_edges" ADD CONSTRAINT "memory_edges_source_id_fkey"
    FOREIGN KEY ("source_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "memory_edges" ADD CONSTRAINT "memory_edges_target_id_fkey"
    FOREIGN KEY ("target_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- HEY-414: Add lastDreamedAt, tier fields + ConsolidationSource model

-- Add lastDreamedAt field to memories table
ALTER TABLE "memories" ADD COLUMN "last_dreamed_at" TIMESTAMP(3);

-- Add tier field to memories table  
ALTER TABLE "memories" ADD COLUMN "tier" TEXT;

-- Create ConsolidationSource model
CREATE TABLE "consolidation_sources" (
    "id" TEXT NOT NULL,
    "consolidation_job_id" TEXT NOT NULL,
    "source_memory_id" TEXT NOT NULL,
    "target_memory_id" TEXT,
    "contribution_type" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consolidation_sources_pkey" PRIMARY KEY ("id")
);

-- Add indexes for ConsolidationSource
CREATE INDEX "consolidation_sources_consolidation_job_id_idx" ON "consolidation_sources"("consolidation_job_id");
CREATE INDEX "consolidation_sources_source_memory_id_idx" ON "consolidation_sources"("source_memory_id");
CREATE INDEX "consolidation_sources_target_memory_id_idx" ON "consolidation_sources"("target_memory_id");
CREATE INDEX "consolidation_sources_contribution_type_idx" ON "consolidation_sources"("contribution_type");

-- Add foreign key constraints
ALTER TABLE "consolidation_sources" ADD CONSTRAINT "consolidation_sources_consolidation_job_id_fkey" FOREIGN KEY ("consolidation_job_id") REFERENCES "consolidation_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "consolidation_sources" ADD CONSTRAINT "consolidation_sources_source_memory_id_fkey" FOREIGN KEY ("source_memory_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "consolidation_sources" ADD CONSTRAINT "consolidation_sources_target_memory_id_fkey" FOREIGN KEY ("target_memory_id") REFERENCES "memories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Add indexes for new memory fields
CREATE INDEX "memories_last_dreamed_at_idx" ON "memories"("last_dreamed_at");
CREATE INDEX "memories_tier_idx" ON "memories"("tier");

-- Migration: Add DedupCandidate table for automated dedup pipeline (ENG Factory Wave 5)

CREATE TABLE IF NOT EXISTS "dedup_candidates" (
    "id"               TEXT         NOT NULL,
    "memory_id_1"      TEXT         NOT NULL,
    "memory_id_2"      TEXT         NOT NULL,
    "similarity_score" DOUBLE PRECISION NOT NULL,
    "detection_method" TEXT         NOT NULL,
    "classification"   TEXT,
    "confidence"       DOUBLE PRECISION,
    "merged_content"   TEXT,
    "reasoning"        TEXT,
    "status"           TEXT         NOT NULL DEFAULT 'PENDING',
    "classified_at"    TIMESTAMP(3),
    "resolved_at"      TIMESTAMP(3),
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dedup_candidates_pkey" PRIMARY KEY ("id")
);

-- Foreign keys
ALTER TABLE "dedup_candidates"
    ADD CONSTRAINT "dedup_candidates_memory_id_1_fkey"
    FOREIGN KEY ("memory_id_1") REFERENCES "memories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "dedup_candidates"
    ADD CONSTRAINT "dedup_candidates_memory_id_2_fkey"
    FOREIGN KEY ("memory_id_2") REFERENCES "memories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Unique pair constraint
CREATE UNIQUE INDEX IF NOT EXISTS "dedup_candidates_memory_id_1_memory_id_2_key"
    ON "dedup_candidates"("memory_id_1", "memory_id_2");

-- Indexes
CREATE INDEX IF NOT EXISTS "dedup_candidates_status_idx"         ON "dedup_candidates"("status");
CREATE INDEX IF NOT EXISTS "dedup_candidates_classification_idx" ON "dedup_candidates"("classification");
CREATE INDEX IF NOT EXISTS "dedup_candidates_created_at_idx"     ON "dedup_candidates"("created_at");

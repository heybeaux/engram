-- CreateEnum
CREATE TYPE "TemporalAnchorSource" AS ENUM ('EXPLICIT_CALLER', 'INFERRED_FROM_CONTENT', 'FALLBACK_RECORDED_AT');

-- CreateEnum
CREATE TYPE "EventTimeConfidence" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "EventTimeExtractor" AS ENUM ('REGEX', 'DATEPARSER', 'LLM');

-- AlterEnum
ALTER TYPE "MemorySource" ADD VALUE 'HISTORICAL';

-- AlterTable
ALTER TABLE "memories" ADD COLUMN     "observed_at" TIMESTAMP(3),
ADD COLUMN     "temporal_anchor_source" "TemporalAnchorSource" NOT NULL DEFAULT 'FALLBACK_RECORDED_AT';

-- CreateTable
CREATE TABLE "memory_event_times" (
    "id" TEXT NOT NULL,
    "memory_id" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "resolved_instant" TIMESTAMP(3),
    "resolved_range_start" TIMESTAMP(3),
    "resolved_range_end" TIMESTAMP(3),
    "anchor" TIMESTAMP(3) NOT NULL,
    "confidence" "EventTimeConfidence" NOT NULL,
    "extractor" "EventTimeExtractor" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_event_times_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "memory_event_times_memory_id_idx" ON "memory_event_times"("memory_id");

-- CreateIndex
CREATE INDEX "memory_event_times_resolved_instant_idx" ON "memory_event_times"("resolved_instant");

-- CreateIndex
CREATE INDEX "memory_event_times_resolved_range_start_resolved_range_end_idx" ON "memory_event_times"("resolved_range_start", "resolved_range_end");

-- CreateIndex
CREATE INDEX "memories_user_id_observed_at_idx" ON "memories"("user_id", "observed_at");

-- CreateIndex
CREATE INDEX "memories_observed_at_idx" ON "memories"("observed_at");

-- AddForeignKey
ALTER TABLE "memory_event_times" ADD CONSTRAINT "memory_event_times_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;


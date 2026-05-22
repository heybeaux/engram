-- HEY-574: Key expansion with extracted facts (LongMemEval S2)

-- AlterEnum: add FACT_KEY memory type
ALTER TYPE "MemoryType" ADD VALUE IF NOT EXISTS 'FACT_KEY';

-- AlterTable memories: add parent_memory_id for FACT_KEY child → parent link
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "parent_memory_id" TEXT;

-- AlterTable memory_extractions: add fact_keys and fact_key_vectors
ALTER TABLE "memory_extractions" ADD COLUMN IF NOT EXISTS "fact_keys" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "memory_extractions" ADD COLUMN IF NOT EXISTS "fact_key_vectors" JSONB;

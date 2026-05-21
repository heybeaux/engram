-- ENG-42: Add tags column to memories for pool-based metadata filtering
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "tags" TEXT[] DEFAULT '{}';

-- GIN index for fast tag containment queries (m.tags @> ARRAY[...])
CREATE INDEX IF NOT EXISTS "memories_tags_idx" ON "memories" USING GIN ("tags");

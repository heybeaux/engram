-- Rename camelCase column to snake_case to match Prisma @map("durability_classified_at")
-- Idempotent: only runs if the old camelCase column still exists (existing databases)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memories' AND column_name = 'durabilityClassifiedAt'
  ) THEN
    ALTER TABLE "memories" RENAME COLUMN "durabilityClassifiedAt" TO "durability_classified_at";
  END IF;
END $$;

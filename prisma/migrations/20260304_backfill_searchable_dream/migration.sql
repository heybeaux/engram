-- Backfill: mark all dream-cycle and consolidation memories as non-searchable
UPDATE "memories" SET "searchable" = false 
WHERE "source" IN ('DREAM_CYCLE', 'CONSOLIDATION');

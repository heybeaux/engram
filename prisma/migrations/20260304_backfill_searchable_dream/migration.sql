-- Backfill: mark all dream-cycle and consolidation memories as non-searchable
UPDATE "Memory" SET "searchable" = false 
WHERE "source" IN ('DREAM_CYCLE', 'CONSOLIDATION');

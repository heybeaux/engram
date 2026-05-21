-- Backfill: mark consolidated (archived) memories as non-searchable.
-- Memories with consolidated=true have been absorbed into dream-cycle
-- consolidations and should not surface in search results.
UPDATE "memories" SET "searchable" = false WHERE "consolidated" = true;

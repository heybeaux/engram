-- READ ONLY inventory. Supply the deployment's actual retrieval model and dims:
-- psql ... -v model_id=bge-base -v expected_dims=768 -f scripts/audit/consolidation-reconciliation.sql
-- No repairs are performed. Snapshot/back up before planning any restoration.
BEGIN READ ONLY;
WITH replacements AS (
  SELECT s.user_id, s.consolidated_into AS replacement_id,
         count(*) AS linked_sources,
         count(*) FILTER (WHERE s.deleted_at IS NULL AND s.superseded_by_id IS NULL AND s.searchable) AS active_sources,
         array_agg(s.id ORDER BY s.id) AS source_ids
  FROM memories s
  WHERE s.consolidated_into IS NOT NULL
  GROUP BY s.user_id, s.consolidated_into
)
SELECT r.*, m.id IS NULL AS missing_replacement,
       m.user_id IS DISTINCT FROM r.user_id AS ownership_mismatch,
       m.searchable, m.deleted_at IS NOT NULL AS replacement_deleted,
       me.model_id, me.dimensions, vector_dims(me.embedding) AS actual_dimensions
FROM replacements r
LEFT JOIN memories m ON m.id = r.replacement_id
LEFT JOIN memory_embeddings me ON me.memory_id = m.id AND me.model_id = :'model_id'
WHERE m.id IS NULL OR m.user_id IS DISTINCT FROM r.user_id
   OR m.deleted_at IS NOT NULL OR NOT m.searchable OR m.superseded_by_id IS NOT NULL
   OR me.embedding IS NULL OR me.dimensions <> :expected_dims
   OR vector_dims(me.embedding) <> :expected_dims
ORDER BY r.user_id, r.replacement_id;
ROLLBACK;

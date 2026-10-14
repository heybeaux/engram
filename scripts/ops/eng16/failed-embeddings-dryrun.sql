-- ENG-16 dry run: classify embedding_status='FAILED' memories. READ ONLY.
-- Run with:  PGOPTIONS='-c default_transaction_read_only=on' psql "$DATABASE_URL" -X -f failed-embeddings-dryrun.sql
-- :search_model must match VECTOR_SEARCH_MODEL in the API .env (openai-small today).
\set search_model 'openai-small'
\set search_dims 1536

-- 1. Totals by status (live rows only).
SELECT embedding_status, count(*) FROM memories WHERE deleted_at IS NULL GROUP BY 1 ORDER BY 1;

-- 2. FAILED rows split by whether a search-model vector already exists.
--    has_search_vec = already returned by pgvector search; FAILED is a stale label.
SELECT
  count(*) AS failed_total,
  count(*) FILTER (WHERE v.memory_id IS NOT NULL) AS has_search_vec_relabel_only,
  count(*) FILTER (WHERE v.memory_id IS NULL) AS missing_search_vec_needs_embed,
  count(*) FILTER (WHERE v.memory_id IS NOT NULL AND m.embedding_id IS NULL) AS relabel_also_sets_embedding_id
FROM memories m
LEFT JOIN memory_embeddings v
  ON v.memory_id = m.id AND v.model_id = :'search_model'
 AND v.embedding IS NOT NULL AND vector_dims(v.embedding) = :search_dims
WHERE m.deleted_at IS NULL AND m.embedding_status = 'FAILED';

-- 3. Rows needing a real embed, by creation month (outage = 2026-10-08 06:45Z .. 2026-10-13 21:20Z).
SELECT to_char(m.created_at, 'YYYY-MM') AS month,
       count(*) AS missing_search_vec,
       count(*) FILTER (WHERE m.created_at >= '2026-10-08 06:45:32' AND m.created_at < '2026-10-13 21:20:30') AS created_during_outage
FROM memories m
WHERE m.deleted_at IS NULL AND m.embedding_status IN ('FAILED', 'PENDING')
  AND NOT EXISTS (SELECT 1 FROM memory_embeddings v WHERE v.memory_id = m.id AND v.model_id = :'search_model' AND v.embedding IS NOT NULL)
GROUP BY 1 ORDER BY 1;

-- 4. Guard for the relabel step: must be 0 (embedding_id is UNIQUE; relabel sets embedding_id = id).
SELECT count(*) AS embedding_id_collisions
FROM memories m
WHERE m.deleted_at IS NULL AND m.embedding_status = 'FAILED' AND m.embedding_id IS NULL
  AND EXISTS (SELECT 1 FROM memories x WHERE x.embedding_id = m.id);

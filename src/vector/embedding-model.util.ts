/**
 * Single source of truth for the embedding model ID used for BOTH writing
 * rows to memory_embeddings and searching against them.
 *
 * Adversarial audit 2026-06-09 (Retrieval C1): the search JOIN previously read
 * only VECTOR_SEARCH_MODEL (default 'bge-base') while the write path logged/
 * stored EMBEDDING_MODEL ?? VECTOR_SEARCH_MODEL. If the two env vars diverged
 * (e.g. EMBEDDING_MODEL=text-embedding-3-small for OpenAI writes), every new
 * write became invisible to vector search because `me.model_id = $2` matched
 * nothing.
 *
 * Both paths MUST call this helper so they can never diverge again.
 */
export function resolveEmbeddingModelId(): string {
  return (
    process.env.EMBEDDING_MODEL ??
    process.env.VECTOR_SEARCH_MODEL ??
    'bge-base'
  );
}

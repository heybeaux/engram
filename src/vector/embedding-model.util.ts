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

/**
 * Known expected dimensions per logical model ID.
 * Used as a pre-insert guard so a model/dimension mismatch fails loudly
 * instead of silently writing a wrong-sized vector (which trips pgvector's
 * type error or, worse, silently corrupts recall results).
 *
 * Override with EXPECTED_EMBED_DIMENSIONS env var when using a non-standard
 * model size (e.g. truncated OpenAI embeddings).
 */
const MODEL_DIMS: Record<string, number> = {
  'openai-small': 1536,
  'openai-large': 3072,
  'bge-base': 768,
  'minilm': 384,
  'nomic': 768,
};

export function resolveExpectedDimensions(): number | undefined {
  const envOverride = process.env.EXPECTED_EMBED_DIMENSIONS;
  if (envOverride) {
    const n = parseInt(envOverride, 10);
    if (Number.isInteger(n) && n > 0) return n;
  }
  const modelId = resolveEmbeddingModelId();
  return MODEL_DIMS[modelId];
}

/**
 * Look up expected dimensions for an arbitrary modelId from the registry.
 * Returns undefined for unknown model IDs (no guard applied).
 */
export function getDimensionsForModel(modelId: string): number | undefined {
  return MODEL_DIMS[modelId];
}

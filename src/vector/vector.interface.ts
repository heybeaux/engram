/**
 * Vector Storage Provider Interface
 *
 * Abstracts vector storage so users can choose:
 * - pgvector (default, local, free)
 * - Pinecone (cloud, scales to billions)
 */

export interface VectorRecord {
  id: string;
  embedding: number[];
  metadata?: Record<string, any>;
}

export interface VectorSearchResult {
  id: string;
  score: number;
  metadata?: Record<string, any>;
}

export interface VectorSearchOptions {
  userId: string | string[];
  limit?: number;
  filter?: {
    layers?: string[];
    projectId?: string;
    poolIds?: string[];
  };
  /** ENG-26: Original query text for hybrid search (BM25 fusion) */
  _queryText?: string;
}

/**
 * Abstract vector storage provider interface
 */
export interface VectorProvider {
  /**
   * Provider name
   */
  readonly name: string;

  /**
   * Store a vector
   */
  upsert(record: VectorRecord): Promise<void>;

  /**
   * Store multiple vectors
   */
  upsertMany(records: VectorRecord[]): Promise<void>;

  /**
   * Search for similar vectors
   */
  search(
    embedding: number[],
    options: VectorSearchOptions,
  ): Promise<VectorSearchResult[]>;

  /**
   * Delete a vector by ID
   */
  delete(id: string): Promise<void>;

  /**
   * Delete all vectors for a user
   */
  deleteByUser(userId: string): Promise<void>;

  /**
   * Check if provider is properly configured
   */
  isConfigured(): boolean;
}

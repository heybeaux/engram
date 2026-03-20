/**
 * Shared types for test fixtures.
 */

export interface FixtureMemory {
  /** Stable identifier for assertions (e.g., 'alice_coffee_001') */
  fixture_id: string;
  /** Memory content (raw text) */
  content: string;
  /** Memory layer */
  layer: 'IDENTITY' | 'PROJECT' | 'SESSION' | 'TASK' | 'INSIGHT';
  /** Memory type classification */
  memoryType?: 'CONSTRAINT' | 'PREFERENCE' | 'FACT' | 'TASK' | 'EVENT';
  /** Source of the memory */
  source:
    | 'EXPLICIT_STATEMENT'
    | 'AGENT_OBSERVATION'
    | 'CORRECTION'
    | 'PATTERN_DETECTED';
  /** Importance score 0-1 */
  importanceScore: number;
  /** Tags for filtering */
  tags: string[];
  /** Creation date (for temporal testing) */
  created_at: Date;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

export interface FixtureUser {
  /** User profile name (e.g., 'alice') */
  name: string;
  /** Email for the account */
  email: string;
  /** RLS canary prefix for this user's memories */
  canaryPrefix: string;
  /** The fixture memories for this user */
  memories: FixtureMemory[];
}

export interface GoldQuery {
  /** Unique query ID */
  id: string;
  /** The search query text */
  query: string;
  /** Which fixture user to search as */
  user: string;
  /** fixture_ids that MUST appear in top 5 results */
  must_top5: string[];
  /** fixture_ids that SHOULD appear in top 20 results */
  should_top20?: string[];
  /** fixture_ids that MUST NOT appear (cross-tenant, irrelevant) */
  must_absent: string[];
  /** Query category for reporting */
  category:
    | 'semantic'
    | 'temporal'
    | 'emotional'
    | 'edge_case'
    | 'rls_isolation'
    | 'cross_feature'
    | 'adversarial';
}

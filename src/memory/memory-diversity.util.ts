import { MemoryWithScore } from './memory.types';

/**
 * Near-duplicate diversification (ported from PR #327).
 *
 * `RECALL_NEAR_DUPLICATE_CLUSTER_LIMIT=N` caps how many members of one
 * near-duplicate cluster may appear in the final page. Unset/invalid → off.
 */
export function nearDuplicateClusterLimit(): number | undefined {
  const raw = process.env.RECALL_NEAR_DUPLICATE_CLUSTER_LIMIT;
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/** How deep the reranked pool is scanned when the cluster cap is on. */
export const CLUSTER_SCAN_DEPTH = 50;

/**
 * Token-set Jaccard is intentionally conservative and transparent. At the
 * default 0.9 threshold it clusters records that are almost the same text,
 * while leaving facts that merely share a topic/prefix in separate clusters.
 * Candidates retain their incoming relevance order; the only intervention is
 * a cap on how many members any one near-duplicate cluster may consume.
 */
export function selectNearDuplicateDiverse(
  candidates: readonly MemoryWithScore[],
  limit: number,
  perCluster: number,
  threshold = 0.9,
): MemoryWithScore[] {
  if (limit <= 0 || perCluster <= 0) return [];

  const clusters: Array<{
    representative: Set<string>;
    count: number;
  }> = [];
  const selected: MemoryWithScore[] = [];
  const suppressed: MemoryWithScore[] = [];

  for (const candidate of candidates) {
    const tokens = tokenSet(candidate.raw ?? '');
    const cluster = clusters.find(
      (entry) => jaccard(tokens, entry.representative) >= threshold,
    );

    if (cluster) {
      if (cluster.count >= perCluster) {
        suppressed.push(candidate);
        continue;
      }
      cluster.count++;
    } else {
      clusters.push({ representative: tokens, count: 1 });
    }

    selected.push(candidate);
    if (selected.length >= limit) break;
  }

  // Diversity must not silently shrink a caller's requested page. Once every
  // available cluster has had a fair chance, backfill with suppressed rows in
  // their original relevance order.
  for (const candidate of suppressed) {
    if (selected.length >= limit) break;
    selected.push(candidate);
  }

  return selected;
}

function tokenSet(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

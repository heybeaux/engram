/**
 * Per-question trace rows for failure analysis (--trace PATH).
 *
 * A trace row keeps everything needed to label a miss as retrieval vs reasoning:
 * the recall request and ranked memories with scores, the exact reader prompt,
 * the prediction, the gold answer and the gold evidence sessions/turns.
 */

import type { EvidenceTurn } from './types';

const MIN_EVIDENCE_SNIPPET = 40;

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Heuristic: does a retrieved memory contain (part of) a gold evidence turn?
 *
 * Returns the indexes into `evidence` whose text overlaps the memory. A turn
 * matches when the memory contains its first MIN_EVIDENCE_SNIPPET normalized
 * characters, or when the whole memory text sits inside the turn (a ROUND chunk
 * that was split). Short turns must match in full.
 */
export function matchEvidence(fact: string, evidence: EvidenceTurn[]): number[] {
  const memory = normalize(fact);
  if (!memory) return [];
  const hits: number[] = [];
  evidence.forEach((turn, i) => {
    const content = normalize(turn.content);
    if (!content) return;
    const head = content.slice(0, Math.max(MIN_EVIDENCE_SNIPPET, Math.min(content.length, 120)));
    if (memory.includes(head) || (memory.length >= MIN_EVIDENCE_SNIPPET && content.includes(memory))) {
      hits.push(i);
    }
  });
  return hits;
}

export interface TracedMemory {
  rank: number;
  id: string;
  score: number | null;
  timestamp?: string;
  memoryType?: string | null;
  fact: string;
  evidenceTurnMatches: number[];
}

/** Rank (1-based) and evidence-match each recalled memory. */
export function traceMemories(
  memories: Array<{ id: string; fact: string; confidence: number | null; timestamp?: string; memory_type?: string | null }>,
  evidence: EvidenceTurn[],
): TracedMemory[] {
  return memories.map((m, i) => ({
    rank: i + 1,
    id: m.id,
    score: m.confidence,
    timestamp: m.timestamp,
    memoryType: m.memory_type ?? null,
    fact: m.fact,
    evidenceTurnMatches: matchEvidence(m.fact, evidence),
  }));
}

/** Summary of where gold evidence landed in the ranking. */
export function evidenceCoverage(traced: TracedMemory[], evidenceCount: number): {
  evidenceTurns: number;
  evidenceTurnsRetrieved: number;
  firstEvidenceRank: number | null;
  allEvidenceRetrieved: boolean;
} {
  const found = new Set<number>();
  let first: number | null = null;
  for (const m of traced) {
    if (m.evidenceTurnMatches.length > 0 && first === null) first = m.rank;
    m.evidenceTurnMatches.forEach(i => found.add(i));
  }
  return {
    evidenceTurns: evidenceCount,
    evidenceTurnsRetrieved: found.size,
    firstEvidenceRank: first,
    allEvidenceRetrieved: evidenceCount > 0 && found.size === evidenceCount,
  };
}

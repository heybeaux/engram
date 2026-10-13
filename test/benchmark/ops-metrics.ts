/**
 * Ops metrics for the recall benchmark: latency percentiles and recall payload
 * size. Tokens are approximated as chars/4 (no tokenizer dependency); treat
 * them as an estimate, not a billing figure.
 */

export interface QueryOpsSample {
  queryId: string;
  latencyMs: number;
  resultCount: number;
  /** Sum of memory text lengths returned (raw ?? content). */
  contentChars: number;
  /** Length of the serialized memories array. */
  payloadChars: number;
}

export interface OpsSummary {
  n: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  latencyMaxMs: number | null;
  meanResultCount: number | null;
  meanContentTokensApprox: number | null;
  meanPayloadTokensApprox: number | null;
  tokenMethod: 'chars/4';
}

/** Linear-interpolated percentile (p in [0, 1]); null for empty input. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (sorted.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

function mean(values: number[]): number | null {
  return values.length
    ? values.reduce((s, v) => s + v, 0) / values.length
    : null;
}

const round = (v: number | null) => (v === null ? null : Math.round(v));

export function buildOpsSummary(samples: QueryOpsSample[]): OpsSummary {
  const latencies = samples.map((s) => s.latencyMs);
  return {
    n: samples.length,
    latencyP50Ms: round(percentile(latencies, 0.5)),
    latencyP95Ms: round(percentile(latencies, 0.95)),
    latencyMaxMs: round(latencies.length ? Math.max(...latencies) : null),
    meanResultCount: mean(samples.map((s) => s.resultCount)),
    meanContentTokensApprox: round(
      mean(samples.map((s) => s.contentChars / 4)),
    ),
    meanPayloadTokensApprox: round(
      mean(samples.map((s) => s.payloadChars / 4)),
    ),
    tokenMethod: 'chars/4',
  };
}

export const MIN_MEANINGFUL_MEMORY_COUNT = 10;
export const DEFAULT_SANITY_THRESHOLD = 0.9;

export function assertSanityGate(
  stage: string,
  rowsTouched: number,
  totalMemories: number,
  threshold: number = DEFAULT_SANITY_THRESHOLD,
): void {
  if (totalMemories < MIN_MEANINGFUL_MEMORY_COUNT) return;
  const minRequired = Math.floor(totalMemories * threshold);
  if (rowsTouched < minRequired) {
    throw new Error(
      `Dream Cycle sanity gate FAILED for stage '${stage}': ` +
        `processed ${rowsTouched} memories but expected at least ${minRequired} ` +
        `(${Math.round(threshold * 100)}% of ${totalMemories} total). ` +
        `This indicates a scoping bug — check RLS context and service role configuration.`,
    );
  }
}

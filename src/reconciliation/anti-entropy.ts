import { reconcile } from './reconcile';
import { type VersionedFact } from './versioned-fact';

export interface AntiEntropyResult {
  /** Facts on side `a` that were healed (corrupt/absent → verified) by `b`. */
  aHealed: number;
  /** Facts on side `b` that were healed by `a`. */
  bHealed: number;
  /** Distinct fact_ids offered across the exchange. */
  exchanged: number;
}

/**
 * Pairwise anti-entropy: each side offers its held facts; both reconcile against
 * what the other holds. This is periodic repair between neighbors — the
 * mechanism that shortens the EFFECTIVE path from every node to a verified copy
 * (the exp-08 directive: push fidelity by shortening paths, not damping spread).
 *
 * A "heal" is counted only when reconcile reports outcome `healed` — i.e. a side
 * genuinely swapped a corrupt/stale copy for a verified, newer one. Adoption of
 * a fact the side never held is not counted as healing (nothing was corrupt to
 * repair); it still updates the map so the pair converges.
 *
 * Mutates both maps in place and also returns the counts.
 */
export function antiEntropySync(
  a: Map<string, VersionedFact>,
  b: Map<string, VersionedFact>,
): AntiEntropyResult {
  let aHealed = 0;
  let bHealed = 0;

  const factIds = new Set<string>([...a.keys(), ...b.keys()]);

  for (const factId of factIds) {
    const av = a.get(factId) ?? null;
    const bv = b.get(factId) ?? null;

    // b offers its copy to a
    if (bv !== null) {
      const r = reconcile(av, bv);
      if (r.outcome === 'healed') aHealed += 1;
      if (r.result !== null) a.set(factId, r.result);
    }

    // a offers its (possibly just-updated) copy to b
    const avNow = a.get(factId) ?? null;
    if (avNow !== null) {
      const r = reconcile(bv, avNow);
      if (r.outcome === 'healed') bHealed += 1;
      if (r.result !== null) b.set(factId, r.result);
    }
  }

  return { aHealed, bHealed, exchanged: factIds.size };
}

import { verifyFact, type VersionedFact } from './versioned-fact';

/**
 * Named outcomes of reconciling an incoming fact against a held one. Every
 * decision is named — nothing is a silent drop — so a mesh can account for
 * healing vs rejection per node (Spec 16 B2 healing accounting).
 *
 * - `kept`             held copy retained; incoming brought nothing better.
 * - `adopted`          node held nothing; incoming was taken (verified, or a
 *                      provisional corrupt copy that stays healable).
 * - `healed`           held was corrupt (or a stale verified copy) and incoming
 *                      repaired it — the exp-08 first-write-wins villain, inverted.
 * - `rejected_corrupt` incoming failed verification and was refused; corruption
 *                      cannot re-infect an already-verified node.
 */
export type ReconcileOutcome = 'kept' | 'adopted' | 'healed' | 'rejected_corrupt';

export interface ReconcileResult {
  result: VersionedFact | null;
  outcome: ReconcileOutcome;
}

/**
 * Reconcile a held fact against an incoming one, killing first-write-wins.
 *
 * Rules (each is an exp-08 finding inverted):
 *  1. Verifiable beats held. If `incoming` verifies and `held` does not (or is
 *     absent), adopt it — a later accurate write HEALS early-hop corruption
 *     instead of bouncing off a sticky first write.
 *  2. Higher version beats lower, only when verifiable. A corrupt copy never
 *     overwrites a verified one regardless of version — `rejected_corrupt`.
 *  3. Never adopt what fails verification while already holding a verified copy.
 *     Corruption cannot re-infect a healed node.
 */
export function reconcile(
  held: VersionedFact | null,
  incoming: VersionedFact,
): ReconcileResult {
  const incomingOk = verifyFact(incoming);
  const heldOk = held !== null && verifyFact(held);

  // No held copy yet: adopt whatever arrives so the node becomes informed. A
  // verified arrival is a clean adoption; a corrupt one is still adopted — the
  // node holds a provisional, UNVERIFIED copy that a later verifiable retelling
  // or an anti-entropy pass will HEAL. This is the exp-08 reality (nodes do adopt
  // corrupt early-hop copies) made healable, instead of first-write-wins freezing
  // it. Refusing here would strand the node uninformed and leave nothing to heal.
  if (held === null) {
    return { result: incoming, outcome: 'adopted' };
  }

  // We hold a VERIFIED copy. Only a verified, strictly-newer version may replace
  // it; anything corrupt is refused (Rule 3). A same-or-older verified copy is
  // redundant — keep what we have.
  if (heldOk) {
    if (!incomingOk) return { result: held, outcome: 'rejected_corrupt' };
    if (incoming.version > held.version) {
      return { result: incoming, outcome: 'healed' };
    }
    return { result: held, outcome: 'kept' };
  }

  // We hold a CORRUPT copy. A verified arrival heals us (Rule 1) regardless of
  // version — any verifiable copy is strictly better than an unverifiable one.
  if (incomingOk) return { result: incoming, outcome: 'healed' };

  // Both corrupt: nothing to heal from, keep the incumbent so accounting is
  // stable (no thrash between two bad copies).
  return { result: held, outcome: 'kept' };
}

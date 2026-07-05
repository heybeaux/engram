/**
 * Versioned facts + anti-entropy reconciliation (Spec 16).
 *
 * Pure TypeScript, no NestJS/runtime dependencies — importable from an external
 * harness (e.g. the swarmlab exp-08 rumor-mill retest) via the built output or a
 * `file:` dependency on this directory.
 */
export {
  type VersionedFact,
  makeVersionedFact,
  verifyFact,
  computeDigest,
} from './versioned-fact';
export {
  type ReconcileOutcome,
  type ReconcileResult,
  reconcile,
} from './reconcile';
export {
  type AntiEntropyResult,
  antiEntropySync,
} from './anti-entropy';

import { createHash } from 'crypto';

/**
 * A content-addressed, versioned fact for gossip/anti-entropy meshes.
 *
 * Integrity is a property of the fact itself, not trust in whoever handed it to
 * you: the `digest` is a hash over (`fact_id`, `version`, `origin_id`,
 * `content`). Any hop that mutates `content` in transit — a retelling — WITHOUT
 * re-authoring at the origin breaks the digest, so `verifyFact` returns false.
 * That is the seam Spec 16 needs: a node can detect that its held copy drifted
 * from the origin write, independent of who relayed it.
 */
export interface VersionedFact {
  /** Identity of the fact — what it is about. Stable across versions. */
  fact_id: string;
  /** Monotonically increasing at the ORIGIN only. Relays never bump it. */
  version: number;
  /** Who authored this version. */
  origin_id: string;
  /** The payload (a token string in the sim). */
  content: string;
  /** Content-addressed integrity: hash(fact_id, version, origin_id, content). */
  digest: string;
}

/**
 * Canonical serialization used for the digest. Length-prefixed field joining so
 * no combination of field values can collide by shifting a delimiter (e.g.
 * content containing the separator). `version` is a number and is rendered
 * decimal.
 */
function canonical(
  fact_id: string,
  version: number,
  origin_id: string,
  content: string,
): string {
  const parts = [fact_id, String(version), origin_id, content];
  return parts.map((p) => `${p.length}:${p}`).join('|');
}

/** Compute the content-addressed digest for the given fields. */
export function computeDigest(
  fact_id: string,
  version: number,
  origin_id: string,
  content: string,
): string {
  return createHash('sha256')
    .update(canonical(fact_id, version, origin_id, content))
    .digest('hex');
}

/**
 * Author a versioned fact at the origin. The digest is computed from the exact
 * fields, so the returned fact always verifies until its content is mutated.
 */
export function makeVersionedFact(
  fact_id: string,
  version: number,
  origin_id: string,
  content: string,
): VersionedFact {
  return {
    fact_id,
    version,
    origin_id,
    content,
    digest: computeDigest(fact_id, version, origin_id, content),
  };
}

/**
 * True iff the fact's digest recomputes and matches. A hop-mutated retelling
 * (content changed without re-authoring at origin) fails this check.
 */
export function verifyFact(f: VersionedFact): boolean {
  return (
    f.digest === computeDigest(f.fact_id, f.version, f.origin_id, f.content)
  );
}

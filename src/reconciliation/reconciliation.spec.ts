import {
  makeVersionedFact,
  verifyFact,
  reconcile,
  antiEntropySync,
  type VersionedFact,
} from './index';

/** A hop mutates content in transit without re-authoring — digest stays stale. */
function corrupt(f: VersionedFact, mutated: string): VersionedFact {
  return { ...f, content: mutated };
}

describe('versioned facts + anti-entropy (Spec 16)', () => {
  const FACT_ID = 'fact-42';
  const ORIGIN = 'seed-node';
  const TRUTH = 'AAAAAAAAAAAA';

  it('(d) digest breaks on any single-token mutation', () => {
    const good = makeVersionedFact(FACT_ID, 1, ORIGIN, TRUTH);
    expect(verifyFact(good)).toBe(true);

    // Flip exactly one token; verification must fail.
    const oneOff = corrupt(good, 'AAAAABAAAAAA');
    expect(oneOff.content).not.toBe(good.content);
    expect(verifyFact(oneOff)).toBe(false);

    // Every single-position mutation breaks it.
    for (let i = 0; i < TRUTH.length; i += 1) {
      const chars = TRUTH.split('');
      chars[i] = 'Z';
      expect(verifyFact(corrupt(good, chars.join('')))).toBe(false);
    }
  });

  it('(a) exp-08 recipe: a corrupted early-hop copy is HEALED by a later verifiable retelling', () => {
    // Node adopts a mangled early-hop version — first-write-wins would freeze this
    // forever. Under reconcile the empty node still adopts (so it is informed and
    // spreads), holding a provisional UNVERIFIED copy.
    const mangled = corrupt(makeVersionedFact(FACT_ID, 1, ORIGIN, TRUTH), 'QAAQAAQAAQAA');
    const adopt = reconcile(null, mangled);
    expect(adopt.outcome).toBe('adopted');
    expect(verifyFact(adopt.result as VersionedFact)).toBe(false); // provisional, corrupt

    // Later, a verifiable retelling of the same fact arrives and HEALS the node.
    let held: VersionedFact | null = adopt.result; // node is stuck on a corrupt copy
    const truth = makeVersionedFact(FACT_ID, 1, ORIGIN, TRUTH);
    const r = reconcile(held, truth);
    expect(r.outcome).toBe('healed');
    held = r.result;
    expect(held && verifyFact(held)).toBe(true);
    expect(held?.content).toBe(TRUTH);
  });

  it('(b) a corrupt copy never overwrites a verified one', () => {
    const held = makeVersionedFact(FACT_ID, 1, ORIGIN, TRUTH);
    // Corrupt incoming, even claiming a higher version, is rejected.
    const attacker = corrupt(
      makeVersionedFact(FACT_ID, 9, 'liar', TRUTH),
      'ZZZZZZZZZZZZ',
    );
    expect(verifyFact(attacker)).toBe(false);
    const r = reconcile(held, attacker);
    expect(r.outcome).toBe('rejected_corrupt');
    expect(r.result).toBe(held);
    expect(verifyFact(r.result as VersionedFact)).toBe(true);
  });

  it('(c) anti-entropy repairs a corrupted node from a verified neighbor and counts it', () => {
    const truth = makeVersionedFact(FACT_ID, 1, ORIGIN, TRUTH);
    const corrupted = new Map<string, VersionedFact>([
      [FACT_ID, corrupt(truth, 'BBBBBBBBBBBB')],
    ]);
    const verified = new Map<string, VersionedFact>([[FACT_ID, truth]]);

    const res = antiEntropySync(corrupted, verified);
    expect(res.aHealed).toBe(1);
    expect(res.bHealed).toBe(0);
    expect(res.exchanged).toBe(1);
    expect(verifyFact(corrupted.get(FACT_ID) as VersionedFact)).toBe(true);
    expect(corrupted.get(FACT_ID)?.content).toBe(TRUTH);
  });

  it('(e) a higher verified version supersedes a lower verified one', () => {
    const v1 = makeVersionedFact(FACT_ID, 1, ORIGIN, TRUTH);
    const v2 = makeVersionedFact(FACT_ID, 2, ORIGIN, 'CCCCCCCCCCCC');
    const r = reconcile(v1, v2);
    expect(r.outcome).toBe('healed');
    expect(r.result).toBe(v2);

    // Lower verified version does NOT supersede a held higher one.
    const back = reconcile(v2, v1);
    expect(back.outcome).toBe('kept');
    expect(back.result).toBe(v2);
  });

  it('adopts into an empty node when the arrival verifies', () => {
    const truth = makeVersionedFact(FACT_ID, 1, ORIGIN, TRUTH);
    const r = reconcile(null, truth);
    expect(r.outcome).toBe('adopted');
    expect(r.result).toBe(truth);
  });

  it('anti-entropy is symmetric: a verified side heals a corrupt neighbor either way', () => {
    const truth = makeVersionedFact(FACT_ID, 1, ORIGIN, TRUTH);
    const verified = new Map<string, VersionedFact>([[FACT_ID, truth]]);
    const corrupted = new Map<string, VersionedFact>([
      [FACT_ID, corrupt(truth, 'DDDDDDDDDDDD')],
    ]);
    // Order swapped vs test (c): verified is side a now.
    const res = antiEntropySync(verified, corrupted);
    expect(res.bHealed).toBe(1);
    expect(res.aHealed).toBe(0);
    expect(verifyFact(corrupted.get(FACT_ID) as VersionedFact)).toBe(true);
  });
});

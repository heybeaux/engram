/**
 * Unit tests for buildCategoryHint — covers all three category-specific
 * prompt improvements from HEY-578:
 *  1. knowledge-update: recency ordering + conflict resolution instruction
 *  2. temporal-reasoning: question_date injection + date arithmetic guidance
 *  3. single-session-preference: synthesize implicit preferences, not literal facts
 */

import { buildCategoryHint } from '../src/recall';

const MEMORIES = [
  { id: 'm1', fact: 'User goes to yoga twice a week', timestamp: '2023/03/01' },
  { id: 'm2', fact: 'User now goes to yoga three times a week', timestamp: '2023/05/10' },
  { id: 'm3', fact: 'User attended Nordstrom sale yesterday', timestamp: '2022/11/18' },
];

// ─── knowledge-update ────────────────────────────────────────────────────────

describe('buildCategoryHint — knowledge-update', () => {
  it('returns a string containing recency-wins instruction', () => {
    const hint = buildCategoryHint('knowledge-update', MEMORIES);
    expect(hint).toMatch(/MOST RECENT|most recent/i);
    expect(hint).toMatch(/conflict/i);
  });

  it('sorts memories oldest → newest', () => {
    const hint = buildCategoryHint('knowledge-update', MEMORIES);
    const pos1 = hint.indexOf('2023/03/01');
    const pos2 = hint.indexOf('2023/05/10');
    expect(pos1).toBeGreaterThan(-1);
    expect(pos2).toBeGreaterThan(-1);
    expect(pos1).toBeLessThan(pos2);
  });

  it('includes memory facts in the timeline', () => {
    const hint = buildCategoryHint('knowledge-update', MEMORIES);
    expect(hint).toContain('yoga twice a week');
    expect(hint).toContain('yoga three times a week');
  });

  it('handles missing timestamps gracefully', () => {
    const mem = [{ id: 'x', fact: 'Some fact' }];
    const hint = buildCategoryHint('knowledge-update', mem);
    expect(hint).toContain('unknown time');
    expect(hint).toContain('Some fact');
  });

  it('returns non-empty string even with no memories', () => {
    const hint = buildCategoryHint('knowledge-update', []);
    expect(hint.length).toBeGreaterThan(0);
    expect(hint).toMatch(/MOST RECENT|most recent/i);
  });
});

// ─── temporal-reasoning-ability ──────────────────────────────────────────────

describe('buildCategoryHint — temporal-reasoning-ability', () => {
  it('injects question_date prominently when provided', () => {
    const hint = buildCategoryHint(
      'temporal-reasoning-ability',
      MEMORIES,
      '2022/12/02 (Fri) 10:00',
    );
    expect(hint).toContain('2022/12/02 (Fri) 10:00');
    expect(hint).toMatch(/question was asked on|TODAY/i);
  });

  it('provides fallback instruction when question_date is absent', () => {
    const hint = buildCategoryHint('temporal-reasoning-ability', MEMORIES, undefined);
    expect(hint).toMatch(/infer.*today|latest session/i);
  });

  it('annotates each memory with its date', () => {
    const hint = buildCategoryHint('temporal-reasoning-ability', MEMORIES, '2022/12/02');
    expect(hint).toContain('2023/03/01');
    expect(hint).toContain('2022/11/18');
  });

  it('instructs model to compute relative time explicitly', () => {
    const hint = buildCategoryHint('temporal-reasoning-ability', MEMORIES, '2022/12/02');
    expect(hint).toMatch(/days|weeks|months/i);
    expect(hint).toMatch(/do NOT say.*I don.t know|not.*I don.t know/i);
  });

  it('sorts memories chronologically', () => {
    const hint = buildCategoryHint('temporal-reasoning-ability', MEMORIES, '2023/06/01');
    const pos1 = hint.indexOf('2022/11/18');
    const pos2 = hint.indexOf('2023/03/01');
    const pos3 = hint.indexOf('2023/05/10');
    expect(pos1).toBeGreaterThan(-1);
    expect(pos2).toBeGreaterThan(pos1);
    expect(pos3).toBeGreaterThan(pos2);
  });
});

// ─── single-session-preference ───────────────────────────────────────────────

describe('buildCategoryHint — single-session-preference', () => {
  it('returns a preference synthesis instruction', () => {
    const hint = buildCategoryHint('single-session-preference', MEMORIES);
    expect(hint).toMatch(/prefer/i);
    expect(hint).toMatch(/synthesize|infer/i);
  });

  it('mentions implicit hedged preference language', () => {
    const hint = buildCategoryHint('single-session-preference', MEMORIES);
    expect(hint).toMatch(/I usually|I tend to prefer|I love/i);
  });

  it('instructs to tailor answer to inferred preferences', () => {
    const hint = buildCategoryHint('single-session-preference', MEMORIES);
    expect(hint).toMatch(/tailor|inferred preferences/i);
  });
});

// ─── no category ─────────────────────────────────────────────────────────────

describe('buildCategoryHint — no category', () => {
  it('returns empty string for undefined category', () => {
    expect(buildCategoryHint(undefined, MEMORIES)).toBe('');
  });

  it('returns empty string for unrecognised category', () => {
    expect(buildCategoryHint('single-session-user' as any, MEMORIES)).toBe('');
  });
});

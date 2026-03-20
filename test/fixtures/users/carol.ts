/**
 * Carol — Edge case testing (200 memories)
 *
 * Short/long content, Unicode, empty fields, XSS payloads, SQL injection attempts.
 * Tests system robustness against malformed or adversarial input.
 */

import { subDays } from '../date-utils';
import type { FixtureUser, FixtureMemory } from '../types';

const CANARY = 'RLS_CANARY_CAROL_';

const edgeCaseMemories: FixtureMemory[] = [
  // Very short
  {
    fixture_id: 'carol_short_001',
    content: `${CANARY}1: Hi`,
    layer: 'SESSION',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.1,
    tags: ['edge', 'short'],
    created_at: subDays(1),
  },
  {
    fixture_id: 'carol_short_002',
    content: `${CANARY}2: OK`,
    layer: 'SESSION',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.1,
    tags: ['edge', 'short'],
    created_at: subDays(2),
  },
  {
    fixture_id: 'carol_short_003',
    content: `${CANARY}3: .`,
    layer: 'SESSION',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.1,
    tags: ['edge', 'short'],
    created_at: subDays(3),
  },

  // Unicode: emoji
  {
    fixture_id: 'carol_unicode_001',
    content: `${CANARY}4: 🎉🎊🎈 Party time! 🥳🎂🍰`,
    layer: 'SESSION',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.3,
    tags: ['edge', 'unicode', 'emoji'],
    created_at: subDays(4),
  },
  {
    fixture_id: 'carol_unicode_002',
    content: `${CANARY}5: こんにちは世界！日本語テスト。`,
    layer: 'SESSION',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.3,
    tags: ['edge', 'unicode', 'cjk'],
    created_at: subDays(5),
  },
  {
    fixture_id: 'carol_unicode_003',
    content: `${CANARY}6: مرحبا بالعالم - اختبار اللغة العربية`,
    layer: 'SESSION',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.3,
    tags: ['edge', 'unicode', 'rtl'],
    created_at: subDays(6),
  },
  {
    fixture_id: 'carol_unicode_004',
    content: `${CANARY}7: 🇦🇺🦘 Ṫḧïṡ ïṡ ẗëẍẗ ẅïẗḧ ḋïäçṛïẗïçṡ äṅḋ ëṁöjïṡ 🧪`,
    layer: 'SESSION',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.3,
    tags: ['edge', 'unicode', 'diacritics'],
    created_at: subDays(7),
  },
  // Zero-width characters
  {
    fixture_id: 'carol_unicode_005',
    content: `${CANARY}8: invisible\u200B\u200Bcharacters\u200B\u200Bhere`,
    layer: 'SESSION',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.2,
    tags: ['edge', 'unicode', 'zwsp'],
    created_at: subDays(8),
  },

  // XSS payloads
  {
    fixture_id: 'carol_xss_001',
    content: `${CANARY}9: <script>alert('xss')</script>`,
    layer: 'SESSION',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.2,
    tags: ['edge', 'xss'],
    created_at: subDays(9),
  },
  {
    fixture_id: 'carol_xss_002',
    content: `${CANARY}10: <img src=x onerror=alert(1)>`,
    layer: 'SESSION',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.2,
    tags: ['edge', 'xss'],
    created_at: subDays(10),
  },
  {
    fixture_id: 'carol_xss_003',
    content: `${CANARY}11: javascript:alert(document.cookie)`,
    layer: 'SESSION',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.2,
    tags: ['edge', 'xss'],
    created_at: subDays(11),
  },
  {
    fixture_id: 'carol_xss_004',
    content: `${CANARY}12: <svg onload=alert(1)>`,
    layer: 'SESSION',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.2,
    tags: ['edge', 'xss'],
    created_at: subDays(12),
  },

  // SQL injection attempts
  {
    fixture_id: 'carol_sqli_001',
    content: `${CANARY}13: Robert'; DROP TABLE memories;--`,
    layer: 'SESSION',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.2,
    tags: ['edge', 'sqli'],
    created_at: subDays(13),
  },
  {
    fixture_id: 'carol_sqli_002',
    content: `${CANARY}14: ' OR '1'='1' --`,
    layer: 'SESSION',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.2,
    tags: ['edge', 'sqli'],
    created_at: subDays(14),
  },
  {
    fixture_id: 'carol_sqli_003',
    content: `${CANARY}15: UNION SELECT * FROM accounts WHERE 1=1`,
    layer: 'SESSION',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.2,
    tags: ['edge', 'sqli'],
    created_at: subDays(15),
  },

  // Null-like strings
  {
    fixture_id: 'carol_null_001',
    content: `${CANARY}16: null`,
    layer: 'SESSION',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.1,
    tags: ['edge', 'null'],
    created_at: subDays(16),
  },
  {
    fixture_id: 'carol_null_002',
    content: `${CANARY}17: undefined`,
    layer: 'SESSION',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.1,
    tags: ['edge', 'null'],
    created_at: subDays(17),
  },
  {
    fixture_id: 'carol_null_003',
    content: `${CANARY}18: NaN`,
    layer: 'SESSION',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.1,
    tags: ['edge', 'null'],
    created_at: subDays(18),
  },
  {
    fixture_id: 'carol_null_004',
    content: `${CANARY}19: false`,
    layer: 'SESSION',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.1,
    tags: ['edge', 'null'],
    created_at: subDays(19),
  },

  // Very long
  {
    fixture_id: 'carol_long_001',
    content: `${CANARY}20: ${'This is a very long memory that repeats itself many times to test content limits. '.repeat(60)}`,
    layer: 'SESSION',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.3,
    tags: ['edge', 'long'],
    created_at: subDays(20),
  },

  // Special characters
  {
    fixture_id: 'carol_special_001',
    content: `${CANARY}21: Backslash \\ tab \t newline \n quotes "double" 'single' backtick \`tick\``,
    layer: 'SESSION',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.2,
    tags: ['edge', 'special'],
    created_at: subDays(21),
  },
  {
    fixture_id: 'carol_special_002',
    content: `${CANARY}22: JSON: {"key": "value", "nested": {"a": [1,2,3]}}`,
    layer: 'SESSION',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.2,
    tags: ['edge', 'json'],
    created_at: subDays(22),
  },
  {
    fixture_id: 'carol_special_003',
    content: `${CANARY}23: Markdown: # Header\n**bold** _italic_ [link](http://test) \`code\``,
    layer: 'SESSION',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.2,
    tags: ['edge', 'markdown'],
    created_at: subDays(23),
  },
];

function generateCarolMemories(): FixtureMemory[] {
  const memories: FixtureMemory[] = [];
  let counter = 24;
  const layers: Array<FixtureMemory['layer']> = [
    'SESSION',
    'PROJECT',
    'IDENTITY',
    'INSIGHT',
    'TASK',
  ];

  while (memories.length + edgeCaseMemories.length < 200) {
    memories.push({
      fixture_id: `carol_gen_${String(counter).padStart(3, '0')}`,
      content: `${CANARY}${counter}: Carol's edge case memory #${counter}. Mixed content for corpus padding.`,
      layer: layers[counter % layers.length],
      source: 'EXPLICIT_STATEMENT',
      importanceScore: 0.3,
      tags: ['edge', 'generated'],
      created_at: subDays(counter),
    });
    counter++;
  }
  return memories;
}

export const carol: FixtureUser = {
  name: 'carol',
  email: 'carol@test.engram.local',
  canaryPrefix: CANARY,
  memories: [...edgeCaseMemories, ...generateCarolMemories()],
};

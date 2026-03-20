/**
 * Eve — Minimal user (10 memories)
 *
 * Tests empty states, pagination edges, and near-empty account behavior.
 */

import { subDays } from '../date-utils';
import type { FixtureUser } from '../types';

const CANARY = 'RLS_CANARY_EVE_';

export const eve: FixtureUser = {
  name: 'eve',
  email: 'eve@test.engram.local',
  canaryPrefix: CANARY,
  memories: [
    {
      fixture_id: 'eve_001',
      content: `${CANARY}1: Just signed up. Testing this memory system.`,
      layer: 'SESSION',
      source: 'EXPLICIT_STATEMENT',
      importanceScore: 0.3,
      tags: ['intro'],
      created_at: subDays(10),
    },
    {
      fixture_id: 'eve_002',
      content: `${CANARY}2: Second memory. Still figuring things out.`,
      layer: 'SESSION',
      source: 'EXPLICIT_STATEMENT',
      importanceScore: 0.3,
      tags: ['intro'],
      created_at: subDays(9),
    },
    {
      fixture_id: 'eve_003',
      content: `${CANARY}3: I like cats.`,
      layer: 'IDENTITY',
      memoryType: 'PREFERENCE',
      source: 'EXPLICIT_STATEMENT',
      importanceScore: 0.4,
      tags: ['pets'],
      created_at: subDays(8),
    },
    {
      fixture_id: 'eve_004',
      content: `${CANARY}4: Working from home today.`,
      layer: 'SESSION',
      memoryType: 'EVENT',
      source: 'EXPLICIT_STATEMENT',
      importanceScore: 0.2,
      tags: ['work'],
      created_at: subDays(7),
    },
    {
      fixture_id: 'eve_005',
      content: `${CANARY}5: Need to buy groceries.`,
      layer: 'TASK',
      memoryType: 'TASK',
      source: 'EXPLICIT_STATEMENT',
      importanceScore: 0.5,
      tags: ['todo'],
      created_at: subDays(6),
    },
    {
      fixture_id: 'eve_006',
      content: `${CANARY}6: Had a great day!`,
      layer: 'SESSION',
      memoryType: 'EVENT',
      source: 'EXPLICIT_STATEMENT',
      importanceScore: 0.3,
      tags: ['mood'],
      created_at: subDays(5),
    },
    {
      fixture_id: 'eve_007',
      content: `${CANARY}7: Learned something new about TypeScript generics.`,
      layer: 'SESSION',
      memoryType: 'FACT',
      source: 'EXPLICIT_STATEMENT',
      importanceScore: 0.4,
      tags: ['learning', 'tech'],
      created_at: subDays(4),
    },
    {
      fixture_id: 'eve_008',
      content: `${CANARY}8: Rainy day. Stayed inside.`,
      layer: 'SESSION',
      memoryType: 'EVENT',
      source: 'EXPLICIT_STATEMENT',
      importanceScore: 0.1,
      tags: ['weather'],
      created_at: subDays(3),
    },
    {
      fixture_id: 'eve_009',
      content: `${CANARY}9: Pizza for dinner. Hawaiian, obviously.`,
      layer: 'SESSION',
      memoryType: 'PREFERENCE',
      source: 'EXPLICIT_STATEMENT',
      importanceScore: 0.3,
      tags: ['food'],
      created_at: subDays(2),
    },
    {
      fixture_id: 'eve_010',
      content: `${CANARY}10: This system is pretty cool.`,
      layer: 'SESSION',
      memoryType: 'EVENT',
      source: 'EXPLICIT_STATEMENT',
      importanceScore: 0.2,
      tags: ['feedback'],
      created_at: subDays(1),
    },
  ],
};

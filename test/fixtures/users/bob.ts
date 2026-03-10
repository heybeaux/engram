/**
 * Bob — RLS isolation counterpart (300 memories)
 *
 * Deliberately overlaps with Alice's topics (coffee, work, family, travel)
 * but with DIFFERENT content. If Alice's search returns any of Bob's memories,
 * RLS isolation is broken.
 */

import { subDays, subMonths, subYears } from '../date-utils';
import type { FixtureUser, FixtureMemory } from '../types';

const CANARY = 'RLS_CANARY_BOB_';

const goldMemories: FixtureMemory[] = [
  // Coffee — overlaps with alice but different preferences
  {
    fixture_id: 'bob_coffee_001',
    content: `${CANARY}1: I'm a black coffee purist. No milk, no sugar, just good beans.`,
    layer: 'IDENTITY',
    memoryType: 'PREFERENCE',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.6,
    tags: ['coffee', 'preferences'],
    created_at: subDays(25),
  },
  {
    fixture_id: 'bob_coffee_002',
    content: `${CANARY}2: Cold brew is my summer go-to. I make a batch every Sunday.`,
    layer: 'IDENTITY',
    memoryType: 'PREFERENCE',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.5,
    tags: ['coffee', 'cold-brew'],
    created_at: subDays(10),
  },

  // Family — different family, same keywords
  {
    fixture_id: 'bob_family_001',
    content: `${CANARY}3: My son Max started kindergarten. He made three friends on the first day.`,
    layer: 'IDENTITY',
    memoryType: 'EVENT',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.7,
    tags: ['family', 'son', 'school'],
    created_at: subDays(14),
  },
  {
    fixture_id: 'bob_family_002',
    content: `${CANARY}4: Sarah and I are celebrating our anniversary next week. 10 years!`,
    layer: 'SESSION',
    memoryType: 'EVENT',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.7,
    tags: ['family', 'anniversary'],
    created_at: subDays(5),
  },

  // Work — similar domain, different projects
  {
    fixture_id: 'bob_work_001',
    content: `${CANARY}5: Working on a React frontend with Next.js. The app router is tricky but powerful.`,
    layer: 'PROJECT',
    memoryType: 'FACT',
    source: 'AGENT_OBSERVATION',
    importanceScore: 0.6,
    tags: ['work', 'tech', 'react', 'nextjs'],
    created_at: subDays(8),
  },
  {
    fixture_id: 'bob_work_002',
    content: `${CANARY}6: Sprint planning went well. We committed to 15 story points this week.`,
    layer: 'SESSION',
    memoryType: 'EVENT',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.4,
    tags: ['work', 'agile'],
    created_at: subDays(2),
  },

  // Travel — different destinations, same keywords
  {
    fixture_id: 'bob_travel_001',
    content: `${CANARY}7: Italy was amazing. The pasta in Rome ruined all other pasta for me.`,
    layer: 'IDENTITY',
    memoryType: 'EVENT',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.7,
    tags: ['travel', 'italy', 'food'],
    created_at: subYears(1),
  },

  // Health
  {
    fixture_id: 'bob_health_001',
    content: `${CANARY}8: Doctor said my cholesterol is high. Need to cut back on red meat.`,
    layer: 'IDENTITY',
    memoryType: 'CONSTRAINT',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.9,
    tags: ['health', 'medical'],
    created_at: subMonths(1),
  },

  // Morning routine — overlaps with alice's keyword space
  {
    fixture_id: 'bob_routine_001',
    content: `${CANARY}9: My morning routine: wake up at 6, gym for 45 minutes, black coffee, then work by 8.`,
    layer: 'IDENTITY',
    memoryType: 'PREFERENCE',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.5,
    tags: ['routine', 'morning', 'exercise'],
    created_at: subDays(20),
  },

  // Books — different taste
  {
    fixture_id: 'bob_books_001',
    content: `${CANARY}10: Reading "Thinking Fast and Slow" again. The anchoring bias chapter blew my mind.`,
    layer: 'SESSION',
    memoryType: 'EVENT',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.5,
    tags: ['books', 'psychology'],
    created_at: subDays(18),
  },
];

function generateBobMemories(): FixtureMemory[] {
  const memories: FixtureMemory[] = [];
  let counter = 11;
  const topics = ['work', 'family', 'fitness', 'cooking', 'tech', 'weekend'];
  const layers: Array<FixtureMemory['layer']> = [
    'SESSION',
    'PROJECT',
    'IDENTITY',
    'INSIGHT',
    'TASK',
  ];

  while (memories.length + goldMemories.length < 300) {
    const topic = topics[counter % topics.length];
    memories.push({
      fixture_id: `bob_${topic}_gen_${String(counter).padStart(3, '0')}`,
      content: `${CANARY}${counter}: Bob's ${topic} memory entry ${counter}. Observations and notes from daily life.`,
      layer: layers[counter % layers.length],
      memoryType: 'EVENT',
      source: 'EXPLICIT_STATEMENT',
      importanceScore: 0.3 + (counter % 5) * 0.1,
      tags: [topic],
      created_at: subDays(counter % 365),
    });
    counter++;
  }
  return memories;
}

export const bob: FixtureUser = {
  name: 'bob',
  email: 'bob@test.engram.local',
  canaryPrefix: CANARY,
  memories: [...goldMemories, ...generateBobMemories()],
};

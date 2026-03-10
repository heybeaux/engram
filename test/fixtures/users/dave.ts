/**
 * Dave — Temporal testing (200 memories)
 *
 * All memories on the same topic (daily standup notes) so temporal ranking
 * is the only differentiator. Clustered at 4 time intervals.
 */

import { subDays, subMonths, subYears } from '../date-utils';
import type { FixtureUser, FixtureMemory } from '../types';

const CANARY = 'RLS_CANARY_DAVE_';

function generateDaveMemories(): FixtureMemory[] {
  const memories: FixtureMemory[] = [];
  let counter = 1;

  const clusters: Array<{
    label: string;
    dateFn: (i: number) => Date;
    count: number;
  }> = [
    { label: 'today', dateFn: (i) => subDays(i), count: 50 },
    { label: 'week', dateFn: (i) => subDays(7 + i), count: 50 },
    { label: '6months', dateFn: (_i) => subMonths(6), count: 50 },
    { label: '2years', dateFn: (_i) => subYears(2), count: 50 },
  ];

  for (const cluster of clusters) {
    for (let i = 0; i < cluster.count; i++) {
      memories.push({
        fixture_id: `dave_${cluster.label}_${String(counter).padStart(3, '0')}`,
        content: `${CANARY}${counter}: Daily standup note (${cluster.label} cluster, entry ${i + 1}): Worked on feature implementation, attended sync meeting, reviewed PRs. Progress is steady.`,
        layer: 'SESSION',
        memoryType: 'EVENT',
        source: 'EXPLICIT_STATEMENT',
        importanceScore: 0.4,
        tags: ['standup', 'daily', cluster.label],
        created_at: cluster.dateFn(i),
      });
      counter++;
    }
  }

  return memories;
}

export const dave: FixtureUser = {
  name: 'dave',
  email: 'dave@test.engram.local',
  canaryPrefix: CANARY,
  memories: generateDaveMemories(),
};

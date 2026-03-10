/**
 * Test Fixtures barrel export + seeding utilities.
 */

export { alice } from './users/alice';
export { bob } from './users/bob';
export { carol } from './users/carol';
export { dave } from './users/dave';
export { eve } from './users/eve';

export {
  GOLD_QUERIES,
  QUERY_COUNT,
  QUERIES_BY_CATEGORY,
} from './queries/gold-queries';
export type { FixtureMemory, FixtureUser, GoldQuery } from './types';

import { alice } from './users/alice';
import { bob } from './users/bob';
import { carol } from './users/carol';
import { dave } from './users/dave';
import { eve } from './users/eve';
import type { FixtureUser } from './types';

/** All fixture users in a convenient array */
export const ALL_USERS: FixtureUser[] = [alice, bob, carol, dave, eve];

/** Total memory count across all users */
export const TOTAL_MEMORY_COUNT = ALL_USERS.reduce(
  (sum, u) => sum + u.memories.length,
  0,
);

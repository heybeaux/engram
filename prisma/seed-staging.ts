/**
 * Staging Seed Script
 *
 * Creates synthetic test data for the staging environment.
 * Run: pnpm seed:staging (with DATABASE_URL pointing to staging DB)
 *
 * NEVER run this against production!
 */

import { PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';

const prisma = new PrismaClient();

// Deterministic IDs for reproducibility
const ACCOUNT_ID = 'stg_account_001';
const AGENT_HUMAN_ID = 'stg_agent_human';
const AGENT_AI_ID = 'stg_agent_ai';
const USER_IDS = ['stg_user_alice', 'stg_user_bob', 'stg_user_charlie'];

const MEMORY_LAYERS = ['IDENTITY', 'PROJECT', 'SESSION', 'TASK', 'INSIGHT'] as const;
const MEMORY_TYPES = ['CONSTRAINT', 'PREFERENCE', 'FACT', 'TASK', 'EVENT', 'LESSON'] as const;
const SUBJECT_TYPES = ['USER', 'AGENT', 'ENTITY'] as const;
const MEMORY_SOURCES = [
  'EXPLICIT_STATEMENT',
  'AGENT_OBSERVATION',
  'AGENT_REFLECTION',
  'CORRECTION',
  'PATTERN_DETECTED',
] as const;

const ENTITY_TYPES = [
  'PERSON',
  'PLACE',
  'ORGANIZATION',
  'CONCEPT',
  'EVENT',
  'OBJECT',
] as const;

const RELATIONSHIP_TYPES = [
  'FRIEND_OF',
  'WORKS_AT',
  'LIVES_IN',
  'MEMBER_OF',
  'RELATED_TO',
  'OWNS',
  'COLLEAGUE_OF',
  'PART_OF',
] as const;

const CHAIN_LINK_TYPES = [
  'LED_TO',
  'SUPPORTS',
  'CONTRADICTS',
  'UPDATES',
  'RELATED',
] as const;

// Realistic memory content templates
const MEMORY_TEMPLATES = [
  // CONSTRAINT
  'User is allergic to {item}. This is safety-critical and must always be respected.',
  'Never recommend {item} — user has explicitly stated this is a hard boundary.',
  'User takes {item} medication daily. Must not suggest interactions.',
  // PREFERENCE
  'Prefers {item} over alternatives. Mentioned multiple times.',
  'Likes to work in {item} mode. Default to this when possible.',
  'User prefers {item} for communication.',
  // FACT
  'Works as a {item} at {company}.',
  'Lives in {city}, moved there in 2023.',
  'Has a {item} named {name}.',
  '{name} is their {relation}.',
  // TASK
  'Need to follow up on {item} by end of week.',
  'Reminder: {item} meeting scheduled for next Tuesday.',
  'TODO: Review {item} draft and provide feedback.',
  // EVENT
  'Had a great conversation about {item} today.',
  'Mentioned feeling stressed about {item} deadline.',
  'Celebrated {item} milestone yesterday.',
  // LESSON
  'Learned that {item} approach works better than the alternative.',
  'Correction: Previously thought {item}, but user clarified it\'s actually {alt}.',
  'Pattern: User tends to {item} when under pressure.',
];

const ITEMS = [
  'peanuts', 'shellfish', 'dark mode', 'TypeScript', 'morning routines',
  'React', 'Python', 'coffee', 'remote work', 'agile methodology',
  'machine learning', 'PostgreSQL', 'Docker', 'Kubernetes', 'GraphQL',
  'REST APIs', 'microservices', 'monorepos', 'CI/CD', 'testing',
];

const CITIES = ['San Francisco', 'Portland', 'Seattle', 'Austin', 'Denver'];
const COMPANIES = ['Acme Corp', 'TechStart Inc', 'DataFlow Labs', 'CloudNine Systems'];
const NAMES = ['Luna', 'Max', 'Sarah', 'James', 'Aria', 'Kai'];
const RELATIONS = ['partner', 'sibling', 'close friend', 'mentor', 'colleague'];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function fillTemplate(template: string): string {
  return template
    .replace('{item}', pick(ITEMS))
    .replace('{city}', pick(CITIES))
    .replace('{company}', pick(COMPANIES))
    .replace('{name}', pick(NAMES))
    .replace('{relation}', pick(RELATIONS))
    .replace('{alt}', pick(ITEMS));
}

function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

async function main() {
  console.log('🌱 Seeding staging environment...\n');

  // Safety check
  const nodeEnv = process.env.NODE_ENV;
  if (nodeEnv === 'production') {
    throw new Error('❌ ABORT: Cannot run seed against production!');
  }

  // 1. Account
  console.log('Creating account...');
  const account = await prisma.account.upsert({
    where: { id: ACCOUNT_ID },
    update: {},
    create: {
      id: ACCOUNT_ID,
      email: 'staging@openengram.ai',
      passwordHash: hashApiKey('staging-password-not-real'),
      name: 'Staging Test Account',
      plan: 'SCALE',
      isAdmin: true,
    },
  });

  // 2. Agents
  console.log('Creating agents...');
  const humanApiKey = 'eng_stg_human_' + crypto.randomBytes(16).toString('hex');
  const aiApiKey = 'eng_stg_ai_' + crypto.randomBytes(16).toString('hex');

  const agentHuman = await prisma.agent.upsert({
    where: { id: AGENT_HUMAN_ID },
    update: {},
    create: {
      id: AGENT_HUMAN_ID,
      name: 'Staging Human Agent',
      apiKeyHash: hashApiKey(humanApiKey),
      apiKeyHint: humanApiKey.slice(-8),
      accountId: account.id,
    },
  });

  const agentAI = await prisma.agent.upsert({
    where: { id: AGENT_AI_ID },
    update: {},
    create: {
      id: AGENT_AI_ID,
      name: 'Staging AI Agent',
      apiKeyHash: hashApiKey(aiApiKey),
      apiKeyHint: aiApiKey.slice(-8),
      accountId: account.id,
    },
  });

  // 3. Users
  console.log('Creating users...');
  const users = await Promise.all(
    USER_IDS.map((id, i) =>
      prisma.user.upsert({
        where: { id },
        update: {},
        create: {
          id,
          externalId: `ext_user_${i + 1}`,
          displayName: ['Alice Chen', 'Bob Martinez', 'Charlie Kim'][i],
          accountId: account.id,
        },
      }),
    ),
  );

  // 4. Sessions (for episodic memories)
  console.log('Creating sessions...');
  const sessions = await Promise.all(
    users.flatMap((user, ui) =>
      Array.from({ length: 3 }, (_, si) =>
        prisma.session.upsert({
          where: { id: `stg_session_${ui}_${si}` },
          update: {},
          create: {
            id: `stg_session_${ui}_${si}`,
            userId: user.id,
            startedAt: new Date(Date.now() - (10 - si) * 86400000),
            endedAt:
              si < 2
                ? new Date(Date.now() - (10 - si) * 86400000 + 3600000)
                : undefined,
          },
        }),
      ),
    ),
  );

  // 5. Memories — 200 total across layers
  console.log('Creating 200 memories...');
  const memories: any[] = [];
  const layerDistribution = {
    IDENTITY: 20,
    PROJECT: 30,
    SESSION: 60,
    TASK: 40,
    INSIGHT: 50,
  };

  let memIdx = 0;
  for (const [layer, count] of Object.entries(layerDistribution)) {
    for (let i = 0; i < count; i++) {
      const userId = pick(USER_IDS);
      const sessionIdx = Math.floor(Math.random() * 9);
      const memType = pick(MEMORY_TYPES);
      const priority =
        memType === 'CONSTRAINT' || memType === 'LESSON'
          ? 1
          : memType === 'PREFERENCE' || memType === 'TASK'
            ? 2
            : memType === 'FACT'
              ? 3
              : 4;

      const raw = fillTemplate(pick(MEMORY_TEMPLATES));

      const memory = await prisma.memory.create({
        data: {
          id: `stg_mem_${String(memIdx).padStart(3, '0')}`,
          userId,
          layer: layer as any,
          memoryType: memType as any,
          priority,
          raw,
          subjectType: pick(SUBJECT_TYPES) as any,
          source: pick(MEMORY_SOURCES) as any,
          importanceScore: Math.random() * 0.6 + 0.4,
          effectiveScore: Math.random() * 0.6 + 0.4,
          confidence: Math.random() * 0.3 + 0.7,
          sessionId:
            layer === 'SESSION'
              ? sessions[sessionIdx % sessions.length].id
              : undefined,
          safetyCritical:
            memType === 'CONSTRAINT' ? Math.random() > 0.3 : false,
          createdAt: new Date(
            Date.now() - Math.floor(Math.random() * 30) * 86400000,
          ),
        },
      });
      memories.push(memory);
      memIdx++;
    }
  }

  // 6. Memory Extractions (5W1H) for ~half the memories
  console.log('Creating memory extractions (5W1H)...');
  const extractionMemories = memories.filter(() => Math.random() > 0.5);
  for (const mem of extractionMemories) {
    await prisma.memoryExtraction.create({
      data: {
        memoryId: mem.id,
        who: pick(NAMES),
        what: mem.raw.slice(0, 80),
        when: Math.random() > 0.5 ? new Date(Date.now() - Math.random() * 30 * 86400000) : null,
        whereCtx: Math.random() > 0.5 ? pick(CITIES) : null,
        why: Math.random() > 0.5 ? 'User stated explicitly' : null,
        how: Math.random() > 0.5 ? 'Through direct conversation' : null,
        topics: [pick(ITEMS), pick(ITEMS)].filter((v, i, a) => a.indexOf(v) === i),
        memoryType: mem.memoryType,
        typeConfidence: Math.random() * 0.3 + 0.7,
        whoConfidence: Math.random() * 0.4 + 0.6,
        whatConfidence: Math.random() * 0.3 + 0.7,
        whenConfidence: Math.random() > 0.5 ? Math.random() * 0.5 + 0.5 : null,
        whereConfidence: Math.random() > 0.5 ? Math.random() * 0.5 + 0.5 : null,
        model: 'gpt-4o-mini',
      },
    });
  }

  // 7. Entities (20 graph entities with relationships)
  console.log('Creating 20 graph entities...');
  const entityData = [
    { name: 'Alice Chen', type: 'PERSON' },
    { name: 'Bob Martinez', type: 'PERSON' },
    { name: 'Charlie Kim', type: 'PERSON' },
    { name: 'Sarah Johnson', type: 'PERSON' },
    { name: 'James Wright', type: 'PERSON' },
    { name: 'Acme Corp', type: 'ORGANIZATION' },
    { name: 'TechStart Inc', type: 'ORGANIZATION' },
    { name: 'DataFlow Labs', type: 'ORGANIZATION' },
    { name: 'San Francisco', type: 'PLACE' },
    { name: 'Portland', type: 'PLACE' },
    { name: 'Seattle', type: 'PLACE' },
    { name: 'Machine Learning', type: 'CONCEPT' },
    { name: 'Microservices', type: 'CONCEPT' },
    { name: 'DevOps', type: 'CONCEPT' },
    { name: 'Product Launch', type: 'EVENT' },
    { name: 'Team Offsite', type: 'EVENT' },
    { name: 'Quarterly Review', type: 'EVENT' },
    { name: 'MacBook Pro', type: 'OBJECT' },
    { name: 'Standing Desk', type: 'OBJECT' },
    { name: 'API Gateway', type: 'CONCEPT' },
  ];

  const entities = await Promise.all(
    entityData.map((e, i) =>
      prisma.graphEntity.upsert({
        where: {
          userId_name_type: {
            userId: USER_IDS[i % USER_IDS.length],
            name: e.name,
            type: e.type as any,
          },
        },
        update: {},
        create: {
          id: `stg_entity_${String(i).padStart(2, '0')}`,
          userId: USER_IDS[i % USER_IDS.length],
          name: e.name,
          type: e.type as any,
          mentionCount: Math.floor(Math.random() * 20) + 1,
        },
      }),
    ),
  );

  // 8. Relationships between entities
  console.log('Creating entity relationships...');
  const relationshipPairs = [
    [0, 5, 'WORKS_AT'],
    [1, 6, 'WORKS_AT'],
    [2, 7, 'WORKS_AT'],
    [0, 8, 'LIVES_IN'],
    [1, 9, 'LIVES_IN'],
    [2, 10, 'LIVES_IN'],
    [0, 1, 'COLLEAGUE_OF'],
    [0, 3, 'FRIEND_OF'],
    [1, 4, 'FRIEND_OF'],
    [5, 11, 'RELATED_TO'],
    [6, 12, 'RELATED_TO'],
    [7, 13, 'RELATED_TO'],
    [0, 17, 'OWNS'],
    [14, 5, 'PART_OF'],
    [15, 6, 'PART_OF'],
  ];

  for (const [srcIdx, tgtIdx, relType] of relationshipPairs) {
    const src = entities[srcIdx as number];
    const tgt = entities[tgtIdx as number];
    if (!src || !tgt) continue;

    await prisma.graphRelationship.create({
      data: {
        userId: src.userId,
        sourceEntityId: src.id,
        targetEntityId: tgt.id,
        type: relType as any,
        weight: Math.random() * 0.5 + 0.5,
      },
    });
  }

  // 9. Chain links between related memories
  console.log('Creating memory chain links...');
  for (let i = 0; i < 30; i++) {
    const srcIdx = Math.floor(Math.random() * (memories.length - 1));
    let tgtIdx = srcIdx + 1 + Math.floor(Math.random() * 5);
    if (tgtIdx >= memories.length) tgtIdx = memories.length - 1;
    if (srcIdx === tgtIdx) continue;

    try {
      await prisma.memoryChainLink.create({
        data: {
          sourceId: memories[srcIdx].id,
          targetId: memories[tgtIdx].id,
          linkType: pick(CHAIN_LINK_TYPES) as any,
          confidence: Math.random() * 0.3 + 0.7,
          createdBy: 'staging-seed',
        },
      });
    } catch {
      // Skip duplicate links
    }
  }

  // Summary
  console.log('\n✅ Staging seed complete!');
  console.log(`   Account:       ${account.id} (${account.email})`);
  console.log(`   Agents:        ${agentHuman.name}, ${agentAI.name}`);
  console.log(`   Users:         ${users.map((u) => u.displayName).join(', ')}`);
  console.log(`   Memories:      ${memories.length}`);
  console.log(`   Extractions:   ${extractionMemories.length}`);
  console.log(`   Entities:      ${entities.length}`);
  console.log(`   Relationships: ${relationshipPairs.length}`);
  console.log(`   Chain links:   ~30`);
  console.log(`\n   Human API key: ${humanApiKey}`);
  console.log(`   AI API key:    ${aiApiKey}`);
  console.log('\n   ⚠️  Save these API keys — they cannot be recovered!');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

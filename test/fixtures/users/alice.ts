/**
 * Alice — Primary recall target (500 memories)
 *
 * Rich mix of topics, emotions, temporal spread over 2 years.
 * Used for: semantic recall accuracy, emotional retrieval, correction chains.
 */

import { subDays, subMonths, subYears } from '../date-utils';
import type { FixtureUser, FixtureMemory } from '../types';

const CANARY = 'RLS_CANARY_ALICE_';

// ── Hand-curated gold memories (for benchmark queries) ──────────

const goldMemories: FixtureMemory[] = [
  // Coffee preferences (overlaps with bob — RLS test)
  {
    fixture_id: 'alice_coffee_001',
    content: `${CANARY}1: I switched from drip coffee to pour-over last month. The V60 changed everything.`,
    layer: 'IDENTITY',
    memoryType: 'PREFERENCE',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.6,
    tags: ['coffee', 'preferences'],
    created_at: subDays(30),
  },
  {
    fixture_id: 'alice_coffee_002',
    content: `${CANARY}2: My morning coffee routine is non-negotiable. Large dairy latte when I'm out, V60 pour-over at home.`,
    layer: 'IDENTITY',
    memoryType: 'PREFERENCE',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.7,
    tags: ['coffee', 'morning', 'routine'],
    created_at: subDays(15),
  },
  // Correction chain — tests supersession
  {
    fixture_id: 'alice_coffee_003_old',
    content: `${CANARY}3: I drink dark roast exclusively.`,
    layer: 'IDENTITY',
    memoryType: 'PREFERENCE',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.5,
    tags: ['coffee'],
    created_at: subMonths(6),
  },
  {
    fixture_id: 'alice_coffee_004_correction',
    content: `${CANARY}4: Actually, I've moved to medium roast. Dark was too bitter.`,
    layer: 'IDENTITY',
    memoryType: 'PREFERENCE',
    source: 'CORRECTION',
    importanceScore: 0.7,
    tags: ['coffee'],
    created_at: subDays(10),
  },

  // Family
  {
    fixture_id: 'alice_family_001',
    content: `${CANARY}5: Family update: my daughter Stella just turned 5! The kids loved the unicorn-themed birthday party.`,
    layer: 'IDENTITY',
    memoryType: 'EVENT',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.8,
    tags: ['family', 'daughter', 'birthday'],
    created_at: subDays(3),
  },
  {
    fixture_id: 'alice_family_002',
    content: `${CANARY}6: Deanna and I are planning a trip to Australia next year. She's never been.`,
    layer: 'IDENTITY',
    memoryType: 'FACT',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.7,
    tags: ['family', 'travel', 'australia'],
    created_at: subDays(20),
  },
  {
    fixture_id: 'alice_family_003',
    content: `${CANARY}7: Odin started daycare this week. He cried on the first day but was fine by day three.`,
    layer: 'SESSION',
    memoryType: 'EVENT',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.6,
    tags: ['family', 'son', 'daycare'],
    created_at: subDays(3),
  },

  // Work/Tech
  {
    fixture_id: 'alice_work_001',
    content: `${CANARY}8: Main work project: my tech stack is NestJS with Prisma and PostgreSQL. Writing all the backend code in TypeScript — the pgvector extension is amazing for semantic search.`,
    layer: 'PROJECT',
    memoryType: 'FACT',
    source: 'AGENT_OBSERVATION',
    importanceScore: 0.7,
    tags: ['work', 'tech', 'nestjs', 'prisma'],
    created_at: subDays(14),
  },
  {
    fixture_id: 'alice_work_002',
    content: `${CANARY}9: Deadlines are killing me this week. Three PRs to review and a demo on Friday.`,
    layer: 'SESSION',
    memoryType: 'EVENT',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.5,
    tags: ['work', 'stress'],
    created_at: subDays(2),
  },
  {
    fixture_id: 'alice_work_003',
    content: `${CANARY}10: The architecture decision to use ensemble search with 4 models was the right call. Recall improved 30%.`,
    layer: 'INSIGHT',
    memoryType: 'FACT',
    source: 'AGENT_OBSERVATION',
    importanceScore: 0.8,
    tags: ['work', 'architecture', 'search'],
    created_at: subMonths(1),
  },

  // Health
  {
    fixture_id: 'alice_health_001',
    content: `${CANARY}11: Health and medical info — my daily medication: I take Synthroid every morning for hypothyroidism. Must be taken on an empty stomach.`,
    layer: 'IDENTITY',
    memoryType: 'CONSTRAINT',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.95,
    tags: ['health', 'medication', 'constraint'],
    created_at: subMonths(3),
  },
  {
    fixture_id: 'alice_health_002',
    content: `${CANARY}12: Getting back into fitness and exercise: started running again. Did 5K in 28 minutes today — not bad after 6 months off.`,
    layer: 'SESSION',
    memoryType: 'EVENT',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.5,
    tags: ['health', 'exercise', 'running'],
    created_at: subDays(5),
  },

  // Travel
  {
    fixture_id: 'alice_travel_001',
    content: `${CANARY}13: Best trip ever was Japan in 2024. The food in Osaka was incredible.`,
    layer: 'IDENTITY',
    memoryType: 'EVENT',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.7,
    tags: ['travel', 'japan', 'food'],
    created_at: subYears(1),
  },
  {
    fixture_id: 'alice_travel_002',
    content: `${CANARY}14: I prefer window seats on flights. Always book exit row if possible.`,
    layer: 'IDENTITY',
    memoryType: 'PREFERENCE',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.4,
    tags: ['travel', 'flights', 'preferences'],
    created_at: subMonths(8),
  },

  // Books
  {
    fixture_id: 'alice_books_001',
    content: `${CANARY}15: Just finished "Project Hail Mary" by Andy Weir. Best sci-fi I've read in years.`,
    layer: 'SESSION',
    memoryType: 'EVENT',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.5,
    tags: ['books', 'sci-fi', 'reading'],
    created_at: subDays(12),
  },

  // Cooking
  {
    fixture_id: 'alice_cooking_001',
    content: `${CANARY}16: My go-to weeknight dinner is a Thai red curry. Takes 20 minutes and the kids love it.`,
    layer: 'IDENTITY',
    memoryType: 'PREFERENCE',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.5,
    tags: ['cooking', 'dinner', 'thai'],
    created_at: subDays(25),
  },

  // Finances
  {
    fixture_id: 'alice_finance_001',
    content: `${CANARY}17: We're saving money for a house down payment. Goal is $50K by end of year.`,
    layer: 'IDENTITY',
    memoryType: 'TASK',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.8,
    tags: ['finance', 'savings', 'house'],
    created_at: subMonths(2),
  },

  // Emotions (for emotional retrieval testing)
  {
    fixture_id: 'alice_joy_001',
    content: `${CANARY}18: Today was perfect. Kids were laughing, sun was out, got a huge feature shipped. Days like this make it all worth it.`,
    layer: 'SESSION',
    memoryType: 'EVENT',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.7,
    tags: ['emotion', 'joy', 'family'],
    created_at: subDays(4),
    metadata: { emotion: 'joy' },
  },
  {
    fixture_id: 'alice_grief_001',
    content: `${CANARY}19: Missing my dad today. Would have been his 70th birthday.`,
    layer: 'SESSION',
    memoryType: 'EVENT',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.8,
    tags: ['emotion', 'grief', 'family'],
    created_at: subMonths(4),
    metadata: { emotion: 'grief' },
  },
  {
    fixture_id: 'alice_stress_001',
    content: `${CANARY}20: Completely overwhelmed. Can't focus. Too many things pulling at me.`,
    layer: 'SESSION',
    memoryType: 'EVENT',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.6,
    tags: ['emotion', 'stress', 'overwhelm'],
    created_at: subDays(1),
    metadata: { emotion: 'stress' },
  },

  // ── Additional emotional memories ─────────────────────────────

  {
    fixture_id: 'alice_worry_001',
    content: `${CANARY}E1: I'm worried about the mortgage rates going up. We might not hit our down payment target if interest rates keep climbing.`,
    layer: 'SESSION',
    memoryType: 'EVENT',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.7,
    tags: ['emotion', 'worry', 'finance'],
    created_at: subDays(6),
    metadata: { emotion: 'worry' },
  },
  {
    fixture_id: 'alice_frustration_001',
    content: `${CANARY}E2: So frustrated with the CI pipeline. Third time it broke this week because of flaky tests.`,
    layer: 'SESSION',
    memoryType: 'EVENT',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.5,
    tags: ['emotion', 'frustration', 'work'],
    created_at: subDays(3),
    metadata: { emotion: 'frustration' },
  },
  {
    fixture_id: 'alice_pride_001',
    content: `${CANARY}E3: Just got promoted to senior engineer. Years of hard work paying off. This is my proudest professional moment.`,
    layer: 'IDENTITY',
    memoryType: 'EVENT',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.9,
    tags: ['emotion', 'pride', 'career'],
    created_at: subMonths(2),
    metadata: { emotion: 'pride' },
  },
  {
    fixture_id: 'alice_anxiety_001',
    content: `${CANARY}E4: Can't stop thinking about the production outage. What if it happens again? The on-call stress is real.`,
    layer: 'SESSION',
    memoryType: 'EVENT',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.6,
    tags: ['emotion', 'anxiety', 'work'],
    created_at: subDays(8),
    metadata: { emotion: 'anxiety' },
  },
  {
    fixture_id: 'alice_mixed_emotion_001',
    content: `${CANARY}E5: Happy that Stella got into the good school, but worried about the tuition costs. Mixed feelings.`,
    layer: 'SESSION',
    memoryType: 'EVENT',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.7,
    tags: ['emotion', 'mixed', 'family', 'finance'],
    created_at: subDays(9),
    metadata: { emotion: 'mixed' },
  },
  {
    fixture_id: 'alice_emotion_change_001',
    content: `${CANARY}E6: Used to dread Monday mornings, but since switching teams I actually look forward to work. Big shift.`,
    layer: 'SESSION',
    memoryType: 'EVENT',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.6,
    tags: ['emotion', 'change', 'work'],
    created_at: subDays(11),
    metadata: { emotion: 'positive_shift' },
  },
  {
    fixture_id: 'alice_calm_001',
    content: `${CANARY}E7: Meditation is helping. 10 minutes every morning before coffee. Feel noticeably calmer.`,
    layer: 'SESSION',
    memoryType: 'EVENT',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.5,
    tags: ['emotion', 'calm', 'wellness'],
    created_at: subDays(4),
    metadata: { emotion: 'calm' },
  },

  // ── Temporal test memories ────────────────────────────────────

  {
    fixture_id: 'alice_yesterday_work_001',
    content: `${CANARY}T1: Yesterday I was debugging the memory deduplication algorithm. Found and fixed a subtle hash collision bug.`,
    layer: 'SESSION',
    memoryType: 'EVENT',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.6,
    tags: ['work', 'debugging', 'recent'],
    created_at: subDays(1),
  },
  {
    fixture_id: 'alice_last_week_work_001',
    content: `${CANARY}T2: Last week was all about the API redesign. Rewrote the auth module and added rate limiting.`,
    layer: 'SESSION',
    memoryType: 'EVENT',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.6,
    tags: ['work', 'api', 'last-week'],
    created_at: subDays(7),
  },
  {
    fixture_id: 'alice_old_preference_001',
    content: `${CANARY}T3: I use Vim for everything. Can't imagine coding without it.`,
    layer: 'IDENTITY',
    memoryType: 'PREFERENCE',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.5,
    tags: ['work', 'editor', 'preference'],
    created_at: subYears(1),
  },
  {
    fixture_id: 'alice_new_preference_001',
    content: `${CANARY}T4: Switched to VS Code with Neovim extension. Best of both worlds. Vim was too bare-bones for modern TypeScript.`,
    layer: 'IDENTITY',
    memoryType: 'PREFERENCE',
    source: 'CORRECTION',
    importanceScore: 0.6,
    tags: ['work', 'editor', 'preference'],
    created_at: subDays(14),
  },
  {
    fixture_id: 'alice_oldest_memory_001',
    content: `${CANARY}T5: This is how I started coding: first learned Python programming from scratch, built a small CLI tool as my very first project. This is where my coding journey began.`,
    layer: 'IDENTITY',
    memoryType: 'EVENT',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.75,
    tags: ['work', 'learning', 'origin', 'coding'],
    created_at: subYears(2),
  },
  {
    fixture_id: 'alice_recent_convo_001',
    content: `${CANARY}T6: Had a good chat with the PM about the Q2 roadmap. We agreed to prioritize the recall benchmark work.`,
    layer: 'SESSION',
    memoryType: 'EVENT',
    source: 'AGENT_OBSERVATION',
    importanceScore: 0.5,
    tags: ['work', 'conversation', 'recent'],
    created_at: subDays(2),
  },

  // ── Cross-feature memories ────────────────────────────────────

  {
    fixture_id: 'alice_identity_project_001',
    content: `${CANARY}X1: I'm a full-stack developer specializing in memory systems. Currently building Engram, a personal memory platform.`,
    layer: 'IDENTITY',
    memoryType: 'FACT',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.9,
    tags: ['identity', 'work', 'engram'],
    created_at: subMonths(3),
  },
  {
    fixture_id: 'alice_high_importance_001',
    content: `${CANARY}X2: Deployment rule and constraint: CRITICAL — never deploy on Fridays. Last time we did, the on-call had to work all weekend fixing a data corruption bug.`,
    layer: 'IDENTITY',
    memoryType: 'CONSTRAINT',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.95,
    tags: ['work', 'constraint', 'deployment'],
    created_at: subMonths(1),
  },
  {
    fixture_id: 'alice_low_importance_001',
    content: `${CANARY}X3: The office has a new coffee machine. Not bad.`,
    layer: 'SESSION',
    memoryType: 'EVENT',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.2,
    tags: ['misc', 'coffee'],
    created_at: subDays(15),
  },
  {
    fixture_id: 'alice_insight_001',
    content: `${CANARY}X4: Work habit pattern noticed: tends to refactor code right after shipping features. Suggest scheduling refactor time in sprint planning.`,
    layer: 'INSIGHT',
    memoryType: 'FACT',
    source: 'PATTERN_DETECTED',
    importanceScore: 0.7,
    tags: ['insight', 'work', 'pattern'],
    created_at: subDays(20),
  },
  {
    fixture_id: 'alice_phone_001',
    content: `${CANARY}X5: My phone number is 604-555-1234. Use this for two-factor auth recovery.`,
    layer: 'IDENTITY',
    memoryType: 'FACT',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.8,
    tags: ['personal', 'contact'],
    created_at: subMonths(6),
  },
  {
    fixture_id: 'alice_address_001',
    content: `${CANARY}X6: My address is 742 Evergreen Terrace, Powell River, BC, V8A 1B2.`,
    layer: 'IDENTITY',
    memoryType: 'FACT',
    source: 'EXPLICIT_STATEMENT',
    importanceScore: 0.8,
    tags: ['personal', 'contact', 'address'],
    created_at: subMonths(6),
  },
];

// ── Template-generated memories ─────────────────────────────────

function generateTemplateMemories(): FixtureMemory[] {
  const memories: FixtureMemory[] = [];
  const topics = [
    {
      topic: 'work',
      templates: [
        'Had a productive meeting about {sub}. Aligned on next steps.',
        'Debugging {sub} today. Found the root cause in the service layer.',
        'Code review for {sub} took longer than expected but caught a critical bug.',
        'Shipped {sub} to staging. Running integration tests now.',
        'Discussed {sub} architecture with the team. Going with option B.',
      ],
      subs: [
        'auth module',
        'search pipeline',
        'dashboard API',
        'caching layer',
        'migration script',
      ],
    },
    {
      topic: 'family',
      templates: [
        'Stella said the funniest thing about {sub} today.',
        'Family {sub} this weekend. Everyone had a great time.',
        'Deanna wants to try {sub}. Looking into it.',
        "Odin's first {sub}. He was so excited.",
        'Planning {sub} for next month. Need to book tickets.',
      ],
      subs: [
        'dinosaurs',
        'picnic',
        'hiking trail',
        'swim lesson',
        'weekend trip',
      ],
    },
    {
      topic: 'learning',
      templates: [
        'Read an interesting article about {sub}.',
        'Watched a talk on {sub}. Key insight: design for failure.',
        'Taking a course on {sub}. Week 3 was the best so far.',
        'TIL: {sub} can be optimized by caching intermediate results.',
        'Bookmarked a paper on {sub} for later deep dive.',
      ],
      subs: [
        'distributed systems',
        'vector databases',
        'TypeScript patterns',
        'ML embeddings',
        'system design',
      ],
    },
    {
      topic: 'daily',
      templates: [
        'Morning routine: {sub}. Feeling good about today.',
        'Afternoon slump hit hard. {sub} helped.',
        'End of day: {sub}. Tomorrow I need to focus on the backlog.',
        'Weekend: {sub}. Recharged and ready for Monday.',
        "Couldn't sleep. Thinking about {sub}.",
      ],
      subs: [
        'coffee and journaling',
        'quick walk',
        'cleared my inbox',
        'bbq with friends',
        'the product roadmap',
      ],
    },
  ];

  let counter = 21; // Continue after gold memories
  const layers: Array<FixtureMemory['layer']> = [
    'SESSION',
    'PROJECT',
    'IDENTITY',
    'INSIGHT',
    'TASK',
  ];
  const sources: Array<FixtureMemory['source']> = [
    'EXPLICIT_STATEMENT',
    'AGENT_OBSERVATION',
    'EXPLICIT_STATEMENT',
    'PATTERN_DETECTED',
    'EXPLICIT_STATEMENT',
  ];

  for (const { topic, templates, subs } of topics) {
    for (let t = 0; t < templates.length; t++) {
      for (let s = 0; s < subs.length; s++) {
        const content = templates[t].replace('{sub}', subs[s]);
        memories.push({
          fixture_id: `alice_${topic}_gen_${String(counter).padStart(3, '0')}`,
          content: `${CANARY}${counter}: ${content}`,
          layer: layers[(t + s) % layers.length],
          memoryType: 'EVENT',
          source: sources[(t + s) % sources.length],
          importanceScore:
            // Noise memories cap at 0.3–0.5. Formula previously used % 7,
            // which made s=1 memories ("quick walk", "search pipeline", etc.)
            // score 0.9 importance — higher than real gold memories (0.7).
            // That contaminated the final reranker blend, burying specific gold
            // memories behind generic daily routine entries.
            0.3 + Math.round((((t * 7 + s * 13) % 3) / 10) * 100) / 100,
          tags: [topic, subs[s].split(' ')[0].toLowerCase()],
          created_at: subDays(counter % 365),
          metadata: {},
        });
        counter++;
      }
    }
  }

  // Pad to ~500 with generic entries
  while (memories.length + goldMemories.length < 500) {
    const i = counter - 21;
    memories.push({
      fixture_id: `alice_misc_gen_${String(counter).padStart(3, '0')}`,
      content: `${CANARY}${counter}: General memory entry ${i} about daily life, random observations, and small moments.`,
      layer: layers[i % layers.length],
      memoryType: 'EVENT',
      source: 'EXPLICIT_STATEMENT',
      importanceScore: 0.3,
      tags: ['misc'],
      created_at: subDays(i % 730),
      metadata: {},
    });
    counter++;
  }

  return memories;
}

export const alice: FixtureUser = {
  name: 'alice',
  email: 'alice@test.engram.local',
  canaryPrefix: CANARY,
  memories: [...goldMemories, ...generateTemplateMemories()],
};

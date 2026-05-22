/**
 * Backfill Memory Types
 * 
 * Classifies existing memories with memoryType and priority using LLM.
 * Run with: npx ts-node scripts/backfill-memory-types.ts
 * 
 * Options:
 *   --dry-run    Preview changes without applying
 *   --limit N    Only process N memories (for testing)
 *   --force      Re-classify memories that already have a type
 */

import { PrismaClient, MemoryType } from '@prisma/client';
import OpenAI from 'openai';

const prisma = new PrismaClient();

// Priority mapping
const TYPE_PRIORITY: Record<MemoryType, number> = {
  CONSTRAINT: 1,  // Never evict
  LESSON: 1,      // Mistakes/corrections - high priority
  PREFERENCE: 2,
  TASK: 2,
  FACT: 3,
  EVENT: 4,
  TASK_OUTCOME: 3,
  SELF_ASSESSMENT: 3,
  DECISION: 2,
  OUTCOME: 3,
  GOAL: 2,
  TEMPORAL_GAP: 4, // System-generated session anchors - low priority, not classified
};

// Classification prompt
const CLASSIFY_PROMPT = `Classify this memory into exactly one type:

CONSTRAINT - Hard requirements, allergies, deal-breakers, must-haves, must-not-haves
  Examples: "allergic to peanuts", "never deploy on Fridays", "must have coffee every morning"
  
PREFERENCE - Soft preferences, likes, dislikes, style choices
  Examples: "prefers dark mode", "likes direct communication", "enjoys hiking"
  
TASK - Action items, todos, reminders, deadlines
  Examples: "need to finish the report by Friday", "should call mom", "deadline is Feb 15"
  
FACT - Biographical data, relationships, technical facts, general knowledge
  Examples: "works at Acme Corp", "has a daughter named Stella", "uses TypeScript"

EVENT - Time-bound occurrences, meetings, conversations, historical events
  Examples: "had a meeting yesterday about the project", "demo happened on Feb 1"

DECISION - A choice that was made, with downstream consequences
  Examples: "decided to go with PostgreSQL", "chose React over Vue", "opted for microservices"

OUTCOME - Result of an action or decision
  Examples: "the migration succeeded", "deployment failed due to timeout", "resulted in 30% speedup"

GOAL - An intended objective, active until resolved or abandoned
  Examples: "want to learn Rust this year", "goal is to reduce latency by 50%", "plan to migrate to K8s"

Memory to classify:
"{memory}"

Respond with ONLY the type name (CONSTRAINT, PREFERENCE, TASK, FACT, EVENT, DECISION, OUTCOME, or GOAL) and a confidence score 0-100.
Format: TYPE|CONFIDENCE

Example responses:
CONSTRAINT|95
PREFERENCE|80
FACT|70`;

interface ClassificationResult {
  type: MemoryType;
  confidence: number;
}

async function classifyMemory(
  client: OpenAI,
  memoryText: string
): Promise<ClassificationResult> {
  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 50,
    messages: [
      {
        role: 'user',
        content: CLASSIFY_PROMPT.replace('{memory}', memoryText),
      },
    ],
  });

  const text = response.choices[0]?.message?.content?.trim() || '';
  const [typeStr, confStr] = text.split('|');
  
  const type = typeStr?.toUpperCase() as MemoryType;
  const confidence = parseInt(confStr || '70', 10);
  
  // Validate type
  if (!Object.keys(TYPE_PRIORITY).includes(type)) {
    console.warn(`Invalid type "${typeStr}" for memory, defaulting to FACT`);
    return { type: MemoryType.FACT, confidence: 50 };
  }
  
  return { type, confidence };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : undefined;

  console.log('Memory Type Backfill');
  console.log('====================');
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Force re-classify: ${force}`);
  console.log(`Limit: ${limit || 'none'}`);
  console.log('');

  // Check for OpenAI API key
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY environment variable required');
    process.exit(1);
  }

  const openai = new OpenAI();

  // Find memories to process
  const whereClause = force 
    ? {} 
    : { memoryType: null };
  
  const memories = await prisma.memory.findMany({
    where: whereClause,
    take: limit,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      raw: true,
      memoryType: true,
      typeConfidence: true,
      priority: true,
    },
  });

  console.log(`Found ${memories.length} memories to classify\n`);

  if (memories.length === 0) {
    console.log('Nothing to do!');
    await prisma.$disconnect();
    return;
  }

  // Stats tracking
  const stats: Record<MemoryType, number> = {
    CONSTRAINT: 0,
    LESSON: 0,
    PREFERENCE: 0,
    TASK: 0,
    FACT: 0,
    EVENT: 0,
    TASK_OUTCOME: 0,
    SELF_ASSESSMENT: 0,
    DECISION: 0,
    OUTCOME: 0,
    GOAL: 0,
    TEMPORAL_GAP: 0, // System-generated, not produced by this classifier
  };

  let processed = 0;
  let errors = 0;

  for (const memory of memories) {
    try {
      const result = await classifyMemory(openai, memory.raw);
      const priority = TYPE_PRIORITY[result.type];

      console.log(`[${++processed}/${memories.length}] ${result.type} (${result.confidence}%) - "${memory.raw.slice(0, 60)}..."`);
      
      stats[result.type]++;

      if (!dryRun) {
        await prisma.memory.update({
          where: { id: memory.id },
          data: {
            memoryType: result.type,
            typeConfidence: result.confidence,
            priority,
          },
        });
      }

      // Rate limiting - Anthropic has limits
      await new Promise(r => setTimeout(r, 200));
      
    } catch (err) {
      console.error(`Error classifying memory ${memory.id}:`, err);
      errors++;
    }
  }

  console.log('\n====================');
  console.log('SUMMARY');
  console.log('====================');
  console.log(`Processed: ${processed}`);
  console.log(`Errors: ${errors}`);
  console.log('');
  console.log('By Type:');
  for (const [type, count] of Object.entries(stats)) {
    const pct = processed > 0 ? ((count / processed) * 100).toFixed(1) : '0';
    console.log(`  ${type}: ${count} (${pct}%)`);
  }

  if (dryRun) {
    console.log('\n[DRY RUN] No changes were made.');
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('Fatal error:', err);
  await prisma.$disconnect();
  process.exit(1);
});

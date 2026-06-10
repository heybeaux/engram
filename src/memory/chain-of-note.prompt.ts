import type { StructuredMemoryItem } from './dto/structured-recall.dto';

const MAX_MEMORIES_FOR_CON = 50;

export function CHAIN_OF_NOTE_TEMPLATE(
  memories: StructuredMemoryItem[],
  question: string,
): string {
  const capped = memories.slice(0, MAX_MEMORIES_FOR_CON);

  const memoriesJson = JSON.stringify(
    capped.map((m) => ({
      id: m.id,
      fact: m.fact,
      confidence: m.confidence,
      timestamp: m.timestamp,
      memory_type: m.memory_type,
    })),
    null,
    2,
  );

  return `You are reading memory search results to answer a question.

For each memory below, write one sentence: "[MEMORY <id>]: <relevance note — relevant / not relevant / partially relevant because …>". When a memory is relevant or partially relevant, quote the specific evidence span from the fact that supports your note (e.g. '[MEMORY abc]: relevant — "redeemed $5 coupon at Target on Sunday"').

Then answer the question based only on relevant memories. If a memory only partially answers the question, use that partial evidence and make clear what is inferred. Only say "I don't know" if no memory contains any evidence — do not abstain when partial evidence exists.

Question: ${question}

Memories:
${memoriesJson}`;
}

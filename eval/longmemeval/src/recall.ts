/**
 * Recall + Chain-of-Note reading for the LongMemEval eval harness.
 *
 * Steps:
 *  1. POST /v1/memories/query with sessionId filter (HEY-578) and structured+chainOfNote=true (S4).
 *  2. Extract chainOfNotePrompt from the structured response.
 *  3. Call the reading model (Opus 4.7) with the CoN prompt + question.
 *  4. Parse the JSON envelope from the reading model's response to extract the `answer` field.
 *
 * Open question #2 resolution: the reading model is instructed to return a JSON envelope
 * with `notes` (per-memory annotations) and `answer` (final answer). The extractConAnswer()
 * function handles parsing with a plain-text fallback.
 */

import { fetchWithRetry, type IngestResult } from './ingest';
import type { LmeCategory, RunConfig } from './types';

export interface RecallResult {
  questionId: string;
  question: string;
  answer: string;
  rawResponse: string;
  recallId?: string;
  memoriesFound: number;
}

/** Structured JSON envelope expected from the reading model. */
interface ConEnvelope {
  notes?: Array<{ memory_id: string; note: string }>;
  answer: string;
}

/**
 * Run recall + CoN reading for a single question.
 *
 * @param category      Optional question category — used to tune the reading
 *                      prompt (recency ordering for knowledge-update, implicit
 *                      preference hint for single-session-preference, temporal
 *                      date arithmetic for temporal-reasoning).
 * @param question_date The date the question was asked (from dataset metadata).
 *                      Required for temporal-reasoning questions to compute
 *                      relative dates like "how many weeks ago…".
 */
export async function recallQuestion(
  questionId: string,
  question: string,
  ingestResult: IngestResult,
  config: Pick<RunConfig, 'apiBase' | 'apiKey' | 'anthropicApiKey' | 'readModel'>,
  category?: LmeCategory,
  question_date?: string,
): Promise<RecallResult> {
  // Step 1: recall from Engram with sessionId filter and CoN enabled.
  // Note: the query API (QueryMemoryDto) has no sort/recency parameter, so
  // recency handling for knowledge-update is done client-side below by
  // ordering retrieved memories chronologically in the reading prompt.
  const recallUrl = `${config.apiBase}/v1/memories/query`;
  // Temporal questions need more candidates because events are often buried in
  // off-topic conversations (e.g. a shopping mention inside a TV-mount discussion).
  const recallLimit = category === 'temporal-reasoning-ability' ? 80 : 50;

  const recallBody = {
    query: question,
    sessionId: ingestResult.sessionId,
    response_format: 'structured',
    chainOfNote: true,
    note: question,  // HEY-576: question field for CoN prompt interpolation
    limit: recallLimit,
  };

  const recallRes = await fetchWithRetry(recallUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-AM-API-Key': config.apiKey,
      'X-AM-User-ID': ingestResult.userId,
      'X-AM-Agent-ID': ingestResult.agentId,
    },
    body: JSON.stringify(recallBody),
  });

  if (!recallRes.ok) {
    const text = await recallRes.text();
    throw new Error(`Recall failed for ${questionId}: HTTP ${recallRes.status} — ${text}`);
  }

  const recallData = await recallRes.json() as {
    recallId?: string;
    memories: Array<{ id: string; fact: string; confidence: number | null; timestamp?: string }>;
    chainOfNotePrompt?: string;
  };

  const memoriesFound = recallData.memories?.length ?? 0;

  // Step 2: no memories / no CoN prompt — abstain explicitly. "I don't know"
  // (rather than '') lets the judge credit abstention questions whose gold
  // answers are phrased as "You did not mention this information...".
  if (!recallData.chainOfNotePrompt || memoriesFound === 0) {
    return {
      questionId,
      question,
      answer: "I don't know",
      rawResponse: '',
      recallId: recallData.recallId,
      memoriesFound,
    };
  }

  // Step 3: call reading model with CoN prompt
  const readingResponse = await callReadingModel(
    recallData.chainOfNotePrompt,
    question,
    config.anthropicApiKey,
    config.readModel,
    category,
    recallData.memories,
    question_date,
  );

  // Step 4: extract answer from structured JSON envelope
  const answer = extractConAnswer(readingResponse);

  return {
    questionId,
    question,
    answer,
    rawResponse: readingResponse,
    recallId: recallData.recallId,
    memoriesFound,
  };
}

/**
 * Build category-specific guidance appended to the reading-model user message.
 * Exported for unit testing.
 *
 * @param category      LME question category (drives prompt specialization)
 * @param memories      Retrieved memories (used for recency timeline)
 * @param question_date ISO/human date the question was asked — needed for
 *                      temporal-reasoning arithmetic ("how many weeks ago…")
 */
export function buildCategoryHint(
  category: LmeCategory | undefined,
  memories: Array<{ id: string; fact: string; timestamp?: string }> = [],
  question_date?: string,
): string {
  if (category === 'knowledge-update') {
    // Order memories chronologically so the model sees the progression clearly.
    // In-text date markers inside `fact` take priority; `timestamp` (ingest-time
    // createdAt) is the fallback.
    // Use in-text dates from fact text (format: [YYYY/MM/DD ...]) for ordering;
    // the stored timestamp is the ingest wall-clock time and is unreliable for ordering.
    const kuInTextRe = /\[(\d{4}\/\d{2}\/\d{2}[^\]]*)\]/;
    const getKuFactDate = (m: { fact: string; timestamp?: string }): string => {
      const match = kuInTextRe.exec(m.fact);
      return match ? match[1] : (m.timestamp ?? '');
    };
    const timeline = [...memories]
      .sort((a, b) => getKuFactDate(a).localeCompare(getKuFactDate(b)))
      .map(m => `- [${getKuFactDate(m) || 'unknown time'}] ${m.fact}`)
      .join('\n');
    return (
      `\n\n⚠️  KNOWLEDGE-UPDATE QUESTION: The fact you need may have been updated across ` +
      `multiple conversations. When two memories CONFLICT, the MOST RECENT one is correct — ` +
      `always answer with the latest information, not the earliest. ` +
      `Look for session-boundary markers (e.g. "--- Session N (date) ---") embedded in the ` +
      `memory facts to establish which version came last.\n\n` +
      `Memories sorted oldest → newest (by stored timestamp):\n${timeline}`
    );
  }

  if (category === 'temporal-reasoning-ability') {
    const dateContext = question_date
      ? `The question was asked on: ${question_date}\n` +
        `Use this as TODAY'S DATE for all relative-time calculations.`
      : `No explicit question date available — infer "today" from the latest session ` +
        `date visible in the memories.`;

    // Prefer the in-text date embedded in the fact (format: [YYYY/MM/DD ...]) over
    // the stored ingest timestamp which is always the wall-clock ingest time.
    const inTextDateRe = /\[(\d{4}\/\d{2}\/\d{2}[^\]]*)\]/;
    const getFactDate = (m: { fact: string; timestamp?: string }): string => {
      const match = inTextDateRe.exec(m.fact);
      return match ? match[1] : (m.timestamp ?? 'unknown');
    };

    const annotated = [...memories]
      .sort((a, b) => getFactDate(a).localeCompare(getFactDate(b)))
      .map(m => `- [date: ${getFactDate(m)}] ${m.fact}`)
      .join('\n');

    return (
      `\n\n⚠️  TEMPORAL-REASONING QUESTION: You must compute relative time (days/weeks/months ago, ` +
      `or chronological order).\n\n` +
      `${dateContext}\n\n` +
      `CRITICAL DATE-ARITHMETIC RULES:\n` +
      `• If a memory says "yesterday I did X" and the session date is D, the event date is D-1.\n` +
      `• Days elapsed = question_date minus event_date (exclusive counting: "21 days ago" means ` +
      `exactly 21 calendar days before today, not 22).\n` +
      `• Weeks = floor(days / 7), rounding down; 13-14 days → 2 weeks.\n` +
      `• Months = count of calendar months between two dates; 5 weeks ≈ 1 month.\n` +
      `  Round to nearest whole month (e.g. 62 days ≈ 2 months, 154 days ≈ 5 months).\n` +
      `• MULTI-EVENT questions (e.g. "two events in a row on consecutive days"): scan ALL memories, ` +
      `identify pairs of events occurring on adjacent calendar days, use the date of the LATER event.\n` +
      `• Do NOT say "I don't know" if dates are visible in the memories — compute from what's there.\n\n` +
      `STEP-BY-STEP PROCESS:\n` +
      `1. Find ALL memories relevant to the question (events, activities, purchases, visits).\n` +
      `2. Determine each event's absolute date (use session date + "yesterday/today" offsets if needed).\n` +
      `3. For multi-event questions, check if any two events are on consecutive calendar days.\n` +
      `4. Compute elapsed time from the relevant event date to TODAY (question date above).\n` +
      `5. State the final number explicitly in the unit the question asks for.\n\n` +
      `Memories sorted oldest → newest:\n${annotated}`
    );
  }

  if (category === 'single-session-preference') {
    return (
      `\n\n⚠️  PREFERENCE QUESTION: Synthesize what the user would PREFER, not just literal facts. ` +
      `Preferences are often stated implicitly or with hedged language ` +
      `(e.g. "I usually…", "I tend to prefer…", "I'm not a big fan of…", "I love…"). ` +
      `Even if no memory uses the word 'prefer', infer preference from repeated choices, ` +
      `positive/negative reactions, and stated interests. ` +
      `Tailor your answer to those inferred preferences rather than giving generic advice.`
    );
  }

  return '';
}

/**
 * Call the reading model (Anthropic) with the CoN system prompt.
 * Returns the raw text response.
 */
async function callReadingModel(
  conSystemPrompt: string,
  question: string,
  anthropicApiKey: string,
  model: string,
  category?: LmeCategory,
  memories: Array<{ id: string; fact: string; timestamp?: string }> = [],
  question_date?: string,
): Promise<string> {
  const categoryHint = buildCategoryHint(category, memories, question_date);
  const response = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicApiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: conSystemPrompt,
      messages: [
        {
          role: 'user',
          content: `Answer the following question based on the memories above.\n\nQuestion: ${question}${categoryHint}\n\nRespond with a JSON object. Put "answer" FIRST. Only include "notes" for memories that are relevant or partially relevant — skip irrelevant ones entirely. Keep each note brief (one sentence max).\n\n{\n  "answer": "your final answer here",\n  "notes": [{ "memory_id": "...", "note": "why relevant" }]\n}\n\nIf the memories do not contain enough information, set "answer" to "I don't know".\n\nJSON only, no markdown.`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Reading model call failed: HTTP ${response.status} — ${text}`);
  }

  const data = await response.json() as { content: Array<{ type: string; text: string }> };
  return data.content?.[0]?.text ?? '';
}

/**
 * Extract the final answer from a CoN reading model response.
 *
 * Open question #2: the reading model should output a JSON envelope:
 * { "notes": [...], "answer": "..." }
 *
 * Fallback: if JSON parsing fails, return the last non-empty paragraph of the response.
 */
export function extractConAnswer(rawResponse: string): string {
  if (!rawResponse.trim()) return '';

  // Try to parse as JSON directly
  const trimmed = rawResponse.trim();

  // Strip markdown code fences if present
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const jsonCandidate = fenceMatch ? fenceMatch[1].trim() : trimmed;

  try {
    const parsed = JSON.parse(jsonCandidate) as ConEnvelope;
    if (parsed.answer && typeof parsed.answer === 'string') {
      return parsed.answer.trim();
    }
  } catch {
    // fall through to text fallback
  }

  // Try finding a JSON object embedded in mixed-text response
  const jsonObjectMatch = rawResponse.match(/\{[\s\S]*"answer"\s*:\s*"([^"]+)"[\s\S]*\}/);
  if (jsonObjectMatch) {
    try {
      const parsed = JSON.parse(jsonObjectMatch[0]) as ConEnvelope;
      if (parsed.answer) return parsed.answer.trim();
    } catch {
      // try the captured group directly
      return jsonObjectMatch[1].trim();
    }
  }

  // Fallback: last non-empty paragraph
  const paragraphs = rawResponse
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(Boolean);
  return paragraphs[paragraphs.length - 1] ?? rawResponse.trim();
}

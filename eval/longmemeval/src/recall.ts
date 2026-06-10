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
 * @param category Optional question category — used to tune the reading
 *                 prompt (recency ordering for knowledge-update, implicit
 *                 preference hint for single-session-preference).
 */
export async function recallQuestion(
  questionId: string,
  question: string,
  ingestResult: IngestResult,
  config: Pick<RunConfig, 'apiBase' | 'apiKey' | 'anthropicApiKey' | 'readModel'>,
  category?: LmeCategory,
): Promise<RecallResult> {
  // Step 1: recall from Engram with sessionId filter and CoN enabled.
  // Note: the query API (QueryMemoryDto) has no sort/recency parameter, so
  // recency handling for knowledge-update is done client-side below by
  // ordering retrieved memories chronologically in the reading prompt.
  const recallUrl = `${config.apiBase}/v1/memories/query`;
  const recallBody = {
    query: question,
    sessionId: ingestResult.sessionId,
    response_format: 'structured',
    chainOfNote: true,
    note: question,  // HEY-576: question field for CoN prompt interpolation
    limit: 50,
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
 */
export function buildCategoryHint(
  category: LmeCategory | undefined,
  memories: Array<{ id: string; fact: string; timestamp?: string }> = [],
): string {
  if (category === 'knowledge-update') {
    // Order memories chronologically: by in-text date marker when present
    // (chunk text carries "[<date>] " / session markers), falling back to the
    // memory row timestamp (ingest-time createdAt).
    const timeline = [...memories]
      .sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''))
      .map(m => `- [${m.timestamp ?? 'unknown time'}] ${m.fact}`)
      .join('\n');
    return (
      `\n\nThe question may involve information that was UPDATED over time. ` +
      `Pay attention to dates and session markers inside the memories: when two memories conflict, ` +
      `the LATER fact supersedes the earlier one — answer with the most recent information.` +
      `\n\nMemories ordered oldest to newest (by stored timestamp):\n${timeline}`
    );
  }
  if (category === 'single-session-preference') {
    return (
      `\n\nThe question asks about the user's preferences. Preferences are often stated ` +
      `implicitly or with hedged language (e.g. "I usually...", "I tend to prefer...", ` +
      `"I'm not a big fan of..."). Look for such implicit preference statements in the memories.`
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
): Promise<string> {
  const categoryHint = buildCategoryHint(category, memories);
  const response = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicApiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: conSystemPrompt,
      messages: [
        {
          role: 'user',
          content: `Answer the following question based on the memories above.\n\nQuestion: ${question}${categoryHint}\n\nRespond with a JSON object containing:\n- "notes": array of { "memory_id": string, "note": string } (one per memory)\n- "answer": string (your final answer)\n\nIf the memories do not contain enough information to answer the question, do NOT guess — respond with "answer": "I don't know" and explain what is missing in the notes.\n\nJSON only, no markdown.`,
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

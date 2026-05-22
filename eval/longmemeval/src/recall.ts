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

import type { IngestResult } from './ingest';
import type { RunConfig } from './types';

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
 */
export async function recallQuestion(
  questionId: string,
  question: string,
  ingestResult: IngestResult,
  config: Pick<RunConfig, 'apiBase' | 'apiKey' | 'anthropicApiKey' | 'readModel'>,
): Promise<RecallResult> {
  // Step 1: recall from Engram with sessionId filter and CoN enabled
  const recallUrl = `${config.apiBase}/v1/memories/query`;
  const recallBody = {
    query: question,
    sessionId: ingestResult.sessionId,
    response_format: 'structured',
    chainOfNote: true,
    note: question,  // HEY-576: question field for CoN prompt interpolation
    limit: 20,
  };

  const recallRes = await fetch(recallUrl, {
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
    memories: Array<{ id: string; fact: string; confidence: number | null }>;
    chainOfNotePrompt?: string;
  };

  const memoriesFound = recallData.memories?.length ?? 0;

  // Step 2: if CoN prompt present, call reading model; otherwise answer "unknown"
  if (!recallData.chainOfNotePrompt || memoriesFound === 0) {
    return {
      questionId,
      question,
      answer: '',
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
 * Call the reading model (Anthropic) with the CoN system prompt.
 * Returns the raw text response.
 */
async function callReadingModel(
  conSystemPrompt: string,
  question: string,
  anthropicApiKey: string,
  model: string,
): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
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
          content: `Answer the following question based on the memories above.\n\nQuestion: ${question}\n\nRespond with a JSON object containing:\n- "notes": array of { "memory_id": string, "note": string } (one per memory)\n- "answer": string (your final answer)\n\nJSON only, no markdown.`,
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

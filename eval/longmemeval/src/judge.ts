/**
 * LLM-based correctness judge for the LongMemEval eval harness.
 *
 * Model: claude-opus-4-7 (hard-coded — do NOT change to Sonnet or Haiku).
 * Uses binary judgement: correct (semantic match) or incorrect.
 */

const JUDGE_MODEL = 'claude-opus-4-7' as const;
const JUDGE_SYSTEM_PROMPT = `You are an answer correctness judge for a memory benchmark.

Your task: determine whether a predicted answer is correct given the gold (expected) answer.

Rules:
- "Correct" means the predicted answer conveys the same information as the gold answer,
  even if worded differently or more verbosely.
- Partial matches are INCORRECT — the prediction must capture the core information.
- If the gold answer is empty or "unknown", the prediction is correct if and only if it also
  expresses uncertainty (e.g., "I don't know", "unknown", "not mentioned").
- Ignore case and minor punctuation differences.
- Numbers must match (e.g., "three" vs "3" is OK, but "three" vs "four" is incorrect).
- Dates must match to the precision given in the gold answer.

Respond with JSON only:
{
  "correct": true | false,
  "reasoning": "One sentence explaining why"
}`;

export interface JudgeResult {
  correct: boolean;
  reasoning: string;
}

/**
 * Judge whether a predicted answer is correct.
 *
 * @param question    The original question
 * @param expected    Gold answer from the dataset
 * @param predicted   Answer produced by the recall+reading pipeline
 * @param apiKey      Anthropic API key
 */
export async function judgeAnswer(
  question: string,
  expected: string,
  predicted: string,
  apiKey: string,
): Promise<JudgeResult> {
  // Fast path: exact match (case-insensitive, trimmed) — skip LLM
  if (expected.trim().toLowerCase() === predicted.trim().toLowerCase()) {
    return { correct: true, reasoning: 'Exact match.' };
  }

  // Fast path: empty prediction — incorrect unless expected is also empty
  if (!predicted.trim()) {
    if (!expected.trim()) {
      return { correct: true, reasoning: 'Both prediction and expected are empty.' };
    }
    return { correct: false, reasoning: 'Prediction is empty; expected a non-empty answer.' };
  }

  const userMessage = `Question: ${question}

Gold answer: ${expected}

Predicted answer: ${predicted}

Is the predicted answer correct?`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      max_tokens: 256,
      system: JUDGE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Judge API call failed: HTTP ${response.status} — ${text}`);
  }

  const data = await response.json() as { content: Array<{ type: string; text: string }> };
  const raw = data.content?.[0]?.text ?? '';

  return parseJudgeResponse(raw, predicted, expected);
}

/** Parse the judge's JSON response with a graceful fallback. */
export function parseJudgeResponse(raw: string, predicted: string, expected: string): JudgeResult {
  const trimmed = raw.trim();

  // Strip markdown fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;

  try {
    const parsed = JSON.parse(candidate) as { correct: boolean; reasoning: string };
    if (typeof parsed.correct === 'boolean') {
      return {
        correct: parsed.correct,
        reasoning: parsed.reasoning ?? '',
      };
    }
  } catch {
    // fall through
  }

  // Fallback: scan for "correct: true/false" pattern
  const correctMatch = raw.match(/"correct"\s*:\s*(true|false)/i);
  if (correctMatch) {
    return {
      correct: correctMatch[1].toLowerCase() === 'true',
      reasoning: 'Parsed from partial JSON.',
    };
  }

  // Final fallback: treat as incorrect if we can't parse
  return {
    correct: false,
    reasoning: `Judge returned unparseable response. Raw: ${raw.slice(0, 100)}`,
  };
}

/**
 * LLM-based correctness judge for the LongMemEval eval harness.
 *
 * Default model: claude-opus-4-7. Override via LONGMEMEVAL_JUDGE_MODEL env var
 * for cheaper smoke runs (e.g. claude-sonnet-4-6).
 * Uses binary judgement: correct (semantic match) or incorrect.
 */

const JUDGE_MODEL: string =
  process.env.LONGMEMEVAL_JUDGE_MODEL ?? 'claude-opus-4-7';
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
  expected: string | number,
  predicted: string,
  apiKey: string,
): Promise<JudgeResult> {
  // Normalize expected to string — integer answers in the dataset crash .trim()
  const expectedStr = typeof expected === 'string' ? expected : String(expected);

  // Fast path: exact match (case-insensitive, trimmed) — skip LLM
  if (expectedStr.trim().toLowerCase() === predicted.trim().toLowerCase()) {
    return { correct: true, reasoning: 'Exact match.' };
  }

  // Fast path: empty prediction — incorrect unless expected is also empty
  if (!predicted.trim()) {
    if (!expectedStr.trim()) {
      return { correct: true, reasoning: 'Both prediction and expected are empty.' };
    }
    return { correct: false, reasoning: 'Prediction is empty; expected a non-empty answer.' };
  }

  const userMessage = `Question: ${question}

Gold answer: ${expectedStr}

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

  return parseJudgeResponse(raw, predicted, expectedStr);
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

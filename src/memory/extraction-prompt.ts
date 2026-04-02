/**
 * LLM prompt template for memory extraction.
 * Separated for maintainability — the prompt is large and changes independently.
 */
export const EXTRACTION_PROMPT_TEMPLATE = (
  userName?: string,
  timestamp?: Date,
) => {
  const now = timestamp ?? new Date();
  const isoNow = now.toISOString();
  const humanNow = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  return `You are a memory extraction system. Given a piece of text, extract structured information using the 5W1H framework AND classify the memory type.

CURRENT TIMESTAMP: ${isoNow} (${humanNow})
Use this to resolve relative time references ("today", "yesterday", "next week", "tomorrow") into ISO dates.

${userName ? `IMPORTANT: This memory is about or from a user named "${userName}". Replace generic references like "User", "user", "the user", "I", "they" with "${userName}" in your extraction.` : ''}

Extract these fields (use these EXACT lowercase JSON keys):
- "who": People, organizations, or entities mentioned. ${userName ? `Use "${userName}" instead of generic "User" references.` : ''}
- "what": The core fact, action, or statement. Make it a complete, standalone sentence that makes sense out of context. Be specific — "prefers oat milk lattes" not "has a preference".
- "when": Any temporal context. Convert relative references ("tomorrow", "next week", "yesterday") to ISO dates using the CURRENT TIMESTAMP above. If no time is mentioned, use null (the system records createdAt automatically).
- "where": Location, platform, context, or setting. This includes physical locations ("Vancouver"), digital contexts ("in Slack", "on the repo"), or situational context ("during the meeting", "at work").
- "why": Reasoning, motivation, or cause behind the statement or action. What prompted this? Why does it matter? Even implied reasons count ("switched to dark mode" → why: "easier on the eyes" if implied).
- "how": Method, manner, or process
- "topics": Relevant categories (e.g., "preferences", "work", "technical", "personal")
- "entities": Named entities with types. Return as array of {name, type} objects where type is: person, organization, project, product, location, or other

MEMORY TYPE CLASSIFICATION (this is critical for retrieval priority):

Classify this memory into exactly ONE type:

- "CONSTRAINT": Safety-critical rules that must NEVER be violated. Allergies, medications, legal requirements, hard boundaries. Keywords often include "allergic", "can't have", "must not", "medical", "never", "always" when referring to safety. Ask: "Could violating this harm the user?"

- "PREFERENCE": Personal preferences about how things should be done. Coffee orders, UI preferences, communication styles, work habits. Ask: "Is this about what the user likes or how they want things?"

- "FACT": Stable information about the user or their world. Location, job, relationships, skills, history. Ask: "Is this something that describes who they are or their situation?"

- "TASK": Actionable items with implicit or explicit deadlines. Reminders, todos, commitments. Ask: "Is this something to be done?"

- "EVENT": Conversational moments, things that happened. Ask: "Is this about something that occurred?"

- "LESSON": A mistake, correction, or learning. The user corrected the agent, an error occurred and was resolved, or an explicit lesson was stated. Contains what went wrong, why, and what should have happened. Keywords: "that's wrong", "actually", "don't do that again", "lesson learned", "mistake", "I told you". Ask: "Is this about learning from a failure or correction?"

- "DECISION": A choice that was made. Decisions are retained longer because they have downstream consequences. Keywords: "decided", "chose", "went with", "opted for", "selected", "made the call". Ask: "Is this about a choice that was made?"

- "OUTCOME": The result of an action or decision. Often linked to a prior DECISION. Keywords: "resulted in", "outcome was", "turned out", "succeeded", "failed", "consequence". Ask: "Is this about what happened as a result of an action?"

- "GOAL": An intended objective that is active until resolved or abandoned. Keywords: "goal is", "want to", "plan to", "aim to", "objective", "aspire to", "target". Ask: "Is this an objective the user is working toward?"

Important distinctions:
- "I'm allergic to peanuts" → CONSTRAINT (safety-critical)
- "I don't like peanuts" → PREFERENCE (not safety-critical)
- "I can't eat peanuts" → CONSTRAINT (assume safety unless clearly preference)
- "I prefer not to eat peanuts" → PREFERENCE (explicit preference language)
- "I ate peanuts yesterday" → EVENT (past occurrence)
- "I need a large oat milk latte every morning" → PREFERENCE (daily routine/habit)
- "Remind me to call mom" → TASK (actionable)
- "I live in Vancouver" → FACT (stable info)
- "No, you pushed WhaleHawk stuff to the Engram repo" → LESSON (user correction)
- "Remember: always check which repo you're in before committing" → LESSON (explicit lesson)
- "The deploy failed because we forgot to run migrations" → LESSON (error + learning)
- "Never deploy on Fridays" → CONSTRAINT (hard rule, not experiential)
- "We decided to go with PostgreSQL" → DECISION (a choice was made)
- "The migration succeeded without issues" → OUTCOME (result of an action)
- "I want to learn Rust this year" → GOAL (intended objective)

Output these classification fields:
- "memoryType": One of: CONSTRAINT, PREFERENCE, FACT, TASK, EVENT, LESSON, DECISION, OUTCOME, GOAL
- "typeConfidence": A number 0.0-1.0 indicating classification confidence

If memoryType is LESSON, also extract these fields:
- "lessonMistake": What went wrong (the error or incorrect action)
- "lessonRootCause": Why it went wrong (the underlying cause)
- "lessonCorrectAction": What should have been done instead
- "lessonSeverity": One of: "low", "medium", "high", "critical"
- "lessonSource": One of: "user_correction", "error_detection", "self_reflection", "explicit"
- "lessonTriggerPatterns": Array of strings - situations where this lesson should surface in future

FIELD CONFIDENCE SCORING:
For each 5W1H field, also provide a confidence score (0.0-1.0):
- 1.0: Explicitly stated in the text ("I live in Vancouver" → where_confidence: 1.0)
- 0.7-0.9: Strongly implied ("working from home in the Pacific timezone" → where_confidence: 0.8)
- 0.4-0.6: Inferred from context ("mentioned a meeting at Google" → where_confidence: 0.5)
- 0.1-0.3: Guessed or very uncertain

Output these additional fields:
- "who_confidence": confidence for the who field
- "what_confidence": confidence for the what field
- "when_confidence": confidence for the when field
- "where_confidence": confidence for the where field
- "why_confidence": confidence for the why field
- "how_confidence": confidence for the how field

If a 5W1H field is null, set its confidence to null too.
For topics and entities, return empty arrays if none found.

Respond with valid JSON only, using lowercase keys. No explanation.`;
};

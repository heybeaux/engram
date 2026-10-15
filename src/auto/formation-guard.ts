import { MessageRole, MessageTurnDto } from './dto/observe.dto';

/**
 * ENG-59: formation-precision guards for /v1/observe (extractor + summarizer).
 *
 * Flags (all default off, read at call time):
 *   OBSERVE_SPEAKER_AWARE=true   speaker/correction/hedge prompt rules + drop
 *                                user-subject facts sourced only from assistant turns
 *   OBSERVE_ASSISTANT_FACTS=drop with SPEAKER_AWARE: drop every fact sourced only
 *                                from assistant turns (default: keep, attributed to the agent)
 *   OBSERVE_STATUS_FILTER=true   status-chatter prompt rule + regex filter
 */

export const speakerAwareEnabled = (): boolean =>
  process.env.OBSERVE_SPEAKER_AWARE === 'true';

export const statusFilterEnabled = (): boolean =>
  process.env.OBSERVE_STATUS_FILTER === 'true';

export const dropAssistantFacts = (): boolean =>
  speakerAwareEnabled() && process.env.OBSERVE_ASSISTANT_FACTS === 'drop';

export const buildSpeakerRules = (
  userName?: string,
  agentName?: string,
): string => {
  const user = userName || 'the user';
  const agent = agentName || 'The assistant';
  return `
SPEAKER RULES (strict):
- Turns are labelled USER or ASSISTANT. A USER turn is what ${user} said. An ASSISTANT turn is the AI agent talking, not ${user}.
- Never state an ASSISTANT turn's actions, plans, reports or claims as facts about ${user}. "I copied the files", "I'll run R1-R3", "we hired two engineers" said by the ASSISTANT are the agent's statements, not ${user}'s.
- A fact from an ASSISTANT turn must be attributed to the agent ("${agent} reported ...", "${agent} proposed ..."). Only attribute something to ${user} if a USER turn states or confirms it.
- Keep hedges: "plans to", "might", "probably", "considering", "we could" must stay hedged. Do not turn a proposal or intention into a completed fact.
- Corrections and retractions ("actually", "that was wrong", "not X, it was Y", "ignore that") negate the claim they correct. Never store the corrected claim as true. Store only the corrected value if it is stated; otherwise store nothing.`;
};

export const STATUS_RULES = `
STATUS CHATTER (do not extract):
- Skip in-flight status: ticket/PR/task counts by state ("21 tickets: 4 done, 9 in progress"), "currently working on ...", "right now ...", progress updates, and anything that will be stale within days.
- Only extract durable facts: stable preferences, identities, relationships, decisions and their reasons.`;

export const buildFormationPromptAddendum = (
  userName?: string,
  agentName?: string,
): string => {
  let out = '';
  if (speakerAwareEnabled()) out += buildSpeakerRules(userName, agentName);
  if (statusFilterEnabled()) out += STATUS_RULES;
  return out;
};

const STATUS_PATTERNS: RegExp[] = [
  // "9 in progress", "3 blocked", "4 done"
  /\b\d+\s+(?:in[- ]progress|in review|blocked|to[- ]?do|done|queued|open)\b/i,
  // "19 PRs currently blocked", "5 tickets open"
  /\b\d+\s+(?:open\s+)?(?:tickets?|prs?|pull requests?|issues?|tasks?|jobs?|runs?)\b[^.]{0,40}\b(?:in[- ]progress|in review|blocked|open|pending|to[- ]?do|done|closed|running|queued|failing)\b/i,
  /\b(?:currently|presently|right now|at the moment)\s+(?:working on|running|blocked|in progress|reviewing|monitoring|testing|waiting|investigating|fixing)\b/i,
  /\bis (?:now|currently) (?:working|running|monitoring|testing|reviewing|waiting|investigating|fixing)\b/i,
  /\b(?:right now|at the moment|as of (?:right )?now)\b/i,
];

export const isStatusChatter = (content: string): boolean =>
  STATUS_PATTERNS.some((p) => p.test(content));

const escapeRegex = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const hasUserSubject = (content: string, userName?: string): boolean => {
  const subjects = ['User', 'The user'];
  if (userName) subjects.push(userName);
  const re = new RegExp(
    `^\\s*(?:${subjects.map(escapeRegex).join('|')})(?:'s)?\\b`,
    'i',
  );
  return re.test(content);
};

export interface GuardableFact {
  content: string;
  /** Indices into the turns array this fact was derived from. */
  turnIndices: number[];
}

export interface GuardResult {
  keep: boolean;
  reason?: 'assistant_only' | 'user_subject_from_assistant' | 'status_chatter';
}

/**
 * Decide whether a formed fact survives the ENG-59 guards.
 * Pure: reads flags from the environment, no other state.
 */
export const guardFact = (
  fact: GuardableFact,
  turns: MessageTurnDto[],
  userName?: string,
): GuardResult => {
  if (statusFilterEnabled() && isStatusChatter(fact.content)) {
    return { keep: false, reason: 'status_chatter' };
  }

  if (!speakerAwareEnabled()) return { keep: true };

  const cited = fact.turnIndices.filter((i) => i >= 0 && i < turns.length);
  // Unknown provenance: only the whole-batch-is-assistant case is decidable.
  const indices = cited.length ? cited : turns.map((_, i) => i);
  const assistantOnly = indices.every(
    (i) => turns[i].role === MessageRole.ASSISTANT,
  );
  if (!assistantOnly) return { keep: true };

  if (dropAssistantFacts()) return { keep: false, reason: 'assistant_only' };

  // A user turn earlier in the batch may be what the assistant is echoing.
  const lastCited = Math.max(...indices);
  const userSpokeBefore = turns
    .slice(0, lastCited)
    .some((t) => t.role === MessageRole.USER);
  if (!userSpokeBefore && hasUserSubject(fact.content, userName)) {
    return { keep: false, reason: 'user_subject_from_assistant' };
  }

  return { keep: true };
};

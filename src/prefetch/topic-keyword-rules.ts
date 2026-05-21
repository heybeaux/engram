import { KeywordRule } from './prefetch.types';

// ============================================================================
// Keyword Rules
// ============================================================================

/**
 * Keyword matching rules for fast first-pass topic detection
 */
export const KEYWORD_RULES: KeywordRule[] = [
  // Family
  {
    topic: 'family',
    patterns: [
      /\b(wife|husband|daughter|son|kid|child|baby|spouse)\b/i,
      /\b(mom|dad|mother|father|parent|sibling|brother|sister)\b/i,
      /\b(family|home|house|domestic)\b/i,
    ],
    weight: 0.6,
  },
  {
    topic: 'family/immediate',
    patterns: [
      /\b(wife|husband|spouse|partner)\b/i,
      /\b(daughter|son|child|kid|baby|toddler)\b/i,
    ],
    weight: 0.7,
  },
  {
    topic: 'family/extended',
    patterns: [
      /\b(mom|dad|mother|father|parent)\b/i,
      /\b(brother|sister|sibling|aunt|uncle|cousin)\b/i,
      /\b(grandma|grandpa|grandmother|grandfather|grandparent)\b/i,
    ],
    weight: 0.6,
  },
  {
    topic: 'family/pets',
    patterns: [
      /\b(dog|cat|pet|puppy|kitten)\b/i,
      /\b(husky|retriever|labrador|german shepherd)\b/i,
      /\b(walk the dog|feed the cat|vet)\b/i,
    ],
    weight: 0.7,
  },

  // Work/Projects
  {
    topic: 'work',
    patterns: [
      /\b(project|work|task|deadline|meeting|standup|sprint)\b/i,
      /\b(client|stakeholder|manager|team|colleague)\b/i,
      /\b(office|workplace|job|career)\b/i,
    ],
    weight: 0.5,
  },
  {
    topic: 'work/role',
    patterns: [
      /\b(my role|my job|my position|my title)\b/i,
      /\b(responsibilities|duties|job description)\b/i,
    ],
    weight: 0.6,
  },
  {
    topic: 'work/colleagues',
    patterns: [
      /\b(colleague|coworker|teammate|boss|manager)\b/i,
      /\b(team member|direct report|supervisor)\b/i,
    ],
    weight: 0.6,
  },
  {
    topic: 'projects',
    patterns: [
      /\b(project|initiative|effort|build|develop)\b/i,
      /\b(working on|building|developing|creating)\b/i,
    ],
    weight: 0.5,
  },
  {
    topic: 'projects/active',
    patterns: [
      /\b(current project|working on|active)\b/i,
      /\b(in progress|ongoing|building now)\b/i,
    ],
    weight: 0.6,
  },

  // Schedule
  {
    topic: 'schedule',
    patterns: [
      /\b(today|tomorrow|yesterday|next week|last week)\b/i,
      /\b(meeting|appointment|calendar|schedule|remind)\b/i,
      /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
      /\b(\d{1,2}:\d{2}|morning|afternoon|evening|noon)\b/i,
    ],
    weight: 0.5,
  },
  {
    topic: 'schedule/today',
    patterns: [
      /\b(today|this morning|this afternoon|tonight)\b/i,
      /\b(today's|today's schedule|today's meeting)\b/i,
    ],
    weight: 0.7,
  },
  {
    topic: 'schedule/week',
    patterns: [
      /\b(this week|next week|last week)\b/i,
      /\b(weekly|week's|weekly meeting)\b/i,
    ],
    weight: 0.6,
  },
  {
    topic: 'events',
    patterns: [
      /\b(event|meeting|conference|workshop)\b/i,
      /\b(birthday|anniversary|holiday|celebration)\b/i,
    ],
    weight: 0.5,
  },
  {
    topic: 'events/meetings',
    patterns: [
      /\b(meeting|standup|sync|one-on-one|1:1)\b/i,
      /\b(call|video call|zoom|teams)\b/i,
    ],
    weight: 0.6,
  },
  {
    topic: 'events/deadlines',
    patterns: [
      /\b(deadline|due date|due by|must finish)\b/i,
      /\b(submission|deliverable|milestone)\b/i,
    ],
    weight: 0.7,
  },

  // Health
  {
    topic: 'health',
    patterns: [
      /\b(health|sick|doctor|medicine|symptom|pain|injury)\b/i,
      /\b(exercise|workout|gym|run|training|diet|nutrition)\b/i,
      /\b(sleep|tired|energy|stress|anxiety|mental)\b/i,
    ],
    weight: 0.6,
  },
  {
    topic: 'health/physical',
    patterns: [
      /\b(exercise|workout|gym|fitness|running|lifting)\b/i,
      /\b(diet|nutrition|weight|calories|meal)\b/i,
      /\b(injury|pain|muscle|joint)\b/i,
    ],
    weight: 0.6,
  },
  {
    topic: 'health/mental',
    patterns: [
      /\b(stress|anxiety|depression|mood|mental health)\b/i,
      /\b(therapy|therapist|counseling|meditation)\b/i,
      /\b(overwhelmed|burnout|anxious|worried)\b/i,
    ],
    weight: 0.7,
  },
  {
    topic: 'health/medical',
    patterns: [
      /\b(doctor|hospital|clinic|appointment|checkup)\b/i,
      /\b(medication|prescription|medicine|treatment)\b/i,
      /\b(diagnosis|condition|symptoms)\b/i,
    ],
    weight: 0.7,
  },

  // Preferences
  {
    topic: 'preferences',
    patterns: [
      /\b(like|prefer|favorite|hate|love|enjoy|dislike)\b/i,
      /\b(always|never|usually|typically)\b/i,
    ],
    weight: 0.4,
    requiresContext: true,
  },
  {
    topic: 'preferences/likes',
    patterns: [
      /\b(like|love|enjoy|prefer|favorite)\b/i,
      /\b(my favorite|i love|i enjoy)\b/i,
    ],
    weight: 0.5,
    requiresContext: true,
  },
  {
    topic: 'preferences/dislikes',
    patterns: [
      /\b(hate|dislike|can't stand|don't like)\b/i,
      /\b(avoid|never|refuse)\b/i,
    ],
    weight: 0.5,
    requiresContext: true,
  },

  // Technical/Engineering
  {
    topic: 'technical',
    patterns: [
      /\b(api|database|server|deploy|kubernetes|docker)\b/i,
      /\b(typescript|javascript|python|rust|sql|node)\b/i,
      /\b(error|exception|bug|debug|trace|log)\b/i,
      /\b(code|programming|software|development)\b/i,
    ],
    weight: 0.7,
  },
  {
    topic: 'technical/skills',
    patterns: [
      /\b(skill|expertise|proficient|experienced)\b/i,
      /\b(learned|learning|studying|mastering)\b/i,
    ],
    weight: 0.5,
  },
  {
    topic: 'technical/tools',
    patterns: [
      /\b(tool|framework|library|platform|service)\b/i,
      /\b(git|github|gitlab|vscode|ide)\b/i,
      /\b(aws|gcp|azure|cloud)\b/i,
    ],
    weight: 0.6,
  },

  // Identity
  {
    topic: 'identity',
    patterns: [
      /\b(i am|i'm|my name|about me)\b/i,
      /\b(my background|where i'm from|grew up)\b/i,
    ],
    weight: 0.5,
  },
  {
    topic: 'identity/values',
    patterns: [
      /\b(believe|value|important to me|care about)\b/i,
      /\b(principle|philosophy|worldview)\b/i,
    ],
    weight: 0.6,
  },
  {
    topic: 'identity/background',
    patterns: [
      /\b(grew up|childhood|hometown|where i'm from)\b/i,
      /\b(history|past|background|origin)\b/i,
    ],
    weight: 0.5,
  },

  // Agent
  {
    topic: 'agent',
    patterns: [
      /\b(you|yourself|your|rook)\b/i,
      /\b(remember when you|you said|you told me)\b/i,
    ],
    weight: 0.4,
    requiresContext: true,
  },
  {
    topic: 'agent/self',
    patterns: [
      /\b(about yourself|tell me about you|who are you)\b/i,
      /\b(your memory|your knowledge|you remember)\b/i,
    ],
    weight: 0.6,
  },
  {
    topic: 'agent/learnings',
    patterns: [
      /\b(learned|lesson|mistake|discovered)\b/i,
      /\b(insight|realization|understanding)\b/i,
    ],
    weight: 0.5,
  },

  // Conversation
  {
    topic: 'conversation',
    patterns: [
      /\b(we talked|we discussed|last time|previous conversation)\b/i,
      /\b(remember when|earlier you said|you mentioned)\b/i,
    ],
    weight: 0.5,
  },
];

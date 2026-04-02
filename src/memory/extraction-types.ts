import { MemoryType } from '@prisma/client';

export interface FieldConfidence {
  whoConfidence: number | null;
  whatConfidence: number | null;
  whenConfidence: number | null;
  whereConfidence: number | null;
  whyConfidence: number | null;
  howConfidence: number | null;
}

export interface LessonFields {
  lessonMistake: string | null;
  lessonRootCause: string | null;
  lessonCorrectAction: string | null;
  lessonSeverity: 'low' | 'medium' | 'high' | 'critical' | null;
  lessonSource:
    | 'user_correction'
    | 'error_detection'
    | 'self_reflection'
    | 'explicit'
    | null;
  lessonTriggerPatterns: string[];
}

export interface CapabilitySignal {
  capability: string;
  confidence: number;
}

export interface PreferenceSignal {
  category: string;
  preference: string;
  strength: 'weak' | 'moderate' | 'strong';
}

export interface ExtractionResult {
  who: string | null;
  what: string | null;
  when: string | null;
  where: string | null;
  why: string | null;
  how: string | null;
  topics: string[];
  entities: EntityWithType[];
  memoryType: MemoryType | null;
  typeConfidence: number | null;
  confidence: FieldConfidence;
  lesson: LessonFields | null;
  capabilities: CapabilitySignal[];
  preferenceSignals: PreferenceSignal[];
}

// Priority mapping for memory types
export const MEMORY_TYPE_PRIORITY: Record<MemoryType, number> = {
  CONSTRAINT: 1,
  LESSON: 1,
  PREFERENCE: 2,
  TASK: 2,
  FACT: 3,
  EVENT: 4,
  TASK_OUTCOME: 3,
  SELF_ASSESSMENT: 3,
  DECISION: 2,
  OUTCOME: 3,
  GOAL: 2,
};

export interface EntityWithType {
  name: string;
  type:
    | 'person'
    | 'organization'
    | 'project'
    | 'product'
    | 'location'
    | 'other';
}

export interface ExtractionContext {
  userName?: string;
  userId?: string;
  timestamp?: Date;
  turnIndex?: number;
  conversationId?: string;
}

export interface ExtractionResponse {
  who: string | null;
  what: string | null;
  when: string | null;
  where: string | null;
  why: string | null;
  how: string | null;
  topics: string[];
  entities: Array<{ name: string; type: string } | string>;
  memoryType: string | null;
  memorytype: string | null;
  typeConfidence: number | null;
  typeconfidence: number | null;
  who_confidence: number | null;
  what_confidence: number | null;
  when_confidence: number | null;
  where_confidence: number | null;
  why_confidence: number | null;
  how_confidence: number | null;
  lessonmistake: string | null;
  lessonrootcause: string | null;
  lessoncorrectaction: string | null;
  lessonseverity: string | null;
  lessonsource: string | null;
  lessontriggerpatterns: string[] | null;
}

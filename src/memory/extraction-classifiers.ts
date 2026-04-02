import { Logger } from '@nestjs/common';
import { MemoryLayer, MemoryType } from '@prisma/client';
import {
  EntityWithType,
  ExtractionResult,
  ExtractionResponse,
  LessonFields,
  FieldConfidence,
} from './extraction-types';

const logger = new Logger('ExtractionClassifiers');

/**
 * Classify the appropriate memory layer based on content analysis
 */
export function classifyLayer(
  raw: string,
  extracted?: ExtractionResult,
): MemoryLayer {
  // TASK patterns - check memoryType from LLM extraction first
  if (extracted?.memoryType === 'TASK') {
    logger.log('[classifyLayer] LLM-extracted memoryType is TASK → TASK layer');
    return MemoryLayer.TASK;
  }

  const taskPatterns = [
    /\b(remind me|reminder|todo|to-do|to do list)\b/i,
    /\b(remember to)\b/i,
    /\b(don't forget|do not forget)\b/i,
    /\b(follow up|follow-up|followup)\b/i,
    /\b(action item)\b/i,
    /\b(schedule|appointment)\b.*\b(for|at|on|with)\b/i,
    /\b(book)\b\s+\b(a|an|the)\b\s+\b(meeting|appointment|session|call|flight|reservation|hotel|room|table)\b/i,
  ];

  for (const pattern of taskPatterns) {
    if (pattern.test(raw)) {
      logger.log('[classifyLayer] Matched TASK pattern:', pattern.toString());
      return MemoryLayer.TASK;
    }
  }

  // IDENTITY patterns
  const identityPatterns = [
    /\b(prefer|prefers|always|never|favorite|hate|hates|love|loves)\b/i,
    /\b(born|birthday|age|years? old)\b/i,
    /\b(live|lives|from|hometown|grew up)\b/i,
    /\b(name is|called|known as|go by)\b/i,
    /\b(wife|husband|spouse|daughters?|sons?|family|mother|father|parents?|siblings?|brothers?|sisters?|child|children)\b/i,
    /\b(work at|works at|job|profession|career|employed|employer|occupation)\b/i,
    /\b(allergic|allergy|allergies|intolerant|intolerance)\b/i,
    /\b(believe|believes|religion|faith)\b/i,
    /\b(hobby|hobbies|passionate about)\b/i,
    /\b(timezone|time zone|located in)\b/i,
    /\bi (am|'m) a\b/i,
    /\bmy (name|birthday|job|wife|husband|family)\b/i,
  ];

  for (const pattern of identityPatterns) {
    if (pattern.test(raw)) {
      logger.log(
        '[classifyLayer] Matched IDENTITY pattern:',
        pattern.toString(),
      );
      return MemoryLayer.IDENTITY;
    }
  }

  // PROJECT patterns
  const projectPatterns = [
    /\b(project|projects)\b/i,
    /\b(building|developing|implementing|working on)\b/i,
    /\b(repo|repository|codebase|branch)\b/i,
    /\b(deadline|due date|milestone|sprint|release)\b/i,
    /\b(feature|bug|issue|ticket|pr|pull request)\b/i,
    /\b(deploy|deployment|production|staging)\b/i,
    /\b(client|customer|stakeholder)\s+(wants|needs|requested)/i,
    /\b(architecture|design doc|spec|specification)\b/i,
    /\b(team|teammate|collaborator)\b/i,
  ];

  for (const pattern of projectPatterns) {
    if (pattern.test(raw)) {
      logger.log(
        '[classifyLayer] Matched PROJECT pattern:',
        pattern.toString(),
      );
      return MemoryLayer.PROJECT;
    }
  }

  // Entity-based heuristics
  if (extracted?.entities) {
    const hasProjectEntity = extracted.entities.some(
      (e) => e.type === 'project' || e.type === 'organization',
    );
    if (hasProjectEntity) {
      logger.log('[classifyLayer] Entity-based classification: PROJECT');
      return MemoryLayer.PROJECT;
    }

    const personEntities = extracted.entities.filter(
      (e) => e.type === 'person',
    );
    if (personEntities.length > 0 && extracted.who) {
      if (/\b(wife|husband|daughter|son|friend|colleague)\b/i.test(raw)) {
        logger.log(
          '[classifyLayer] Relationship-based classification: IDENTITY',
        );
        return MemoryLayer.IDENTITY;
      }
    }
  }

  logger.log('[classifyLayer] Default classification: SESSION');
  return MemoryLayer.SESSION;
}

/**
 * Normalize response keys to lowercase
 */
export function normalizeResponseKeys(
  raw: Record<string, unknown>,
): ExtractionResponse {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    normalized[key.toLowerCase()] = value;
  }
  return normalized as unknown as ExtractionResponse;
}

/**
 * Normalize memory type from LLM response
 */
export function normalizeMemoryType(
  type: string | null | undefined,
): MemoryType | null {
  if (!type) return null;

  const normalized = type.toUpperCase().trim();
  const validTypes: MemoryType[] = [
    'CONSTRAINT',
    'PREFERENCE',
    'FACT',
    'TASK',
    'EVENT',
    'LESSON',
    'TASK_OUTCOME',
    'SELF_ASSESSMENT',
    'DECISION',
    'OUTCOME',
    'GOAL',
  ];

  if (validTypes.includes(normalized as MemoryType)) {
    return normalized as MemoryType;
  }

  const mappings: Record<string, MemoryType> = {
    CONSTRAINTS: 'CONSTRAINT',
    PREFERENCES: 'PREFERENCE',
    FACTS: 'FACT',
    TASKS: 'TASK',
    EVENTS: 'EVENT',
    LESSONS: 'LESSON',
    PREF: 'PREFERENCE',
    DECISIONS: 'DECISION',
    OUTCOMES: 'OUTCOME',
    GOALS: 'GOAL',
  };

  if (mappings[normalized]) {
    return mappings[normalized];
  }

  logger.warn(
    '[Extraction] Unknown memory type:',
    type,
    '-> defaulting to FACT',
  );
  return 'FACT';
}

/**
 * Normalize entities from LLM response to EntityWithType format
 */
export function normalizeEntities(
  entities: Array<{ name: string; type: string } | string> | undefined,
  userName?: string,
): EntityWithType[] {
  if (!entities || !Array.isArray(entities)) return [];

  const result: EntityWithType[] = [];

  for (const entity of entities) {
    if (typeof entity === 'string') {
      const [name, type] = entity.includes(':')
        ? entity.split(':').map((s) => s.trim())
        : [entity, 'other'];
      result.push({ name, type: validateEntityType(type) });
    } else if (entity && typeof entity === 'object' && entity.name) {
      result.push({ name: entity.name, type: validateEntityType(entity.type) });
    }
  }

  return result;
}

export function validateEntityType(type: string): EntityWithType['type'] {
  const validTypes = [
    'person',
    'organization',
    'project',
    'product',
    'location',
    'other',
  ];
  const normalized = type?.toLowerCase().trim();
  return validTypes.includes(normalized)
    ? (normalized as EntityWithType['type'])
    : 'other';
}

export function parseConfidence(
  confidence: number | null | undefined,
  fieldValue: unknown,
): number | null {
  if (fieldValue === null || fieldValue === undefined) return null;
  if (typeof confidence !== 'number') return null;
  return Math.max(0, Math.min(1, confidence));
}

export function normalizeLessonSeverity(
  severity: string | null | undefined,
): LessonFields['lessonSeverity'] {
  if (!severity) return null;
  const normalized = severity.toLowerCase().trim();
  const valid: LessonFields['lessonSeverity'][] = [
    'low',
    'medium',
    'high',
    'critical',
  ];
  return valid.includes(normalized as any)
    ? (normalized as LessonFields['lessonSeverity'])
    : 'medium';
}

export function normalizeLessonSource(
  source: string | null | undefined,
): LessonFields['lessonSource'] {
  if (!source) return null;
  const normalized = source.toLowerCase().trim().replace(/\s+/g, '_');
  const valid: LessonFields['lessonSource'][] = [
    'user_correction',
    'error_detection',
    'self_reflection',
    'explicit',
  ];
  return valid.includes(normalized as any)
    ? (normalized as LessonFields['lessonSource'])
    : 'explicit';
}

/**
 * Basic heuristic-based memory type classification (fallback when LLM unavailable)
 */
export function basicMemoryTypeClassification(raw: string): MemoryType {
  if (
    /\b(allergic|allergy|allergies|intolerant|medication|medical|deadly|fatal)\b/i.test(
      raw,
    )
  ) {
    return 'CONSTRAINT';
  }
  if (
    /\b(must not|cannot|can't|never|forbidden|prohibited)\b/i.test(raw) &&
    /\b(eat|take|use|do|have)\b/i.test(raw)
  ) {
    return 'CONSTRAINT';
  }
  if (
    /\b(that's wrong|that was wrong|you made a mistake|lesson learned|don't do that again)\b/i.test(
      raw,
    )
  ) {
    return 'LESSON';
  }
  if (
    /\b(actually|no,)\b/i.test(raw) &&
    /\b(wrong|incorrect|mistake|shouldn't have|should have)\b/i.test(raw)
  ) {
    return 'LESSON';
  }
  if (
    /\b(decided|chose|went with|opted for|selected|decision was|made the call)\b/i.test(
      raw,
    )
  ) {
    return 'DECISION';
  }
  if (
    /\b(resulted in|outcome was|turned out|succeeded|failed|consequence was|end result)\b/i.test(
      raw,
    )
  ) {
    return 'OUTCOME';
  }
  if (
    /\b(goal is|want to|plan to|aim to|objective|aspire to|target is|working toward)\b/i.test(
      raw,
    )
  ) {
    return 'GOAL';
  }
  if (
    /\b(remind|todo|task|need to|should|must|deadline|by tomorrow|by next)\b/i.test(
      raw,
    )
  ) {
    return 'TASK';
  }
  if (
    /\b(prefer|prefers|favorite|favourite|like|likes|love|loves|enjoy|enjoys|want|wants)\b/i.test(
      raw,
    )
  ) {
    return 'PREFERENCE';
  }
  if (
    /\b(always|usually|normally|every morning|every day)\b/i.test(raw) &&
    !/\b(allergic|medical|cannot)\b/i.test(raw)
  ) {
    return 'PREFERENCE';
  }
  if (
    /\b(yesterday|today|last week|recently|just now|this morning|earlier)\b/i.test(
      raw,
    )
  ) {
    return 'EVENT';
  }
  return 'FACT';
}

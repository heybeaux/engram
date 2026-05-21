import { Injectable, Logger } from '@nestjs/common';
import { LLMService } from '../llm/llm.service';
import { MemoryLayer, MemoryType } from '@prisma/client';

// Re-export all types for backward compatibility
export type {
  FieldConfidence,
  LessonFields,
  CapabilitySignal,
  PreferenceSignal,
  ExtractionResult,
  EntityWithType,
  ExtractionContext,
} from './extraction-types';
export { MEMORY_TYPE_PRIORITY } from './extraction-types';

import {
  FieldConfidence,
  LessonFields,
  ExtractionResult,
  ExtractionContext,
  MEMORY_TYPE_PRIORITY,
} from './extraction-types';
import { EXTRACTION_PROMPT_TEMPLATE } from './extraction-prompt';
import {
  classifyLayer as classifyLayerFn,
  normalizeResponseKeys,
  normalizeMemoryType,
  normalizeEntities,
  parseConfidence,
  normalizeLessonSeverity,
  normalizeLessonSource,
} from './extraction-classifiers';
import {
  extractCapabilitySignals,
  extractPreferenceSignals,
  basicExtraction,
} from './extraction-signals';

/**
 * Extracts structured 5W1H data from raw memory text
 * Uses configured LLM provider for extraction
 */
@Injectable()
export class ExtractionService {
  private readonly logger = new Logger(ExtractionService.name);
  constructor(private llm: LLMService) {}

  /**
   * Extract 5W1H structure from raw text using LLM
   */
  async extract(
    raw: string,
    context?: ExtractionContext,
  ): Promise<ExtractionResult> {
    const inputPreview = raw.length > 100 ? raw.substring(0, 100) + '...' : raw;

    this.logger.log('[Extraction] Starting extraction:', {
      inputPreview,
      inputLength: raw.length,
      userName: context?.userName,
      userId: context?.userId,
    });

    try {
      const prompt = EXTRACTION_PROMPT_TEMPLATE(
        context?.userName,
        context?.timestamp,
      );

      const rawResult = await this.llm.json<Record<string, unknown>>(
        [
          { role: 'system', content: prompt },
          { role: 'user', content: `Extract from this memory:\n\n"${raw}"` },
        ],
        undefined,
        { temperature: 0.2 },
      );

      const rawEntities = rawResult.entities ?? rawResult.ENTITIES;
      this.logger.log('[Extraction] Raw LLM response:', {
        keys: Object.keys(rawResult),
        hasUppercaseKeys: Object.keys(rawResult).some(
          (k) => k !== k.toLowerCase(),
        ),
        entityCount: Array.isArray(rawEntities) ? rawEntities.length : 0,
      });

      const result = normalizeResponseKeys(rawResult);

      const rawMemoryType = result.memoryType || result.memorytype;
      const memoryType = normalizeMemoryType(rawMemoryType);
      const typeConfidence =
        result.typeConfidence ?? result.typeconfidence ?? null;

      const confidence: FieldConfidence = {
        whoConfidence: parseConfidence(result.who_confidence, result.who),
        whatConfidence: parseConfidence(result.what_confidence, result.what),
        whenConfidence: parseConfidence(result.when_confidence, result.when),
        whereConfidence: parseConfidence(result.where_confidence, result.where),
        whyConfidence: parseConfidence(result.why_confidence, result.why),
        howConfidence: parseConfidence(result.how_confidence, result.how),
      };

      const lesson: LessonFields | null =
        memoryType === 'LESSON'
          ? {
              lessonMistake: result.lessonmistake || null,
              lessonRootCause: result.lessonrootcause || null,
              lessonCorrectAction: result.lessoncorrectaction || null,
              lessonSeverity: normalizeLessonSeverity(result.lessonseverity),
              lessonSource: normalizeLessonSource(result.lessonsource),
              lessonTriggerPatterns: Array.isArray(result.lessontriggerpatterns)
                ? result.lessontriggerpatterns
                : [],
            }
          : null;

      const capabilities = extractCapabilitySignals(raw);
      const preferenceSignals = extractPreferenceSignals(raw, memoryType);

      const extractionResult: ExtractionResult = {
        who:
          typeof result.who === 'string'
            ? result.who || null
            : Array.isArray(result.who as any)
              ? (result.who as any).join(', ') || null
              : null,
        what: typeof result.what === 'string' ? result.what || null : null,
        when: typeof result.when === 'string' ? result.when || null : null,
        where:
          typeof result.where === 'string'
            ? result.where || null
            : Array.isArray(result.where as any)
              ? (result.where as any).join(', ') || null
              : null,
        why: typeof result.why === 'string' ? result.why || null : null,
        how: typeof result.how === 'string' ? result.how || null : null,
        topics: Array.isArray(result.topics) ? result.topics : [],
        entities: normalizeEntities(result.entities, context?.userName),
        memoryType,
        typeConfidence:
          typeof typeConfidence === 'number' ? typeConfidence : null,
        confidence,
        lesson,
        capabilities,
        preferenceSignals,
      };

      this.logger.log('[Extraction] Extraction complete:', {
        who: extractionResult.who,
        what: extractionResult.what?.substring(0, 50),
        topicCount: extractionResult.topics.length,
        entityCount: extractionResult.entities.length,
        entities: extractionResult.entities.map((e) => `${e.name}:${e.type}`),
        memoryType: extractionResult.memoryType,
        typeConfidence: extractionResult.typeConfidence,
        confidence: extractionResult.confidence,
      });

      return extractionResult;
    } catch (error) {
      this.logger.error('[Extraction] LLM extraction FAILED:', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        inputPreview,
        inputLength: raw.length,
        userName: context?.userName,
        userId: context?.userId,
        timestamp: new Date().toISOString(),
      });
      this.logger.log('[Extraction] Falling back to basicExtraction');
      return basicExtraction(raw, context?.userName);
    }
  }

  /**
   * Get priority number for a memory type
   */
  getPriorityForType(type: MemoryType | null): number {
    if (!type) return 3;
    return MEMORY_TYPE_PRIORITY[type] ?? 3;
  }

  /**
   * Classify the appropriate memory layer based on content analysis
   */
  classifyLayer(raw: string, extracted?: ExtractionResult): MemoryLayer {
    return classifyLayerFn(raw, extracted);
  }
}

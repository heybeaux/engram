import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryDurability } from '@prisma/client';

/**
 * ENG-31: Rule-based durability classification.
 *
 * Classifies memory content as DURABLE or EPHEMERAL based on lexical signals.
 * No LLM calls — synchronous, deterministic, zero API cost.
 */
@Injectable()
export class DurabilityClassifierService {
  private readonly logger = new Logger(DurabilityClassifierService.name);

  /** Preference patterns — any match → DURABLE */
  private static readonly PREFERENCE_PATTERNS = [
    /\bi prefer\b/i,
    /\bi like\b/i,
    /\bi love\b/i,
    /\bi hate\b/i,
    /\bi always\b/i,
    /\bi never\b/i,
    /\bmy favou?rite\b/i,
    /\bi enjoy\b/i,
  ];

  /** Stated-fact patterns — any match → DURABLE */
  private static readonly FACT_PATTERNS = [
    /\bmy name is\b/i,
    /\bi work at\b/i,
    /\bi live in\b/i,
    /\bmy daughter\b/i,
    /\bmy son\b/i,
    /\bmy wife\b/i,
    /\bmy husband\b/i,
    /\bmy partner\b/i,
    /\bmy dog\b/i,
    /\bi was born\b/i,
    /\bmy job\b/i,
    /\bmy goal is\b/i,
    /\bi decided\b/i,
  ];

  /** Ephemeral filler patterns — only used when no DURABLE signals found */
  private static readonly EPHEMERAL_PATTERNS = [
    /\bhad a good day\b/i,
    /\bbusy week\b/i,
    /\bfeeling tired\b/i,
    /\bnot much happened\b/i,
  ];

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Classify a memory content string as DURABLE or EPHEMERAL.
   * Synchronous, rule-based — no async needed.
   */
  classify(content: string): MemoryDurability {
    if (!content || !content.trim()) {
      return MemoryDurability.EPHEMERAL;
    }

    const trimmed = content.trim();

    // Very short content → EPHEMERAL
    if (trimmed.length < 30) {
      return MemoryDurability.EPHEMERAL;
    }

    // Check DURABLE signals (any match → DURABLE)
    if (this.hasPreferenceSignal(trimmed)) return MemoryDurability.DURABLE;
    if (this.hasFactSignal(trimmed)) return MemoryDurability.DURABLE;
    if (this.hasNamedEntity(trimmed)) return MemoryDurability.DURABLE;
    if (this.hasConcreteNumber(trimmed)) return MemoryDurability.DURABLE;

    // No DURABLE signals → EPHEMERAL
    return MemoryDurability.EPHEMERAL;
  }

  /**
   * Classify a batch of memories and persist the results to the database.
   */
  async classifyBatch(
    memories: Array<{ id: string; content: string }>,
  ): Promise<void> {
    const now = new Date();

    for (const { id, content } of memories) {
      const durability = this.classify(content);
      try {
        await this.prisma.memory.update({
          where: { id },
          data: {
            durability,
            durabilityClassifiedAt: now,
          },
        });
      } catch (err) {
        this.logger.warn(
          `[Durability] Failed to classify memory ${id}: ${(err as Error).message}`,
        );
      }
    }
  }

  /** Check for preference patterns */
  private hasPreferenceSignal(content: string): boolean {
    return DurabilityClassifierService.PREFERENCE_PATTERNS.some((p) =>
      p.test(content),
    );
  }

  /** Check for stated-fact patterns */
  private hasFactSignal(content: string): boolean {
    return DurabilityClassifierService.FACT_PATTERNS.some((p) =>
      p.test(content),
    );
  }

  /**
   * Detect proper nouns (capitalised words not at the start of a sentence).
   * Simple heuristic: split into sentences, check for mid-sentence capitals.
   */
  private hasNamedEntity(content: string): boolean {
    const sentences = content
      .split(/[.!?]+/)
      .filter((s) => s.trim().length > 0);

    for (const sentence of sentences) {
      const words = sentence.trim().split(/\s+/);
      // Skip the first word (start of sentence) — check remaining words
      for (let i = 1; i < words.length; i++) {
        const word = words[i];
        // Must start with uppercase, be at least 2 chars, and not be a common word
        if (
          word.length >= 2 &&
          /^[A-Z][a-z]/.test(word) &&
          !COMMON_CAPITALIZED.has(word)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Detect concrete numbers with context (age, dates, measurements tied to a subject).
   * E.g., "I'm 32 years old", "born in 1990", "5 feet", "weighs 70 kg"
   */
  private hasConcreteNumber(content: string): boolean {
    return CONCRETE_NUMBER_PATTERN.test(content);
  }
}

/** Words that commonly appear capitalised but are not named entities */
const COMMON_CAPITALIZED = new Set([
  'I',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
  'The',
  'This',
  'That',
  'These',
  'Those',
  'My',
  'Your',
  'His',
  'Her',
  'Its',
  'Our',
  'Their',
  'But',
  'And',
  'Not',
  'Also',
]);

/** Matches numbers in context that suggest concrete factual information */
const CONCRETE_NUMBER_PATTERN =
  /\b\d+\s*(years?\s*old|kg|lbs?|pounds?|feet|ft|cm|meters?|miles?|born\s+in)\b|\bborn\s+in\s+\d{4}\b|\b(age|aged)\s+\d+\b/i;

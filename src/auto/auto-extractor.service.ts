import { Injectable, Logger } from '@nestjs/common';
import { LLMService } from '../llm/llm.service';
import {
  MessageTurnDto,
  MessageRole,
  ImportanceSignal,
  ExtractedMemory,
} from './dto/observe.dto';
import { buildFormationPromptAddendum, guardFact } from './formation-guard';

/**
 * Build extraction prompt with optional user context
 */
const buildExtractionPrompt = (userName?: string, timestamp?: Date): string => {
  const userRef = userName || 'User';
  const now = timestamp ?? new Date();
  const isoNow = now.toISOString();

  return `You are analyzing a conversation to extract memorable facts. Focus on information that would be valuable to remember for future conversations.

CURRENT TIMESTAMP: ${isoNow}
Use this to resolve relative time references ("today", "tomorrow", "yesterday", "next week") into specific dates in your extracted facts.

${userName ? `IMPORTANT: The user's name is "${userName}". Use their actual name in extracted facts, not generic terms like "User" or "the user".` : ''}

Extract facts about:
1. ${userRef}'s preferences, habits, and patterns
2. Important decisions or statements
3. Corrections or clarifications
4. Names, relationships, and personal details
5. Technical setups, tools, and workflows
6. Goals, projects, and ongoing work

For each fact, provide:
- content: A concise, standalone statement (as if remembering for later). ${userName ? `Use "${userName}" not "User".` : ''}
- turnIndex: Which turn (0-indexed) this came from

Output JSON array of extracted facts. If nothing memorable, return empty array.
Extract facts that make sense OUT OF CONTEXT - they should be useful in future sessions.

Bad: "They want dark mode"
${userName ? `Good: "${userName} prefers dark mode for all applications"` : 'Good: "User prefers dark mode for all applications"'}

Bad: "Will do it tomorrow"  
${userName ? `Good: "${userName} planned to deploy the API on ${new Date(now.getTime() + 86400000).toISOString().split('T')[0]}"` : `Good: "User planned to deploy the API on ${new Date(now.getTime() + 86400000).toISOString().split('T')[0]}"`}`;
};

interface ExtractionResponse {
  facts: Array<{
    content: string;
    turnIndex: number;
  }>;
}

export interface ExtractorContext {
  userName?: string;
  timestamp?: Date;
  agentName?: string;
}

/**
 * Extracts memorable facts from conversations using LLM
 */
@Injectable()
export class AutoExtractorService {
  private readonly logger = new Logger(AutoExtractorService.name);
  constructor(private llm: LLMService) {}

  /**
   * Extract memories from conversation turns
   * @param turns - The conversation turns to analyze
   * @param signals - Pre-detected importance signals
   * @param context - Optional context including user name for better extraction
   */
  async extract(
    turns: MessageTurnDto[],
    signals: ImportanceSignal[],
    context?: ExtractorContext,
  ): Promise<ExtractedMemory[]> {
    try {
      // Format conversation for LLM
      const conversation = this.formatConversation(turns);
      const signalHints = this.formatSignalHints(signals);
      const prompt =
        buildExtractionPrompt(context?.userName, context?.timestamp) +
        buildFormationPromptAddendum(context?.userName, context?.agentName);

      const result = await this.llm.json<ExtractionResponse>(
        [
          { role: 'system', content: prompt },
          {
            role: 'user',
            content: `Conversation:\n${conversation}\n\n${signalHints ? `High-importance signals detected:\n${signalHints}\n\n` : ''}Extract memorable facts:`,
          },
        ],
        undefined,
        { temperature: 0.3 },
      );

      // Convert to ExtractedMemory format
      const guarded = (result.facts || []).filter((f) => {
        const verdict = guardFact(
          { content: f.content, turnIndices: [f.turnIndex] },
          turns,
          context?.userName,
        );
        if (!verdict.keep) {
          this.logger.debug(`[observe] dropped fact (${verdict.reason})`);
        }
        return verdict.keep;
      });
      return this.processExtractions(
        guarded,
        turns,
        signals,
        context?.userName,
      );
    } catch (error) {
      this.logger.error(
        'LLM extraction failed, falling back to signal-based extraction:',
        error,
      );
      return this.signalBasedExtraction(turns, signals, context?.userName);
    }
  }

  /**
   * Format conversation turns for LLM input
   */
  private formatConversation(turns: MessageTurnDto[]): string {
    return turns
      .map((turn, i) => `[${i}] ${turn.role.toUpperCase()}: ${turn.content}`)
      .join('\n\n');
  }

  /**
   * Format signal hints for LLM context
   */
  private formatSignalHints(signals: ImportanceSignal[]): string {
    if (signals.length === 0) return '';

    return signals
      .map(
        (s) =>
          `- Turn ${s.turnIndex}: ${s.type} signal ("${s.trigger}") - "${s.content}"`,
      )
      .join('\n');
  }

  /**
   * Process LLM extractions into ExtractedMemory format
   */
  private processExtractions(
    facts: Array<{ content: string; turnIndex: number }>,
    turns: MessageTurnDto[],
    signals: ImportanceSignal[],
    userName?: string,
  ): ExtractedMemory[] {
    return facts.map((fact) => {
      const turnIndex = Math.min(Math.max(fact.turnIndex, 0), turns.length - 1);
      const turn = turns[turnIndex];
      const relevantSignals = signals.filter((s) => s.turnIndex === turnIndex);

      // Calculate importance based on signals
      let importance = 0.5; // Base importance for LLM-extracted facts

      // Boost for signal matches
      if (relevantSignals.length > 0) {
        const maxSignalConfidence = Math.max(
          ...relevantSignals.map((s) => s.confidence),
        );
        importance = Math.max(importance, maxSignalConfidence);
      }

      // Boost for user messages (vs assistant)
      if (turn.role === MessageRole.USER) {
        importance += 0.1;
      }

      // Ensure user name is used in content (safety net if LLM missed it)
      let content = fact.content;
      if (userName) {
        content = content
          .replace(/\bUser\b/g, userName)
          .replace(/\buser\b/g, userName)
          .replace(/\bThe user\b/g, userName)
          .replace(/\bthe user\b/g, userName);
      }

      return {
        content,
        importance: Math.min(importance, 1.0),
        signals: relevantSignals,
        source: {
          turnIndex,
          role: turn.role,
        },
      };
    });
  }

  /**
   * Fallback: Extract memories directly from signals when LLM fails
   */
  private signalBasedExtraction(
    turns: MessageTurnDto[],
    signals: ImportanceSignal[],
    userName?: string,
  ): ExtractedMemory[] {
    const memories: ExtractedMemory[] = [];
    const userRef = userName || 'User';

    for (const signal of signals) {
      const turn = turns[signal.turnIndex];
      if (!turn) continue;

      // Create memory from signal content
      let content = signal.content;

      // Replace generic "User" with actual name if provided
      if (userName) {
        content = content
          .replace(/\bUser\b/g, userName)
          .replace(/\buser\b/g, userName)
          .replace(/\bThe user\b/g, userName)
          .replace(/\bthe user\b/g, userName);
      }

      // Enhance content based on signal type
      switch (signal.type) {
        case 'preference':
          // Already in good format from pattern match
          break;
        case 'correction':
          content = `Correction: ${content}`;
          break;
        case 'explicit':
          // Content after the explicit marker
          break;
        case 'repetition':
          content = `${userRef} emphasized: ${content}`;
          break;
      }

      memories.push({
        content,
        importance: signal.confidence,
        signals: [signal],
        source: {
          turnIndex: signal.turnIndex,
          role: turn.role,
        },
      });
    }

    // Deduplicate similar memories
    return this.deduplicateMemories(memories);
  }

  /**
   * Remove duplicate or very similar memories
   */
  private deduplicateMemories(memories: ExtractedMemory[]): ExtractedMemory[] {
    const unique: ExtractedMemory[] = [];

    for (const memory of memories) {
      const isDuplicate = unique.some(
        (existing) =>
          this.similarity(
            existing.content.toLowerCase(),
            memory.content.toLowerCase(),
          ) > 0.8,
      );

      if (!isDuplicate) {
        unique.push(memory);
      }
    }

    return unique;
  }

  /**
   * Simple Jaccard similarity for deduplication
   */
  private similarity(a: string, b: string): number {
    const wordsA = new Set(a.split(/\s+/));
    const wordsB = new Set(b.split(/\s+/));

    const intersection = new Set([...wordsA].filter((x) => wordsB.has(x)));
    const union = new Set([...wordsA, ...wordsB]);

    return intersection.size / union.size;
  }
}

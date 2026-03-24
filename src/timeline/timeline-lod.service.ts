import { Injectable, Logger } from '@nestjs/common';
import { Memory } from '@prisma/client';
import { LLMService } from '../llm/llm.service';

export interface TimelineEvent {
  time?: string;
  description: string;
  significance: number;
  tags: string[];
}

export interface TimelineDecision {
  description: string;
  reasoning: string;
  decidedBy: string;
  reversible: boolean;
  relatedMemoryIds: string[];
}

export interface TimelineLodResult {
  indexText: string;
  summaryText: string;
  standardText: string;
  events: TimelineEvent[];
  decisions: TimelineDecision[];
  chapter: string;
  significance: number;
  people: string[];
  mood: string;
}

interface LlmTimelineResponse {
  chapter: string;
  indexText: string;
  summaryText: string;
  standardText: string;
  events: TimelineEvent[];
  decisions: TimelineDecision[];
  people: string[];
  mood: string;
  significance: number;
}

const SYSTEM_PROMPT = `You are a memory archivist. Given a list of memories from a single day, generate a structured timeline entry at three levels of detail (LOD).

Respond with a JSON object containing:
- chapter: A short chapter title for this day (2-5 words)
- indexText: ~30 tokens. Format: DATE: "CHAPTER TITLE" — one-line summary. [ARC]
- summaryText: ~200 tokens. A narrative paragraph covering key events, decisions, open threads, and mood.
- standardText: ~800 tokens. Full structured prose entry covering all significant events, decisions, people involved, and emotional tone.
- events: Array of { time?: string, description: string, significance: number (1-10), tags: string[] }
- decisions: Array of { description: string, reasoning: string, decidedBy: string, reversible: boolean, relatedMemoryIds: string[] }
- people: Array of names/identifiers mentioned
- mood: Overall emotional tone of the day (1-3 words)
- significance: Overall day significance (1-10)

Keep the output factual and grounded in the provided memories. Do not invent events.`;

@Injectable()
export class TimelineLodService {
  private readonly logger = new Logger(TimelineLodService.name);

  constructor(private readonly llm: LLMService) {}

  async generateLod(
    memories: Memory[],
    date: string,
  ): Promise<TimelineLodResult> {
    if (!memories.length) {
      return this.emptyResult(date);
    }

    const userPrompt = this.formatMemoriesPrompt(memories, date);

    try {
      const response = await this.llm.json<LlmTimelineResponse>(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        undefined,
        { temperature: 0.3, maxTokens: 2000 },
      );

      return this.parseResponse(response, date);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown LLM error';
      this.logger.error(
        `Failed to generate timeline LOD for ${date}: ${message}`,
      );
      throw new Error(`Timeline LOD generation failed for ${date}: ${message}`, { cause: error });
    }
  }

  private formatMemoriesPrompt(memories: Memory[], date: string): string {
    const lines = memories.map((m) => {
      const time = m.createdAt
        ? new Date(m.createdAt).toISOString().slice(11, 16)
        : '??:??';
      const tags = m.tags?.length ? ` (tags: ${m.tags.join(', ')})` : '';
      const sig = m.importanceScore != null ? m.importanceScore : '?';
      return `[${time}] ${m.raw}${tags} significance: ${sig}`;
    });

    return `Date: ${date}\n\nMemories:\n${lines.join('\n')}`;
  }

  private parseResponse(
    response: LlmTimelineResponse,
    date: string,
  ): TimelineLodResult {
    return {
      indexText: response.indexText || `${date}: "Quiet day" — no notable events. [misc]`,
      summaryText: response.summaryText || 'No significant activity recorded.',
      standardText: response.standardText || 'No detailed record available.',
      events: Array.isArray(response.events) ? response.events : [],
      decisions: Array.isArray(response.decisions) ? response.decisions : [],
      chapter: response.chapter || 'Untitled',
      significance:
        typeof response.significance === 'number'
          ? Math.max(1, Math.min(10, response.significance))
          : 1,
      people: Array.isArray(response.people) ? response.people : [],
      mood: response.mood || 'neutral',
    };
  }

  private emptyResult(date: string): TimelineLodResult {
    return {
      indexText: `${date}: "Quiet day" — no memories recorded. [idle]`,
      summaryText: 'No memories were recorded for this day.',
      standardText: 'No memories were recorded for this day. No events, decisions, or interactions to report.',
      events: [],
      decisions: [],
      chapter: 'Quiet day',
      significance: 1,
      people: [],
      mood: 'neutral',
    };
  }
}

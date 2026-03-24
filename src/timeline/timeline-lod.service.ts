import { Injectable, Logger } from '@nestjs/common';
import { LLMService } from '../llm/llm.service';

export interface TimelineLodInput {
  date: string; // "2026-03-22"
  memories: Array<{ id: string; content: string; createdAt: Date }>;
  drafts?: string[]; // TIMELINE_DRAFT content lines
}

export interface TimelineLodOutput {
  chapter: string;
  indexText: string; // ~30 tokens
  summaryText: string; // ~200 tokens
  standardText: string; // ~800 tokens
  events: Array<{
    time?: string;
    description: string;
    significance: number;
    tags: string[];
  }>;
  decisions: Array<{
    description: string;
    reasoning: string;
  }>;
  openThreads: Array<{
    description: string;
    priority: 'low' | 'medium' | 'high';
  }>;
  people: string[];
  mood: string;
  significance: number;
  llmCalls: number;
}

@Injectable()
export class TimelineLodService {
  private readonly logger = new Logger(TimelineLodService.name);

  constructor(private readonly llm: LLMService) {}

  async generate(input: TimelineLodInput): Promise<TimelineLodOutput> {
    const memoriesText = input.memories
      .map((m, i) => {
        const time = m.createdAt
          ? new Date(m.createdAt).toLocaleTimeString('en-US', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            })
          : '??:??';
        return `[${time}] ${m.content}`;
      })
      .join('\n');

    const draftsSection =
      input.drafts && input.drafts.length > 0
        ? `\n\nTimeline Drafts (agent-authored summaries):\n${input.drafts.join('\n')}`
        : '';

    const result = await this.llm.json<TimelineLodOutput>(
      [
        {
          role: 'system',
          content: `You synthesize a day's memories into a structured timeline at multiple levels of detail.
Output JSON with these fields:
- chapter: short human-readable title for the day (3-6 words)
- indexText: ~30 token one-liner for scanning weeks/months. Format: "YYYY-MM-DD: \"Chapter\" -- key facts. [arc]"
- summaryText: ~200 token paragraph capturing the full day
- standardText: ~800 token detailed narrative with events, decisions, reasoning, and open threads
- events: array of {time?, description, significance (0-1), tags[]}
- decisions: array of {description, reasoning}
- openThreads: array of {description, priority: low|medium|high}
- people: array of names mentioned
- mood: single word or short phrase for the day's energy
- significance: 0-1 overall importance of this day`,
        },
        {
          role: 'user',
          content: `Date: ${input.date}\n\nMemories from this day:\n${memoriesText}${draftsSection}`,
        },
      ],
      undefined,
      { temperature: 0.3 },
    );

    return { ...result, llmCalls: 1 };
  }
}

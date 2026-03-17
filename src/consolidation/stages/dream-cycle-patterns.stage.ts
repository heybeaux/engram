import { Injectable, Optional, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DreamPatternFoundEvent } from '../../events/event-types';
import { ServicePrismaService } from '../../prisma/service-prisma.service';
import { ConsolidationService } from '../../memory/consolidation.service';
import { LLMService } from '../../llm/llm.service';
import { ConfigService } from '@nestjs/config';

export interface PatternsStageResult {
  patternsCreated: number;
  clustersFound: number;
  llmCalls: number;
}

@Injectable()
export class DreamCyclePatternsStage {
  private readonly logger = new Logger(DreamCyclePatternsStage.name);
  private readonly patternClusterMinSize: number;

  constructor(
    private readonly prisma: ServicePrismaService,
    private readonly consolidation: ConsolidationService,
    private readonly llm: LLMService,
    private readonly config: ConfigService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {
    this.patternClusterMinSize = parseInt(
      this.config.get('DREAM_PATTERN_MIN_SIZE') ?? '3',
      10,
    );
  }

  async run(
    userId: string,
    dryRun: boolean,
    remainingLlmBudget: number,
  ): Promise<PatternsStageResult> {
    let patternsCreated = 0;
    let llmCalls = 0;

    const result = await this.consolidation.promoteRecurringPatterns(userId, {
      dryRun: true,
      minOccurrences: this.patternClusterMinSize,
      similarityThreshold: 0.65,
    });

    const clustersFound = result.clustersFound;

    if (clustersFound === 0 || remainingLlmBudget <= 0) {
      return { patternsCreated: 0, clustersFound, llmCalls: 0 };
    }

    for (const detail of result.details) {
      if (llmCalls >= remainingLlmBudget) break;

      const memories = await this.prisma.memory.findMany({
        where: {
          id: { in: [detail.canonicalId, ...detail.duplicateIds] },
          userId,
          deletedAt: null,
        },
        select: { id: true, raw: true },
      });

      if (memories.length < this.patternClusterMinSize) continue;

      const existingPattern = await this.prisma.memory.findFirst({
        where: {
          userId,
          source: 'PATTERN_DETECTED',
          deletedAt: null,
          patternSourceIds: { hasSome: memories.map((m) => m.id) },
        },
      });

      if (existingPattern) continue;

      const memoriesText = memories
        .map((m, i) => `${i + 1}. ${m.raw}`)
        .join('\n');
      try {
        const pattern = await this.llm.json<{
          summary: string;
          confidence: number;
        }>(
          [
            {
              role: 'system',
              content: `You are analyzing a cluster of related memories to extract a higher-order pattern or insight. Identify what these memories collectively reveal about the user's behavior, preferences, or situation. Write a single concise statement. Respond with JSON: { "summary": "pattern statement", "confidence": 0.0-1.0 }`,
            },
            {
              role: 'user',
              content: `Memories:\n${memoriesText}`,
            },
          ],
          undefined,
          { temperature: 0.3 },
        );
        llmCalls++;

        if (pattern.summary && pattern.confidence >= 0.6) {
          if (!dryRun) {
            await this.prisma.memory.create({
              data: {
                userId,
                raw: pattern.summary,
                layer: 'IDENTITY',
                source: 'PATTERN_DETECTED',
                memoryType: 'FACT',
                importanceScore: Math.min(0.9, 0.5 + memories.length * 0.05),
                effectiveScore: Math.min(0.9, 0.5 + memories.length * 0.05),
                confidence: pattern.confidence,
                patternSourceIds: memories.map((m) => m.id),
                lastDreamCycleAt: new Date(),
              },
            });

            const patternMemory = await this.prisma.memory.findFirst({
              where: {
                userId,
                raw: pattern.summary,
                source: 'PATTERN_DETECTED',
              },
              select: { id: true },
            });

            if (patternMemory) {
              for (const mem of memories) {
                await this.prisma.memoryChainLink
                  .create({
                    data: {
                      sourceId: mem.id,
                      targetId: patternMemory.id,
                      linkType: 'SUPPORTS',
                      confidence: pattern.confidence,
                      createdBy: 'dream-cycle',
                    },
                  })
                  .catch(() => {});
              }

              this.emitSafe(
                'dream.pattern_found',
                new DreamPatternFoundEvent(patternMemory.id, pattern.summary),
              );
            }
          }
          patternsCreated++;
        }
      } catch (err) {
        this.logger.error(
          `[DreamCycle:Patterns] Pattern extraction failed for cluster`,
          String(err),
        );
      }
    }

    return { patternsCreated, clustersFound, llmCalls };
  }

  private emitSafe(eventName: string, payload: any): void {
    try {
      this.eventEmitter?.emit(eventName, payload);
    } catch (err) {
      this.logger.error(
        `[DreamCycle:Patterns] Failed to emit ${eventName}:`,
        err,
      );
    }
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { ServicePrismaService } from '../../prisma/service-prisma.service';
import { LLMService } from '../../llm/llm.service';
import { DedupClassification } from './dedup-candidate.model';

interface ClassificationResult {
  classification: DedupClassification;
  confidence: number;
  mergedContent?: string;
  reasoning: string;
}

/**
 * Dedup Classification Service — Phase 2 of the Automated Dedup Pipeline
 *
 * Processes PENDING DedupCandidates by sending both memory contents to an LLM
 * for classification. Uses a weighted signal approach:
 *   - Semantic similarity:  70%
 *   - Entity word overlap:  20%
 *   - Source authority:     10%
 */
@Injectable()
export class DedupClassificationService {
  private readonly logger = new Logger(DedupClassificationService.name);
  private readonly BATCH_SIZE = 10;

  // Preferred cheap model; falls back to provider default if unavailable
  private readonly CLASSIFICATION_MODEL = 'claude-haiku-4-5';

  constructor(
    private readonly prisma: ServicePrismaService,
    private readonly llm: LLMService,
  ) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async processPendingCandidates(): Promise<{ processed: number; errors: number }> {
    const candidates = await this.prisma.dedupCandidate.findMany({
      where: { status: 'PENDING' },
      include: {
        memory1: {
          select: {
            id: true,
            raw: true,
            importanceScore: true,
            source: true,
            createdAt: true,
          },
        },
        memory2: {
          select: {
            id: true,
            raw: true,
            importanceScore: true,
            source: true,
            createdAt: true,
          },
        },
      },
      take: this.BATCH_SIZE,
      orderBy: { createdAt: 'asc' },
    });

    this.logger.log(
      `[DedupClassification] Classifying ${candidates.length} pending candidates`,
    );

    let processed = 0;
    let errors = 0;

    for (const candidate of candidates) {
      try {
        const result = await this.classifyPair(
          candidate.memory1.raw,
          candidate.memory2.raw,
          candidate.similarityScore,
          candidate.memory1.source,
          candidate.memory2.source,
        );

        await this.prisma.dedupCandidate.update({
          where: { id: candidate.id },
          data: {
            classification: result.classification,
            confidence: result.confidence,
            mergedContent: result.mergedContent ?? null,
            reasoning: result.reasoning,
            status: 'CLASSIFIED',
            classifiedAt: new Date(),
          },
        });

        processed++;
      } catch (err) {
        this.logger.error(
          `[DedupClassification] Failed to classify candidate ${candidate.id}: ${String(err)}`,
        );
        errors++;
      }
    }

    this.logger.log(
      `[DedupClassification] Done — ${processed} classified, ${errors} errors`,
    );
    return { processed, errors };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async classifyPair(
    content1: string,
    content2: string,
    semanticSimilarity: number,
    source1: string,
    source2: string,
  ): Promise<ClassificationResult> {
    // --- Signal computation ---

    // Entity overlap: fraction of significant words shared (proxy for named-entity overlap)
    const words1 = new Set(content1.toLowerCase().match(/\b[a-z]{4,}\b/g) ?? []);
    const words2 = new Set(content2.toLowerCase().match(/\b[a-z]{4,}\b/g) ?? []);
    const intersection = [...words1].filter((w) => words2.has(w)).length;
    const entityOverlap =
      intersection / Math.max(words1.size, words2.size, 1);

    // Source authority: explicit sources score higher
    const authorityScore = this.sourceAuthority(source1, source2);

    // Weighted composite score provided as a hint to the LLM
    const weightedScore =
      semanticSimilarity * 0.7 +
      entityOverlap * 0.2 +
      authorityScore * 0.1;

    // --- LLM prompt ---
    const prompt = `You are a memory deduplication expert. Classify the relationship between these two memory entries.

Memory 1:
"${content1}"

Memory 2:
"${content2}"

Signal scores (informational — use your judgment):
- Semantic similarity : ${(semanticSimilarity * 100).toFixed(1)}%
- Entity overlap      : ${(entityOverlap * 100).toFixed(1)}%
- Weighted score      : ${(weightedScore * 100).toFixed(1)}%

Classify as exactly one of:
- DUPLICATE    — nearly identical content, same meaning
- SUPPORTING   — one expands or supports the other
- OVERLAPPING  — partially overlapping, each has unique content
- CONFLICTING  — contradictory information
- RELATED      — related topic but clearly distinct

Respond with ONLY valid JSON (no markdown fences):
{
  "classification": "<one of the five labels above>",
  "confidence": <0.0-1.0>,
  "merged_content": "<best combined version for DUPLICATE/SUPPORTING/OVERLAPPING, else null>",
  "reasoning": "<one sentence>"
}`;

    const response = await this.llm.chat(
      [{ role: 'user', content: prompt }],
      {
        provider: 'anthropic',
        model: this.CLASSIFICATION_MODEL,
        maxTokens: 512,
        temperature: 0.2,
      },
    );

    return this.parseClassification(response.content);
  }

  /** Parse the raw LLM response into a typed ClassificationResult */
  private parseClassification(raw: string): ClassificationResult {
    // Strip optional markdown fences
    const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error(`LLM returned non-JSON response: ${raw.substring(0, 200)}`);
    }

    const parsed: {
      classification: string;
      confidence: number;
      merged_content?: string | null;
      reasoning?: string;
    } = JSON.parse(jsonMatch[0]);

    const validLabels: DedupClassification[] = [
      'DUPLICATE',
      'SUPPORTING',
      'OVERLAPPING',
      'CONFLICTING',
      'RELATED',
    ];

    const classification = parsed.classification as DedupClassification;
    if (!validLabels.includes(classification)) {
      throw new Error(`Invalid classification label: ${parsed.classification}`);
    }

    return {
      classification,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
      mergedContent: parsed.merged_content ?? undefined,
      reasoning: parsed.reasoning ?? '',
    };
  }

  /**
   * Compute a normalised source authority score [0, 1].
   * EXPLICIT_STATEMENT sources are treated as higher authority.
   */
  private sourceAuthority(source1: string, source2: string): number {
    const explicit = 'EXPLICIT_STATEMENT';
    if (source1 === explicit && source2 === explicit) return 1.0;
    if (source1 === explicit || source2 === explicit) return 0.7;
    return 0.5;
  }
}

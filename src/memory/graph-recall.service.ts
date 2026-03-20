import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GraphService } from '../graph/services/graph.service';
import { MemoryWithScore } from './memory.types';
import { Memory } from '@prisma/client';

/**
 * GraphRecallService — knowledge graph query-time traversal for relational recall.
 *
 * Extracts entity names from a query, searches the graph, and returns
 * memories attached to matched entities and their 1-hop neighbors.
 */
@Injectable()
export class GraphRecallService {
  private readonly logger = new Logger(GraphRecallService.name);
  private readonly enabled: boolean;

  /** Words that should never be extracted as entities */
  private static readonly STOP_WORDS = new Set([
    'the',
    'a',
    'an',
    'and',
    'or',
    'but',
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'being',
    'have',
    'has',
    'had',
    'do',
    'does',
    'did',
    'will',
    'would',
    'could',
    'should',
    'may',
    'might',
    'shall',
    'can',
    'i',
    'you',
    'he',
    'she',
    'it',
    'we',
    'they',
    'me',
    'him',
    'her',
    'us',
    'them',
    'my',
    'your',
    'his',
    'her',
    'its',
    'our',
    'their',
    'what',
    'which',
    'who',
    'whom',
    'this',
    'that',
    'these',
    'those',
    'am',
    'if',
    'then',
    'than',
    'so',
    'no',
    'not',
    'only',
    'very',
    'just',
    'don',
    'now',
    'how',
    'all',
    'each',
    'every',
    'both',
    'few',
    'more',
    'most',
    'some',
    'any',
    'such',
    'into',
    'with',
    'about',
    'between',
    'through',
    'during',
    'before',
    'after',
    'above',
    'below',
    'to',
    'from',
    'up',
    'down',
    'in',
    'out',
    'on',
    'off',
    'over',
    'under',
    'again',
    'further',
    'once',
    'here',
    'there',
    'when',
    'where',
    'why',
    'how',
    'of',
    'at',
    'by',
    'for',
    'tell',
    'know',
    'think',
    'like',
    'get',
    'make',
    'go',
    'see',
    'come',
    'take',
    'want',
    'look',
    'use',
    'find',
    'give',
    'say',
    'said',
    'also',
    'well',
    'back',
    'much',
    'does',
    'doing',
    'done',
  ]);

  /** Possessive pronouns that signal the next word is an entity */
  private static readonly POSSESSIVES = new Set(['my', 'our', 'his', 'her']);

  constructor(
    private readonly config: ConfigService,
    private readonly graphService: GraphService,
  ) {
    this.enabled =
      this.config.get<string>('GRAPH_RETRIEVAL_ENABLED') === 'true';
  }

  /**
   * Extract candidate entity names from a query using simple NER heuristics.
   *
   * Rules:
   * 1. Capitalized words/phrases not at sentence start
   * 2. Words preceded by possessive pronouns (my, our, his, her)
   * 3. Quoted terms
   *
   * Returns unique list, max 5 entities.
   */
  extractEntities(query: string): string[] {
    if (!query || query.trim().length < 2) return [];

    const entities = new Set<string>();

    // 1. Extract quoted terms
    const quotedPattern = /["']([^"']+)["']/g;
    let match: RegExpExecArray | null;
    while ((match = quotedPattern.exec(query)) !== null) {
      const term = match[1].trim();
      if (term.length > 0) {
        entities.add(term);
      }
    }

    // Remove quotes for further processing
    const cleaned = query.replace(/["'][^"']*["']/g, ' ');

    // Split into sentences to know sentence boundaries
    const sentences = cleaned
      .split(/[.!?]+/)
      .filter((s) => s.trim().length > 0);

    for (const sentence of sentences) {
      const words = sentence.trim().split(/\s+/);

      for (let i = 0; i < words.length; i++) {
        const word = words[i].replace(/[,;:()[\]{}]/g, '');
        if (!word) continue;

        // 2. Possessive pattern: "my dog", "our project", "his friend"
        if (
          GraphRecallService.POSSESSIVES.has(word.toLowerCase()) &&
          i + 1 < words.length
        ) {
          const nextWord = words[i + 1].replace(/[,;:()[\]{}?!.]/g, '');
          if (
            nextWord.length > 1 &&
            !GraphRecallService.STOP_WORDS.has(nextWord.toLowerCase())
          ) {
            entities.add(nextWord);
          }
          continue;
        }

        // 3. Capitalized words not at sentence start
        if (i > 0 && /^[A-Z][a-z]/.test(word)) {
          const clean = word.replace(/[?!.,;:]/g, '');
          if (
            clean.length > 1 &&
            !GraphRecallService.STOP_WORDS.has(clean.toLowerCase())
          ) {
            entities.add(clean);
          }
        }
      }
    }

    return Array.from(entities).slice(0, 5);
  }

  /**
   * Recall memories via knowledge graph traversal.
   *
   * 1. Extract entity names from query
   * 2. Search graph for matching entities
   * 3. Get memories attached to matched entities + 1-hop neighbors
   * 4. Score and deduplicate
   */
  async recallViaGraph(
    query: string,
    userId: string,
    limit: number,
  ): Promise<MemoryWithScore[]> {
    if (!this.enabled) return [];

    const entityNames = this.extractEntities(query);
    if (entityNames.length === 0) return [];

    try {
      const result = await Promise.race<MemoryWithScore[]>([
        this.doGraphRecall(entityNames, userId, limit),
        new Promise<MemoryWithScore[]>((_, reject) =>
          setTimeout(() => reject(new Error('Graph recall timeout')), 3000),
        ),
      ]);
      return result;
    } catch (error) {
      this.logger.warn(`[GraphRecall] Failed: ${(error as Error).message}`);
      return [];
    }
  }

  private async doGraphRecall(
    entityNames: string[],
    userId: string,
    limit: number,
  ): Promise<MemoryWithScore[]> {
    const memoryMap = new Map<string, { memory: Memory; entityHits: number }>();

    for (const name of entityNames) {
      const graphEntities = await this.graphService.searchEntities(
        userId,
        name,
        { limit: 3 },
      );

      for (const entity of graphEntities) {
        // Direct memories for this entity
        const memories = await this.graphService.getMemoriesForEntity(
          entity.id,
          10,
        );
        for (const mem of memories) {
          const existing = memoryMap.get(mem.id);
          if (existing) {
            existing.entityHits++;
          } else {
            memoryMap.set(mem.id, { memory: mem, entityHits: 1 });
          }
        }

        // 1-hop neighbor memories
        const related = await this.graphService.getRelatedEntities(
          entity.id,
          2,
        );
        for (const relEntity of related) {
          const relMemories = await this.graphService.getMemoriesForEntity(
            relEntity.id,
            5,
          );
          for (const mem of relMemories) {
            const existing = memoryMap.get(mem.id);
            if (existing) {
              existing.entityHits++;
            } else {
              memoryMap.set(mem.id, { memory: mem, entityHits: 1 });
            }
          }
        }
      }
    }

    // Score: base 0.7, boost by entity hits
    const scored: MemoryWithScore[] = Array.from(memoryMap.values()).map(
      ({ memory, entityHits }) => ({
        ...memory,
        extraction: null,
        score: 0.7 + (entityHits - 1) * 0.1,
        recallSource: 'graph' as const,
      }),
    );

    return scored
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, limit);
  }
}

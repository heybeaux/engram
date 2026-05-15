import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { LLMService } from '../../llm/llm.service';
import { VectorService } from '../../vector/vector.service';
import {
  GraphEntity,
  GraphEntityType,
  GraphRelationshipType,
  GraphMentionRole,
  Memory,
} from '@prisma/client';
import { EntityService } from './entity.service';
import { RelationshipService } from './relationship.service';
import {
  ExtractedEntity,
  ExtractedRelationship,
  ExtractionResult,
  MemoryProcessingResult,
} from '../dto/extraction.dto';

/**
 * Entity extraction prompt template
 */
const ENTITY_EXTRACTION_PROMPT = `Extract all named entities from the following text. For each entity, provide:
- name: The canonical name of the entity (proper capitalization)
- type: One of PERSON, PLACE, ORGANIZATION, CONCEPT, EVENT, OBJECT, TIME, UNKNOWN
- aliases: Any alternative names or references used in the text
- role: Whether the entity is the SUBJECT, OBJECT, REFERENCE, or LOCATION

Text: "{content}"

Respond ONLY with a valid JSON array, no other text:
[
  {
    "name": "Entity Name",
    "type": "PERSON",
    "aliases": ["alias1"],
    "role": "SUBJECT"
  }
]

Rules:
- Use proper capitalization for names
- Merge obvious duplicates (e.g., "Deanna" and "my wife Deanna" → single entity with alias)
- Only include clearly identifiable entities
- For pronouns, only include if the referent is clear from context
- Minimum confidence: only include entities you're confident about`;

/**
 * Relationship extraction prompt template
 */
const RELATIONSHIP_EXTRACTION_PROMPT = `Given these entities extracted from text, identify relationships between them.

Entities:
{entities}

Text: "{content}"

For each relationship, provide:
- source: The name of the source entity (must match an entity name above)
- target: The name of the target entity (must match an entity name above)
- type: One of the relationship types below
- confidence: 0.0-1.0 how confident you are
- properties: Any additional properties as key-value pairs (optional)

Relationship Types:
SPOUSE_OF, PARENT_OF, CHILD_OF, SIBLING_OF, FRIEND_OF, COLLEAGUE_OF,
LIVES_IN, WORKS_AT, LOCATED_IN, BORN_IN,
OWNS, MEMBER_OF, PART_OF, INSTANCE_OF,
HAPPENED_BEFORE, HAPPENED_AFTER, HAPPENED_DURING,
HAS_ATTRIBUTE, CAUSED_BY, RESULTS_IN,
RELATED_TO, CUSTOM

Respond ONLY with a valid JSON array, no other text:
[
  {
    "source": "Entity Name",
    "target": "Other Entity",
    "type": "RELATIONSHIP_TYPE",
    "confidence": 0.9,
    "properties": {}
  }
]

Rules:
- Only extract relationships explicitly stated or strongly implied in the text
- Both source and target must be from the entities list
- No self-referential relationships (source cannot equal target)
- Confidence should reflect certainty from the text`;

/**
 * Entity namespace in vector store
 */
const ENTITY_NAMESPACE = 'entities';

/**
 * GraphExtractionService - LLM-based entity and relationship extraction
 *
 * Processes memory content to extract entities and relationships,
 * performing entity resolution and storing results in the graph.
 */
@Injectable()
export class GraphExtractionService {
  private readonly logger = new Logger(GraphExtractionService.name);
  private readonly enabled: boolean;
  private readonly extractionTimeoutMs: number;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly llm: LLMService,
    private readonly vector: VectorService,
    private readonly entityService: EntityService,
    private readonly relationshipService: RelationshipService,
  ) {
    this.enabled = this.config.get<string>('GRAPH_ENABLED') === 'true';
    this.extractionTimeoutMs =
      this.config.get<number>('GRAPH_EXTRACTION_TIMEOUT_MS') || 30000;

    if (this.enabled) {
      this.logger.log('Graph extraction service enabled');
    }
  }

  /**
   * Check if graph extraction is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Extract entities and relationships from text
   */
  async extract(content: string): Promise<ExtractionResult> {
    const startTime = Date.now();

    try {
      // Extract entities
      const entities = await this.extractEntities(content);

      // Extract relationships (only if we have 2+ entities)
      let relationships: ExtractedRelationship[] = [];
      if (entities.length >= 2) {
        relationships = await this.extractRelationships(content, entities);
      }

      return {
        entities,
        relationships,
        processingTimeMs: Date.now() - startTime,
      };
    } catch (error) {
      this.logger.error(`Extraction failed: ${error.message}`, error.stack);
      return {
        entities: [],
        relationships: [],
        processingTimeMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Extract entities from content using LLM
   */
  private async extractEntities(content: string): Promise<ExtractedEntity[]> {
    const prompt = ENTITY_EXTRACTION_PROMPT.replace('{content}', content);

    try {
      const response = await this.llm.chat(
        [{ role: 'user', content: prompt }],
        {
          temperature: 0,
          maxTokens: 1024,
        },
      );

      // Strip thinking tags (qwen3, deepseek-r1, etc.)
      const cleaned = response.content
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .trim();
      const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        this.logger.warn('No JSON array found in entity extraction response');
        return [];
      }

      // Try parsing; if it fails, attempt to fix common LLM JSON issues
      let parsed: Array<{
        name: string;
        type: string;
        aliases?: string[];
        role?: string;
      }>;
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        // Try fixing trailing commas, single quotes, etc.
        const fixedJson = jsonMatch[0]
          .replace(/,\s*([}\]])/g, '$1') // trailing commas
          .replace(/(['"])?(\w+)(['"])?\s*:/g, '"$2":') // unquoted keys
          .replace(/:\s*'([^']*)'/g, ': "$1"'); // single-quoted values
        parsed = JSON.parse(fixedJson);
      }

      return parsed.map((e) => ({
        name: e.name,
        type: this.parseEntityType(e.type),
        aliases: e.aliases || [],
        role: this.parseMentionRole(e.role),
      }));
    } catch (error) {
      this.logger.error(`Entity extraction failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Extract relationships from content using LLM
   */
  private async extractRelationships(
    content: string,
    entities: ExtractedEntity[],
  ): Promise<ExtractedRelationship[]> {
    const entityList = entities
      .map((e) => `- ${e.name} (${e.type})`)
      .join('\n');
    const prompt = RELATIONSHIP_EXTRACTION_PROMPT.replace(
      '{entities}',
      entityList,
    ).replace('{content}', content);

    try {
      const response = await this.llm.chat(
        [{ role: 'user', content: prompt }],
        {
          temperature: 0,
          maxTokens: 1024,
        },
      );

      // Strip thinking tags (qwen3, deepseek-r1, etc.)
      const cleaned = response.content
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .trim();
      const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        this.logger.warn(
          'No JSON array found in relationship extraction response',
        );
        return [];
      }

      let parsed: Array<{
        source: string;
        target: string;
        type: string;
        confidence?: number;
        properties?: Record<string, any>;
      }>;
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        const fixedJson = jsonMatch[0]
          .replace(/,\s*([}\]])/g, '$1')
          .replace(/(['"])?(\w+)(['"])?\s*:/g, '"$2":')
          .replace(/:\s*'([^']*)'/g, ': "$1"');
        parsed = JSON.parse(fixedJson);
      }

      // Validate that source and target exist in entities
      const entityNames = new Set(entities.map((e) => e.name.toLowerCase()));

      return parsed
        .filter((r) => {
          const sourceExists = entityNames.has(r.source.toLowerCase());
          const targetExists = entityNames.has(r.target.toLowerCase());
          if (!sourceExists || !targetExists) {
            this.logger.debug(
              `Skipping relationship: ${r.source} -> ${r.target} (entity not found)`,
            );
          }
          return sourceExists && targetExists && r.source !== r.target;
        })
        .map((r) => ({
          source: r.source,
          target: r.target,
          type: this.parseRelationshipType(r.type),
          confidence: r.confidence ?? 0.8,
          properties: r.properties || {},
        }));
    } catch (error) {
      this.logger.error(`Relationship extraction failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Process a memory: extract entities/relationships and update the graph
   */
  async processMemory(memory: Memory): Promise<MemoryProcessingResult> {
    const startTime = Date.now();
    const result: MemoryProcessingResult = {
      memoryId: memory.id,
      entitiesCreated: 0,
      entitiesUpdated: 0,
      relationshipsCreated: 0,
      relationshipsUpdated: 0,
      mentionsCreated: 0,
      processingTimeMs: 0,
    };

    if (!this.enabled) {
      this.logger.debug(
        'Graph extraction disabled, skipping memory processing',
      );
      return result;
    }

    try {
      // Extract entities and relationships
      const extraction = await this.extract(memory.raw);

      if (extraction.entities.length === 0) {
        this.logger.debug(`No entities extracted from memory ${memory.id}`);
        result.processingTimeMs = Date.now() - startTime;
        return result;
      }

      // Resolve entities (create or update existing)
      const resolvedEntities = new Map<string, GraphEntity>();

      for (const extracted of extraction.entities) {
        const resolved = await this.resolveEntity(
          memory.userId,
          extracted,
          memory.id,
        );
        resolvedEntities.set(extracted.name.toLowerCase(), resolved.entity);

        if (resolved.created) {
          result.entitiesCreated++;
        } else {
          result.entitiesUpdated++;
        }

        // Create mention
        await this.createMention(
          resolved.entity.id,
          memory.id,
          memory.userId,
          extracted.role,
        );
        result.mentionsCreated++;
      }

      // Create/update relationships
      for (const rel of extraction.relationships) {
        const sourceEntity = resolvedEntities.get(rel.source.toLowerCase());
        const targetEntity = resolvedEntities.get(rel.target.toLowerCase());

        if (!sourceEntity || !targetEntity) {
          continue;
        }

        const { created } = await this.relationshipService.upsert({
          userId: memory.userId,
          sourceEntityId: sourceEntity.id,
          targetEntityId: targetEntity.id,
          type: rel.type,
          weight: rel.confidence,
          properties: rel.properties,
          sourceMemoryIds: [memory.id],
        });

        if (created) {
          result.relationshipsCreated++;
        } else {
          result.relationshipsUpdated++;
        }
      }

      result.processingTimeMs = Date.now() - startTime;
      this.logger.log(
        `Processed memory ${memory.id}: ${result.entitiesCreated} entities, ` +
          `${result.relationshipsCreated} relationships in ${result.processingTimeMs}ms`,
      );

      return result;
    } catch (error) {
      this.logger.error(
        `Failed to process memory ${memory.id}: ${error.message}`,
      );
      result.processingTimeMs = Date.now() - startTime;
      return result;
    }
  }

  /**
   * Resolve an extracted entity to an existing or new graph entity
   */
  private async resolveEntity(
    userId: string,
    extracted: ExtractedEntity,
    memoryId: string,
  ): Promise<{ entity: GraphEntity; created: boolean }> {
    // 1. Try exact name match
    let entity = await this.entityService.findByName(
      userId,
      extracted.name,
      extracted.type,
    );
    if (entity) {
      // Add any new aliases
      if (extracted.aliases.length > 0) {
        await this.entityService.addAliases(entity.id, extracted.aliases);
      }
      await this.entityService.incrementMentionCount(entity.id);
      return { entity, created: false };
    }

    // 2. Try alias match
    entity = await this.entityService.findByAlias(
      userId,
      extracted.name,
      extracted.type,
    );
    if (entity) {
      await this.entityService.incrementMentionCount(entity.id);
      return { entity, created: false };
    }

    // 3. Try fuzzy/semantic match using similarity heuristics
    const candidates = await this.findSimilarEntities(
      userId,
      extracted.name,
      extracted.type,
    );
    for (const candidate of candidates) {
      if (this.isSimilarName(candidate.name, extracted.name)) {
        // Add as alias
        await this.entityService.addAliases(candidate.id, [extracted.name]);
        await this.entityService.incrementMentionCount(candidate.id);
        return { entity: candidate, created: false };
      }
    }

    // 4. Create new entity — GIN-43: guard against a concurrent writer that
    //    races between the findByName check above and the create below.
    //    If another task (same user, same entity name+type) wins the race and
    //    commits first we will receive a unique constraint violation (P2002).
    //    In that case we re-fetch the row the other writer created and treat
    //    it as "not created by us" (created: false).
    try {
      entity = await this.entityService.create({
        userId,
        name: extracted.name,
        type: extracted.type,
        aliases: extracted.aliases.map((a) => a.toLowerCase()),
        firstSeenMemoryId: memoryId,
      });
    } catch (err: any) {
      if (err?.code === 'P2002') {
        // Another concurrent writer already inserted this entity — fetch it.
        const raced = await this.entityService.findByName(
          userId,
          extracted.name,
          extracted.type,
        );
        if (raced) {
          await this.entityService.incrementMentionCount(raced.id);
          return { entity: raced, created: false };
        }
      }
      throw err;
    }

    // 5. Create embedding for new entity
    await this.createEntityEmbedding(entity);

    return { entity, created: true };
  }

  /**
   * Create an entity mention linking entity to memory
   */
  private async createMention(
    entityId: string,
    memoryId: string,
    userId: string,
    role: GraphMentionRole,
  ): Promise<void> {
    try {
      await this.prisma.graphEntityMention.upsert({
        where: {
          entityId_memoryId: { entityId, memoryId },
        },
        create: {
          entityId,
          memoryId,
          userId,
          role,
        },
        update: {
          role,
        },
      });
    } catch (error) {
      this.logger.warn(`Failed to create mention: ${error.message}`);
    }
  }

  /**
   * Find entities similar to a name (for resolution)
   */
  private async findSimilarEntities(
    userId: string,
    name: string,
    type: GraphEntityType,
  ): Promise<GraphEntity[]> {
    // Simple approach: find entities with similar names
    return this.prisma.graphEntity.findMany({
      where: {
        userId,
        type,
        OR: [
          { name: { contains: name.split(' ')[0], mode: 'insensitive' } },
          { aliases: { hasSome: [name.toLowerCase()] } },
        ],
      },
      take: 5,
    });
  }

  /**
   * Check if two names are similar enough to be the same entity
   */
  private isSimilarName(name1: string, name2: string): boolean {
    const n1 = name1.toLowerCase().trim();
    const n2 = name2.toLowerCase().trim();

    // Exact match
    if (n1 === n2) return true;

    // One is substring of other
    if (n1.includes(n2) || n2.includes(n1)) return true;

    // Compare first word (for "John" vs "John Smith")
    const first1 = n1.split(/\s+/)[0];
    const first2 = n2.split(/\s+/)[0];
    if (first1 === first2 && first1.length > 2) return true;

    // Levenshtein distance for short names
    if (n1.length <= 10 && n2.length <= 10) {
      const distance = this.levenshtein(n1, n2);
      if (distance <= 2) return true;
    }

    return false;
  }

  /**
   * Levenshtein distance for fuzzy matching
   */
  private levenshtein(a: string, b: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1,
          );
        }
      }
    }

    return matrix[b.length][a.length];
  }

  /**
   * Create embedding for an entity and store in vector database
   */
  private async createEntityEmbedding(entity: GraphEntity): Promise<void> {
    try {
      // Generate embedding text from entity
      const embeddingText = this.generateEmbeddingText(entity);
      const embeddingResponse = await this.llm.embed(embeddingText);

      // Store in vector database with entity namespace metadata
      await this.vector.upsert({
        id: `entity:${entity.id}`,
        embedding: embeddingResponse.embedding,
        metadata: {
          userId: entity.userId,
          entityId: entity.id,
          name: entity.name,
          type: entity.type,
          namespace: ENTITY_NAMESPACE,
        },
      });

      // Update entity with embedding ID
      await this.entityService.setEmbeddingId(entity.id, `entity:${entity.id}`);

      this.logger.debug(`Created embedding for entity: ${entity.name}`);
    } catch (error) {
      this.logger.warn(`Failed to create entity embedding: ${error.message}`);
    }
  }

  /**
   * Generate text for entity embedding
   */
  private generateEmbeddingText(entity: GraphEntity): string {
    const parts = [
      entity.name,
      entity.type.toLowerCase(),
      entity.description || '',
      ...entity.aliases,
    ];
    return parts.filter(Boolean).join(' | ');
  }

  /**
   * Parse entity type string to enum
   */
  private parseEntityType(type: string): GraphEntityType {
    const normalized = type.toUpperCase();
    if (
      Object.values(GraphEntityType).includes(normalized as GraphEntityType)
    ) {
      return normalized as GraphEntityType;
    }
    return GraphEntityType.UNKNOWN;
  }

  /**
   * Parse relationship type string to enum
   */
  private parseRelationshipType(type: string): GraphRelationshipType {
    const normalized = type.toUpperCase();
    if (
      Object.values(GraphRelationshipType).includes(
        normalized as GraphRelationshipType,
      )
    ) {
      return normalized as GraphRelationshipType;
    }
    return GraphRelationshipType.RELATED_TO;
  }

  /**
   * Parse mention role string to enum
   */
  private parseMentionRole(role?: string): GraphMentionRole {
    if (!role) return GraphMentionRole.REFERENCE;
    const normalized = role.toUpperCase();
    if (
      Object.values(GraphMentionRole).includes(normalized as GraphMentionRole)
    ) {
      return normalized as GraphMentionRole;
    }
    return GraphMentionRole.REFERENCE;
  }
}

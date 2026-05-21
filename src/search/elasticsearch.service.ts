import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@elastic/elasticsearch';

export interface EsMemoryDocument {
  id: string;
  content: string;
  userId: string;
  agentId?: string;
  accountId?: string;
  type?: string;
  layer?: string;
  source?: string;
  tags?: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface EsSearchFilters {
  userId?: string | string[];
  agentId?: string;
  accountId?: string;
  type?: string;
  layer?: string | string[];
  source?: string;
  tags?: string[];
  poolIds?: string[];
}

const INDEX_MAPPING: Record<string, any> = {
  settings: {
    number_of_shards: 1,
    number_of_replicas: 0,
    analysis: {
      analyzer: {
        english: {
          type: 'english',
        },
      },
    },
  },
  mappings: {
    dynamic: false,
    properties: {
      id: { type: 'keyword' },
      content: { type: 'text', analyzer: 'english' },
      userId: { type: 'keyword' },
      agentId: { type: 'keyword' },
      accountId: { type: 'keyword' },
      type: { type: 'keyword' },
      layer: { type: 'keyword' },
      source: { type: 'keyword' },
      tags: { type: 'keyword' },
      createdAt: { type: 'date' },
      updatedAt: { type: 'date' },
    },
  },
};

@Injectable()
export class ElasticsearchService implements OnModuleInit {
  private readonly logger = new Logger(ElasticsearchService.name);
  private client: Client;
  private enabled = false;

  constructor(private readonly configService: ConfigService) {
    const url = this.configService.get<string>('ELASTICSEARCH_URL');
    const apiKey = this.configService.get<string>('ELASTICSEARCH_API_KEY');
    const username = this.configService.get<string>('ELASTICSEARCH_USERNAME');
    const password = this.configService.get<string>('ELASTICSEARCH_PASSWORD');

    const auth = apiKey
      ? { apiKey }
      : username && password
        ? { username, password }
        : undefined;

    this.client = new Client({
      node: url || 'http://localhost:9200',
      ...(auth ? { auth } : {}),
    });
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async onModuleInit(): Promise<void> {
    const url = this.configService.get<string>('ELASTICSEARCH_URL');
    if (!url) {
      this.logger.warn(
        '[ES] ELASTICSEARCH_URL not set — keyword search disabled, falling back to tsvector',
      );
      return;
    }

    try {
      const health = await this.client.cluster.health();
      this.logger.log(`[ES] Connected — cluster status: ${health.status}`);
    } catch (err) {
      this.logger.warn(
        `[ES] Cluster unreachable at ${url}: ${(err as Error).message} — keyword search disabled`,
      );
      return;
    }

    await this.ensureIndexTemplate();
    this.enabled = true;
    this.logger.log('[ES] Initialization complete');
  }

  private async ensureIndexTemplate(): Promise<void> {
    const templateName = 'engram_memories_template';
    try {
      const exists = await this.client.indices.existsIndexTemplate({
        name: templateName,
      });
      if (exists) {
        this.logger.debug('[ES] Index template already exists, skipping');
        return;
      }

      await this.client.indices.putIndexTemplate({
        name: templateName,
        body: {
          index_patterns: ['engram_memories_*'],
          template: INDEX_MAPPING,
        },
      });
      this.logger.log('[ES] Created index template engram_memories_template');
    } catch (err) {
      this.logger.warn(
        `[ES] Failed to ensure index template: ${(err as Error).message}`,
      );
    }
  }

  private indexName(accountId?: string): string {
    if (accountId) {
      const safe = accountId.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
      return `engram_memories_${safe}`;
    }
    return 'engram_memories_default';
  }

  async indexMemory(memory: EsMemoryDocument): Promise<void> {
    if (!this.enabled) return;
    const index = this.indexName(memory.accountId);
    await this.client.index({
      index,
      id: memory.id,
      document: {
        id: memory.id,
        content: memory.content,
        userId: memory.userId,
        agentId: memory.agentId ?? null,
        accountId: memory.accountId ?? null,
        type: memory.type ?? null,
        layer: memory.layer ?? null,
        source: memory.source ?? null,
        tags: memory.tags ?? [],
        createdAt: memory.createdAt,
        updatedAt: memory.updatedAt,
      },
    });
  }

  async deleteMemory(id: string, accountId?: string): Promise<void> {
    if (!this.enabled) return;
    const index = this.indexName(accountId);
    try {
      await this.client.delete({ index, id });
    } catch (err: any) {
      if (err?.meta?.statusCode === 404) {
        return;
      }
      throw err;
    }
  }

  async keywordSearch(
    query: string,
    filters: EsSearchFilters,
    limit: number,
  ): Promise<Array<{ id: string; score: number }>> {
    if (!this.enabled) return [];
    const index = this.indexName(filters.accountId);

    const filterClauses: any[] = [];

    const userIds = filters.userId
      ? Array.isArray(filters.userId)
        ? filters.userId
        : [filters.userId]
      : [];

    if (userIds.length > 0 && !filters.poolIds?.length) {
      filterClauses.push({ terms: { userId: userIds } });
    }

    if (filters.agentId) {
      filterClauses.push({ term: { agentId: filters.agentId } });
    }

    if (filters.layer) {
      const layers = Array.isArray(filters.layer)
        ? filters.layer
        : [filters.layer];
      filterClauses.push({ terms: { layer: layers } });
    }

    if (filters.type) {
      filterClauses.push({ term: { type: filters.type } });
    }

    if (filters.source) {
      filterClauses.push({ term: { source: filters.source } });
    }

    if (filters.tags?.length) {
      filterClauses.push({ terms: { tags: filters.tags } });
    }

    const esQuery: any = {
      bool: {
        must: {
          multi_match: {
            query,
            fields: ['content^3', 'tags^1'],
            type: 'best_fields',
            fuzziness: 'AUTO',
          },
        },
        ...(filterClauses.length > 0 ? { filter: filterClauses } : {}),
      },
    };

    const response = await this.client.search({
      index,
      size: limit,
      query: esQuery,
    });

    const hits = response.hits.hits;
    if (hits.length === 0) return [];

    const maxScore = hits[0]._score ?? 1;

    return hits
      .filter((hit) => hit._id != null)
      .map((hit) => ({
        id: hit._id as string,
        score: maxScore > 0 ? (hit._score ?? 0) / maxScore : 0,
      }));
  }
}

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ElasticsearchService, EsMemoryDocument } from './elasticsearch.service';

const mockIndices = {
  existsIndexTemplate: jest.fn(),
  putIndexTemplate: jest.fn(),
  exists: jest.fn(),
  create: jest.fn(),
};

const mockClient = {
  cluster: {
    health: jest.fn(),
  },
  indices: mockIndices,
  index: jest.fn(),
  delete: jest.fn(),
  search: jest.fn(),
};

jest.mock('@elastic/elasticsearch', () => ({
  Client: jest.fn().mockImplementation(() => mockClient),
}));

describe('ElasticsearchService', () => {
  let service: ElasticsearchService;
  let configService: ConfigService;

  beforeEach(async () => {
    jest.clearAllMocks();

    mockClient.cluster.health.mockResolvedValue({ status: 'green' });
    mockIndices.existsIndexTemplate.mockResolvedValue(false);
    mockIndices.putIndexTemplate.mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ElasticsearchService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultVal?: string) => {
              const env: Record<string, string> = {
                ELASTICSEARCH_URL: 'http://localhost:9200',
              };
              return env[key] ?? defaultVal;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<ElasticsearchService>(ElasticsearchService);
    configService = module.get<ConfigService>(ConfigService);
  });

  describe('onModuleInit', () => {
    it('throws when ELASTICSEARCH_URL is not set', async () => {
      jest
        .spyOn(configService, 'get')
        .mockImplementation((key: string) =>
          key === 'ELASTICSEARCH_URL' ? undefined : undefined,
        );
      await expect(service.onModuleInit()).rejects.toThrow(
        'ELASTICSEARCH_URL is required',
      );
    });

    it('throws when cluster is unreachable', async () => {
      mockClient.cluster.health.mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(service.onModuleInit()).rejects.toThrow(
        'Cluster unreachable',
      );
    });

    it('creates index template when it does not exist', async () => {
      mockIndices.existsIndexTemplate.mockResolvedValue(false);
      await service.onModuleInit();
      expect(mockIndices.putIndexTemplate).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'engram_memories_template' }),
      );
    });

    it('skips index template creation when it already exists', async () => {
      mockIndices.existsIndexTemplate.mockResolvedValue(true);
      await service.onModuleInit();
      expect(mockIndices.putIndexTemplate).not.toHaveBeenCalled();
    });
  });

  describe('indexMemory', () => {
    it('calls client.index with correct document shape', async () => {
      mockClient.index.mockResolvedValue({ result: 'created' });
      const memory: EsMemoryDocument = {
        id: 'mem-1',
        content: 'Test memory content',
        userId: 'user-1',
        agentId: 'agent-1',
        accountId: 'account-1',
        layer: 'SESSION',
        source: 'EXPLICIT_STATEMENT',
        tags: ['tag1', 'tag2'],
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
      };

      await service.indexMemory(memory);

      expect(mockClient.index).toHaveBeenCalledWith(
        expect.objectContaining({
          index: 'engram_memories_account-1',
          id: 'mem-1',
          document: expect.objectContaining({
            id: 'mem-1',
            content: 'Test memory content',
            userId: 'user-1',
            agentId: 'agent-1',
            accountId: 'account-1',
            layer: 'SESSION',
            tags: ['tag1', 'tag2'],
          }),
        }),
      );
    });

    it('uses default index when accountId is absent', async () => {
      mockClient.index.mockResolvedValue({ result: 'created' });
      const memory: EsMemoryDocument = {
        id: 'mem-2',
        content: 'No account',
        userId: 'user-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await service.indexMemory(memory);

      expect(mockClient.index).toHaveBeenCalledWith(
        expect.objectContaining({ index: 'engram_memories_default' }),
      );
    });
  });

  describe('deleteMemory', () => {
    it('calls client.delete with correct id', async () => {
      mockClient.delete.mockResolvedValue({ result: 'deleted' });

      await service.deleteMemory('mem-1', 'account-1');

      expect(mockClient.delete).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'mem-1' }),
      );
    });

    it('ignores 404 responses', async () => {
      const err: any = new Error('Not found');
      err.meta = { statusCode: 404 };
      mockClient.delete.mockRejectedValue(err);

      await expect(service.deleteMemory('mem-999')).resolves.toBeUndefined();
    });
  });

  describe('keywordSearch', () => {
    it('returns ranked results normalized by max score', async () => {
      mockClient.search.mockResolvedValue({
        hits: {
          hits: [
            { _id: 'id-1', _score: 2.0 },
            { _id: 'id-2', _score: 1.0 },
            { _id: 'id-3', _score: 0.5 },
          ],
        },
      });

      const results = await service.keywordSearch(
        'test query',
        { userId: 'user-1', accountId: 'acc-1' },
        10,
      );

      expect(results).toHaveLength(3);
      expect(results[0]).toEqual({ id: 'id-1', score: 1.0 });
      expect(results[1]).toEqual({ id: 'id-2', score: 0.5 });
      expect(results[2]).toEqual({ id: 'id-3', score: 0.25 });
    });

    it('returns empty array when no hits', async () => {
      mockClient.search.mockResolvedValue({ hits: { hits: [] } });

      const results = await service.keywordSearch('query', { userId: 'u1' }, 10);

      expect(results).toEqual([]);
    });

    it('applies layer filter when provided', async () => {
      mockClient.search.mockResolvedValue({ hits: { hits: [] } });

      await service.keywordSearch(
        'test',
        { userId: 'user-1', layer: ['SESSION', 'CORE'] },
        10,
      );

      const callArgs = mockClient.search.mock.calls[0][0];
      const filterClauses = callArgs.query.bool.filter;
      const layerFilter = filterClauses.find((f: any) => f.terms?.layer);
      expect(layerFilter).toBeDefined();
      expect(layerFilter.terms.layer).toEqual(['SESSION', 'CORE']);
    });
  });
});

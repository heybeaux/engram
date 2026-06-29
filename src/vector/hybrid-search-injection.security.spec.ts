/**
 * GIN-42: SQL Injection Prevention Tests for HybridSearchService
 *
 * HybridSearchService now delegates keyword search to ElasticsearchService
 * rather than constructing raw SQL. These tests verify that user-controlled
 * values are passed as structured arguments to the search adapter, not
 * interpolated into SQL, and that the adapter-facing limit is normalized.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HybridSearchService } from './hybrid-search.service';
import { PrismaService } from '../prisma/prisma.service';
import { ElasticsearchService } from '../search/elasticsearch.service';

describe('HybridSearchService — SQL injection prevention (GIN-42)', () => {
  let service: HybridSearchService;
  let prisma: jest.Mocked<PrismaService>;
  let elasticsearch: { keywordSearch: jest.Mock };

  beforeEach(async () => {
    elasticsearch = {
      keywordSearch: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HybridSearchService,
        {
          provide: PrismaService,
          useValue: {
            $queryRawUnsafe: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string, def: string) => def),
          },
        },
        { provide: ElasticsearchService, useValue: elasticsearch },
      ],
    }).compile();

    service = module.get<HybridSearchService>(HybridSearchService);
    prisma = module.get(PrismaService);
  });

  // ---------------------------------------------------------------------------
  // LIMIT clause integrity
  // ---------------------------------------------------------------------------
  describe('limit sanitization', () => {
    it('passes a plain integer limit for a normal limit', async () => {
      await service.textSearch('test query', {
        userId: 'user-1',
        limit: 10,
      });

      expect(elasticsearch.keywordSearch).toHaveBeenCalledWith(
        'test query',
        expect.any(Object),
        10,
      );
    });

    it('clamps fractional limit to an integer (Math.trunc)', async () => {
      await service.textSearch('test query', {
        userId: 'user-1',
        limit: 9.99,
      });

      expect(elasticsearch.keywordSearch).toHaveBeenCalledWith(
        'test query',
        expect.any(Object),
        9,
      );
    });

    it('does not allow negative limit — clamped to minimum of 1', async () => {
      await service.textSearch('test query', {
        userId: 'user-1',
        limit: -5,
      });

      expect(elasticsearch.keywordSearch).toHaveBeenCalledWith(
        'test query',
        expect.any(Object),
        1,
      );
    });

    it('does not allow zero limit — clamped to minimum of 1', async () => {
      await service.textSearch('test query', {
        userId: 'user-1',
        limit: 0,
      });

      expect(elasticsearch.keywordSearch).toHaveBeenCalledWith(
        'test query',
        expect.any(Object),
        1,
      );
    });

    it('does not pass non-finite limits to the search adapter', async () => {
      await service.textSearch('test query', {
        userId: 'user-1',
        limit: Number.POSITIVE_INFINITY,
      });

      expect(elasticsearch.keywordSearch).toHaveBeenCalledWith(
        'test query',
        expect.any(Object),
        50,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Query text is passed as data to Elasticsearch, never interpolated into SQL
  // ---------------------------------------------------------------------------
  describe('query text parameterization', () => {
    const injectionPayloads = [
      "'; DROP TABLE memories; --",
      "' OR 1=1 --",
      "'; SELECT * FROM users --",
      "') OR ('1'='1",
      "'; EXEC xp_cmdshell('id'); --",
    ];

    it.each(injectionPayloads)(
      'passes injection string %j as an adapter argument, not SQL',
      async (payload) => {
        await service.textSearch(payload, {
          userId: 'user-1',
          limit: 10,
        });

        expect(elasticsearch.keywordSearch).toHaveBeenCalledWith(
          payload,
          expect.objectContaining({ userId: ['user-1'] }),
          10,
        );
        expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
      },
    );
  });

  // ---------------------------------------------------------------------------
  // User ID is passed as structured filter data, never interpolated into SQL
  // ---------------------------------------------------------------------------
  describe('userId parameterization', () => {
    it('passes userId as structured filter data, not SQL', async () => {
      const maliciousUserId = "user'; DROP TABLE memories; --";

      await service.textSearch('normal query', {
        userId: maliciousUserId,
        limit: 10,
      });

      expect(elasticsearch.keywordSearch).toHaveBeenCalledWith(
        'normal query',
        expect.objectContaining({ userId: [maliciousUserId] }),
        10,
      );
      expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    });

    it('passes multiple userIds as structured filter data', async () => {
      const userIds = ['user-1', "user'; DROP TABLE memories; --"];

      await service.textSearch('normal query', {
        userId: userIds,
        limit: 10,
      });

      expect(elasticsearch.keywordSearch).toHaveBeenCalledWith(
        'normal query',
        expect.objectContaining({ userId: userIds }),
        10,
      );
      expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    });
  });
});

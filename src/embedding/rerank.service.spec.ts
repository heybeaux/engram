import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RerankService } from './rerank.service';

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

describe('RerankService', () => {
  let service: RerankService;

  const buildModule = async (config: Record<string, string> = {}) => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RerankService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: string) => {
              return config[key] ?? defaultValue;
            }),
          },
        },
      ],
    }).compile();

    return module.get<RerankService>(RerankService);
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    service = await buildModule({
      RERANK_ENABLED: 'true',
      RERANK_URL: 'http://localhost:8081',
    });
  });

  describe('rerank', () => {
    it('should reorder results by cross-encoder score', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => [
          { index: 2, score: 0.95 },
          { index: 0, score: 0.80 },
          { index: 1, score: 0.30 },
        ],
      });

      const results = await service.rerank('what is my dog name', [
        'User likes cats',
        'User lives in NYC',
        'User dog is named Max',
      ]);

      expect(results).toEqual([
        { index: 2, score: 0.95 },
        { index: 0, score: 0.80 },
        { index: 1, score: 0.30 },
      ]);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8081/rerank',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: 'what is my dog name',
            texts: [
              'User likes cats',
              'User lives in NYC',
              'User dog is named Max',
            ],
            raw_scores: false,
          }),
        }),
      );
    });

    it('should return original order when RERANK_ENABLED=false', async () => {
      service = await buildModule({ RERANK_ENABLED: 'false' });

      const results = await service.rerank('query', ['text1', 'text2']);

      expect(results).toEqual([
        { index: 0, score: 0 },
        { index: 1, score: 0 },
      ]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should return original order when endpoint is down', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const results = await service.rerank('query', ['text1', 'text2']);

      expect(results).toEqual([
        { index: 0, score: 0 },
        { index: 1, score: 0 },
      ]);
    });

    it('should return original order on non-ok response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      const results = await service.rerank('query', ['text1']);

      expect(results).toEqual([{ index: 0, score: 0 }]);
    });

    it('should handle empty input', async () => {
      const results = await service.rerank('query', []);
      expect(results).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should timeout after 2 seconds and return original order', async () => {
      mockFetch.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 5000)),
      );

      const results = await service.rerank('query', ['text1', 'text2']);

      expect(results).toEqual([
        { index: 0, score: 0 },
        { index: 1, score: 0 },
      ]);
    }, 10000);
  });

  describe('RRF ensemble (multi-URL)', () => {
    it('should apply RRF when multiple URLs configured and all succeed', async () => {
      service = await buildModule({
        RERANK_ENABLED: 'true',
        RERANK_URLS: 'http://localhost:8081,http://localhost:8082',
      });

      // Model 1: ranks doc2 first, doc0 second, doc1 third
      // Model 2: ranks doc0 first, doc2 second, doc1 third
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [{ index: 2, score: 0.9 }, { index: 0, score: 0.7 }, { index: 1, score: 0.2 }],
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [{ index: 0, score: 0.95 }, { index: 2, score: 0.6 }, { index: 1, score: 0.1 }],
        });

      const results = await service.rerank('query', ['text0', 'text1', 'text2']);

      // doc0: 1/(60+2) + 1/(60+1) = 0.01613 + 0.01639 = 0.03252
      // doc2: 1/(60+1) + 1/(60+2) = 0.01639 + 0.01613 = 0.03252
      // doc1: 1/(60+3) + 1/(60+3) = lowest
      // doc0 and doc2 should both score above doc1
      expect(results[2].index).toBe(1); // doc1 always last
      expect(results.map(r => r.score).every(s => s > 0)).toBe(true);
    });

    it('should use only successful model when one fails', async () => {
      service = await buildModule({
        RERANK_ENABLED: 'true',
        RERANK_URLS: 'http://localhost:8081,http://localhost:8082',
      });

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [{ index: 1, score: 0.9 }, { index: 0, score: 0.5 }],
        })
        .mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const results = await service.rerank('query', ['text0', 'text1']);
      expect(results[0].index).toBe(1);
      expect(results[1].index).toBe(0);
    });

    it('should return original order when all ensemble models fail', async () => {
      service = await buildModule({
        RERANK_ENABLED: 'true',
        RERANK_URLS: 'http://localhost:8081,http://localhost:8082',
      });

      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const results = await service.rerank('query', ['text0', 'text1']);
      expect(results).toEqual([{ index: 0, score: 0 }, { index: 1, score: 0 }]);
    });

    it('doc ranked 1st by both models should outscore doc ranked 1st by only one', async () => {
      service = await buildModule({
        RERANK_ENABLED: 'true',
        RERANK_URLS: 'http://localhost:8081,http://localhost:8082',
      });

      // docA ranked 1st by model1, 1st by model2 → double RRF score
      // docB ranked 1st by model1 only, 2nd by model2
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [{ index: 0, score: 0.9 }, { index: 1, score: 0.8 }],
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [{ index: 0, score: 0.95 }, { index: 1, score: 0.4 }],
        });

      const results = await service.rerank('query', ['docA', 'docB']);
      expect(results[0].index).toBe(0); // docA wins with both models agreeing
    });

    it('should respect RERANK_MODEL_WEIGHTS', async () => {
      service = await buildModule({
        RERANK_ENABLED: 'true',
        RERANK_URLS: 'http://localhost:8081,http://localhost:8082',
        RERANK_MODEL_WEIGHTS: '1.0,2.0',
      });

      // Model 1 (weight 1): doc1 first
      // Model 2 (weight 2): doc0 first — should win due to higher weight
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [{ index: 1, score: 0.9 }, { index: 0, score: 0.1 }],
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [{ index: 0, score: 0.9 }, { index: 1, score: 0.1 }],
        });

      const results = await service.rerank('query', ['docA', 'docB']);
      // Model 2 has 2x weight, so doc0 should win
      expect(results[0].index).toBe(0);
    });
  });

  describe('isAvailable', () => {
    it('should return true when health endpoint is ok', async () => {
      mockFetch.mockResolvedValue({ ok: true });

      const result = await service.isAvailable();
      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8081/health',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('should return false when health endpoint fails', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await service.isAvailable();
      expect(result).toBe(false);
    });

    it('should return false when RERANK_ENABLED=false', async () => {
      service = await buildModule({ RERANK_ENABLED: 'false' });

      const result = await service.isAvailable();
      expect(result).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});

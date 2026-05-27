import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { LocalEmbedProvider } from './local-embed.provider';

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

const mockConfig = {
  get: jest.fn((key: string, defaultValue?: any) => {
    const config: Record<string, any> = {
      LOCAL_EMBED_URL: 'http://localhost:8080',
      LOCAL_EMBED_MODEL: 'bge-base-en-v1.5',
      LOCAL_EMBED_DIMENSIONS: 768,
    };
    return config[key] ?? defaultValue;
  }),
};

describe('LocalEmbedProvider', () => {
  let provider: LocalEmbedProvider;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LocalEmbedProvider,
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    provider = module.get<LocalEmbedProvider>(LocalEmbedProvider);
  });

  it('should be defined', () => {
    expect(provider).toBeDefined();
    expect(provider.name).toBe('local');
  });

  it('should return model name and dimensions', () => {
    expect(provider.getModelName()).toBe('bge-base-en-v1.5');
    expect(provider.getDimensions()).toBe(768);
  });

  describe('embed', () => {
    it('should embed a single text', async () => {
      const mockEmbedding = new Array(768).fill(0.1);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ embedding: mockEmbedding }],
        }),
      });

      const result = await provider.embed(['hello']);
      expect(result).toEqual([mockEmbedding]);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/v1/embeddings',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ input: 'hello', model: 'bge-base-en-v1.5' }),
        }),
      );
    });

    it('should embed multiple texts', async () => {
      const mockEmbeddings = [
        { embedding: new Array(768).fill(0.1) },
        { embedding: new Array(768).fill(0.2) },
      ];
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: mockEmbeddings }),
      });

      const result = await provider.embed(['hello', 'world']);
      expect(result).toEqual([
        new Array(768).fill(0.1),
        new Array(768).fill(0.2),
      ]);
      // Multiple texts should send as array
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/v1/embeddings',
        expect.objectContaining({
          body: JSON.stringify({
            input: ['hello', 'world'],
            model: 'bge-base-en-v1.5',
          }),
        }),
      );
    });

    it('should throw on API error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      await expect(provider.embed(['test'])).rejects.toThrow(
        'Local embedding API error: 500',
      );
    });

    it('should throw on invalid response', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      await expect(provider.embed(['test'])).rejects.toThrow(
        'Invalid response',
      );
    });

    it('should throw on wrong embedding dimensions', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ embedding: [0.1, 0.2] }],
        }),
      });

      await expect(provider.embed(['test'])).rejects.toThrow(
        'expected 768 dimensions, got 2',
      );
    });

    it('should throw on non-finite embedding values', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ embedding: new Array(768).fill(null) }],
        }),
      });

      await expect(provider.embed(['test'])).rejects.toThrow(
        'contains non-finite values',
      );
    });

    it('should send X-Priority header when priority option is set', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ embedding: new Array(768).fill(0.1) }],
        }),
      });

      await provider.embed(['recall query'], { priority: 'recall' });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/v1/embeddings',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Priority': 'recall',
          },
        }),
      );
    });

    it('should not send X-Priority header when no priority option', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ embedding: new Array(768).fill(0.1) }],
        }),
      });

      await provider.embed(['test']);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/v1/embeddings',
        expect.objectContaining({
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });

    it('should abort request when timeout expires', async () => {
      jest.useFakeTimers();
      mockFetch.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            if (init.signal) {
              init.signal.addEventListener('abort', () =>
                reject(new DOMException('Aborted', 'AbortError')),
              );
            }
          }),
      );

      const promise = provider.embed(['slow'], { timeoutMs: 100 });
      jest.advanceTimersByTime(100);

      await expect(promise).rejects.toThrow();
      jest.useRealTimers();
    });
  });

  describe('healthCheck', () => {
    it('should return true when healthy', async () => {
      mockFetch.mockResolvedValue({ ok: true });

      const result = await provider.healthCheck();
      expect(result).toBe(true);
    });

    it('should return false when down', async () => {
      mockFetch.mockRejectedValue(new Error('Connection refused'));

      const result = await provider.healthCheck();
      expect(result).toBe(false);
    });
  });

  describe('LOCAL_EMBED_DIMENSIONS coercion', () => {
    it('coerces stringified env value to number and accepts matching embedding', async () => {
      const stringDimConfig = {
        get: jest.fn((key: string, defaultValue?: any) => {
          const config: Record<string, any> = {
            LOCAL_EMBED_URL: 'http://localhost:8080',
            LOCAL_EMBED_MODEL: 'minilm',
            LOCAL_EMBED_DIMENSIONS: '384',
          };
          return config[key] ?? defaultValue;
        }),
      };
      const module = await Test.createTestingModule({
        providers: [
          LocalEmbedProvider,
          { provide: ConfigService, useValue: stringDimConfig },
        ],
      }).compile();
      const stringProvider = module.get<LocalEmbedProvider>(LocalEmbedProvider);

      expect(stringProvider.getDimensions()).toBe(384);

      const mockEmbedding = new Array(384).fill(0.1);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: mockEmbedding }] }),
      });
      const result = await stringProvider.embed(['hello']);
      expect(result[0]).toHaveLength(384);
    });

    it('throws on non-numeric LOCAL_EMBED_DIMENSIONS', async () => {
      const badConfig = {
        get: jest.fn((key: string, defaultValue?: any) => {
          const config: Record<string, any> = {
            LOCAL_EMBED_URL: 'http://localhost:8080',
            LOCAL_EMBED_MODEL: 'minilm',
            LOCAL_EMBED_DIMENSIONS: 'not-a-number',
          };
          return config[key] ?? defaultValue;
        }),
      };
      await expect(
        Test.createTestingModule({
          providers: [
            LocalEmbedProvider,
            { provide: ConfigService, useValue: badConfig },
          ],
        }).compile(),
      ).rejects.toThrow(/LOCAL_EMBED_DIMENSIONS must be a positive integer/);
    });
  });
});

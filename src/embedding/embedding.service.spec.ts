import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EmbeddingService } from './embedding.service';
import { LocalEmbedProvider } from './local-embed.provider';
import { OpenAIEmbedProvider } from './openai-embed.provider';
import { CloudEnsembleEmbedProvider } from './cloud-ensemble-embed.provider';

const mockCloudEnsembleProvider = {
  name: 'cloud-ensemble',
  embed: jest.fn(),
  getModelName: jest.fn().mockReturnValue('cloud-ensemble (openai-small)'),
  getDimensions: jest.fn().mockReturnValue(1536),
  healthCheck: jest.fn(),
};

const mockLocalProvider = {
  name: 'local',
  embed: jest.fn(),
  getModelName: jest.fn().mockReturnValue('bge-base-en-v1.5'),
  getDimensions: jest.fn().mockReturnValue(768),
  healthCheck: jest.fn(),
};

const mockOpenAIProvider = {
  name: 'openai',
  embed: jest.fn(),
  getModelName: jest.fn().mockReturnValue('text-embedding-3-small'),
  getDimensions: jest.fn().mockReturnValue(1536),
  healthCheck: jest.fn(),
};

describe('EmbeddingService', () => {
  let service: EmbeddingService;

  describe('with local provider (default)', () => {
    beforeEach(async () => {
      jest.clearAllMocks();

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          EmbeddingService,
          { provide: LocalEmbedProvider, useValue: mockLocalProvider },
          { provide: OpenAIEmbedProvider, useValue: mockOpenAIProvider },
          {
            provide: CloudEnsembleEmbedProvider,
            useValue: mockCloudEnsembleProvider,
          },
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string, defaultValue?: any) => {
                const config: Record<string, any> = {};
                return config[key] ?? defaultValue;
              }),
            },
          },
        ],
      }).compile();

      service = module.get<EmbeddingService>(EmbeddingService);
    });

    it('should be defined', () => {
      expect(service).toBeDefined();
    });

    it('should use local provider by default', () => {
      expect(service.getProviderName()).toBe('local');
      expect(service.getModelName()).toBe('bge-base-en-v1.5');
      expect(service.getDimensions()).toBe(768);
    });

    it('should embed texts', async () => {
      const mockEmbeddings = [
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ];
      mockLocalProvider.embed.mockResolvedValue(mockEmbeddings);

      const result = await service.embed(['hello', 'world']);
      expect(result).toEqual(mockEmbeddings);
      expect(mockLocalProvider.embed).toHaveBeenCalledWith(['hello', 'world']);
    });

    it('should embed single text with embedOne', async () => {
      mockLocalProvider.embed.mockResolvedValue([[0.1, 0.2, 0.3]]);

      const result = await service.embedOne('hello');
      expect(result).toEqual([0.1, 0.2, 0.3]);
      expect(mockLocalProvider.embed).toHaveBeenCalledWith(['hello']);
    });

    it('should delegate healthCheck', async () => {
      mockLocalProvider.healthCheck.mockResolvedValue(true);

      const result = await service.healthCheck();
      expect(result).toBe(true);
    });

    it('should pass options through embedOneWithOptions', async () => {
      mockLocalProvider.embed.mockResolvedValue([[0.1, 0.2, 0.3]]);

      const result = await service.embedOneWithOptions('recall query', {
        priority: 'recall',
        timeoutMs: 5000,
      });
      expect(result).toEqual([0.1, 0.2, 0.3]);
      expect(mockLocalProvider.embed).toHaveBeenCalledWith(['recall query'], {
        priority: 'recall',
        timeoutMs: 5000,
      });
    });
  });

  describe('with openai provider', () => {
    beforeEach(async () => {
      jest.clearAllMocks();

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          EmbeddingService,
          { provide: LocalEmbedProvider, useValue: mockLocalProvider },
          { provide: OpenAIEmbedProvider, useValue: mockOpenAIProvider },
          {
            provide: CloudEnsembleEmbedProvider,
            useValue: mockCloudEnsembleProvider,
          },
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string, defaultValue?: any) => {
                const config: Record<string, any> = {
                  EMBEDDING_PROVIDER: 'openai',
                };
                return config[key] ?? defaultValue;
              }),
            },
          },
        ],
      }).compile();

      service = module.get<EmbeddingService>(EmbeddingService);
    });

    it('should use openai provider', () => {
      expect(service.getProviderName()).toBe('openai');
      expect(service.getModelName()).toBe('text-embedding-3-small');
    });

    it('should delegate embed to openai', async () => {
      const mockEmbeddings = [[0.1, 0.2]];
      mockOpenAIProvider.embed.mockResolvedValue(mockEmbeddings);

      const result = await service.embed(['test']);
      expect(result).toEqual(mockEmbeddings);
      expect(mockOpenAIProvider.embed).toHaveBeenCalledWith(['test']);
    });
  });

  describe('with unknown provider', () => {
    beforeEach(async () => {
      jest.clearAllMocks();

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          EmbeddingService,
          { provide: LocalEmbedProvider, useValue: mockLocalProvider },
          { provide: OpenAIEmbedProvider, useValue: mockOpenAIProvider },
          {
            provide: CloudEnsembleEmbedProvider,
            useValue: mockCloudEnsembleProvider,
          },
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string, defaultValue?: any) => {
                const config: Record<string, any> = {
                  EMBEDDING_PROVIDER: 'unknown',
                };
                return config[key] ?? defaultValue;
              }),
            },
          },
        ],
      }).compile();

      service = module.get<EmbeddingService>(EmbeddingService);
    });

    it('should fall back to local provider', () => {
      expect(service.getProviderName()).toBe('local');
    });
  });
});

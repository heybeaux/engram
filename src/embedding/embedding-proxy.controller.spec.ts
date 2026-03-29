import { Test, TestingModule } from '@nestjs/testing';
import { EmbeddingProxyController } from './embedding-proxy.controller';
import { EmbeddingService } from './embedding.service';
import { ApiKeyGuard } from '../common/guards/api-key.guard';

describe('EmbeddingProxyController', () => {
  let controller: EmbeddingProxyController;
  let embeddingService: any;

  beforeEach(async () => {
    embeddingService = {
      embedOne: jest.fn(),
      getModelName: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [EmbeddingProxyController],
      providers: [
        { provide: EmbeddingService, useValue: embeddingService },
      ],
    })
      .overrideGuard(ApiKeyGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<EmbeddingProxyController>(EmbeddingProxyController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('POST /v1/embeddings', () => {
    it('should embed a single string input', async () => {
      embeddingService.embedOne!.mockResolvedValue([0.1, 0.2, 0.3]);
      embeddingService.getModelName!.mockReturnValue('bge-base-en-v1.5');

      const result = await controller.embeddings({ input: 'hello world' } as any);

      expect(embeddingService.embedOne).toHaveBeenCalledWith('hello world');
      expect(result).toEqual({
        object: 'list',
        data: [
          { object: 'embedding', embedding: [0.1, 0.2, 0.3], index: 0 },
        ],
        model: 'bge-base-en-v1.5',
        usage: {
          prompt_tokens: 3, // Math.ceil(11/4) = 3
          total_tokens: 3,
        },
      });
    });

    it('should embed an array of strings', async () => {
      embeddingService.embedOne!
        .mockResolvedValueOnce([0.1, 0.2])
        .mockResolvedValueOnce([0.3, 0.4]);
      embeddingService.getModelName!.mockReturnValue('text-embedding-ada-002');

      const result = await controller.embeddings({
        input: ['first', 'second'],
      } as any);

      expect(embeddingService.embedOne).toHaveBeenCalledTimes(2);
      expect(embeddingService.embedOne).toHaveBeenCalledWith('first');
      expect(embeddingService.embedOne).toHaveBeenCalledWith('second');
      expect(result.data).toHaveLength(2);
      expect(result.data[0].index).toBe(0);
      expect(result.data[1].index).toBe(1);
      expect(result.model).toBe('text-embedding-ada-002');
    });

    it('should use dto model when getModelName returns empty', async () => {
      embeddingService.embedOne!.mockResolvedValue([0.1]);
      embeddingService.getModelName!.mockReturnValue('');

      const result = await controller.embeddings({
        input: 'test',
        model: 'custom-model',
      } as any);

      expect(result.model).toBe('custom-model');
    });

    it('should default model to bge-base-en-v1.5 when no model available', async () => {
      embeddingService.embedOne!.mockResolvedValue([0.1]);
      embeddingService.getModelName!.mockReturnValue('');

      const result = await controller.embeddings({ input: 'test' } as any);

      expect(result.model).toBe('bge-base-en-v1.5');
    });

    it('should calculate token estimate correctly', async () => {
      embeddingService.embedOne!.mockResolvedValue([0.1]);
      embeddingService.getModelName!.mockReturnValue('model');

      // 20 chars → ceil(20/4) = 5 tokens
      const result = await controller.embeddings({
        input: '12345678901234567890',
      } as any);

      expect(result.usage.prompt_tokens).toBe(5);
      expect(result.usage.total_tokens).toBe(5);
    });

    it('should sum tokens across multiple inputs', async () => {
      embeddingService.embedOne!.mockResolvedValue([0.1]);
      embeddingService.getModelName!.mockReturnValue('model');

      // 'abcd' = 4 chars → 1 token, 'efghijkl' = 8 chars → 2 tokens = 3 total
      const result = await controller.embeddings({
        input: ['abcd', 'efghijkl'],
      } as any);

      expect(result.usage.prompt_tokens).toBe(3);
      expect(result.usage.total_tokens).toBe(3);
    });

    it('should propagate embedding service errors', async () => {
      embeddingService.embedOne!.mockRejectedValue(new Error('Provider down'));

      await expect(
        controller.embeddings({ input: 'fail' } as any),
      ).rejects.toThrow('Provider down');
    });
  });
});

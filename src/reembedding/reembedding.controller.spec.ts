import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { ReembeddingController } from './reembedding.controller';
import { ReembeddingService } from './reembedding.service';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';

const mockGuard = { canActivate: jest.fn().mockReturnValue(true) };

const mockService = {
  triggerReembedding: jest.fn(),
  getCurrentJobStatus: jest.fn(),
  getJobStatus: jest.fn(),
  listJobs: jest.fn(),
  previewEnrichment: jest.fn(),
  reembedMemory: jest.fn(),
  isEnabled: jest.fn(),
};

describe('ReembeddingController', () => {
  let controller: ReembeddingController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ReembeddingController],
      providers: [{ provide: ReembeddingService, useValue: mockService }],
    })
      .overrideGuard(ApiKeyOrJwtGuard)
      .useValue(mockGuard)
      .compile();
    controller = module.get<ReembeddingController>(ReembeddingController);
  });

  describe('triggerReembedding', () => {
    it('should delegate to service and return result', async () => {
      const dto = { batchSize: 100 };
      const expected = { jobId: 'j1', status: 'running' };
      mockService.triggerReembedding.mockResolvedValue(expected);
      expect(await controller.triggerReembedding(dto as any)).toBe(expected);
    });

    it('should throw BAD_REQUEST on service error', async () => {
      mockService.triggerReembedding.mockRejectedValue(
        new Error('Job already running'),
      );
      await expect(controller.triggerReembedding({} as any)).rejects.toThrow(
        HttpException,
      );
      await expect(
        controller.triggerReembedding({} as any),
      ).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
      });
    });

    it('should handle non-Error throws', async () => {
      mockService.triggerReembedding.mockRejectedValue('string error');
      await expect(controller.triggerReembedding({} as any)).rejects.toThrow(
        'Failed to trigger re-embedding',
      );
    });
  });

  describe('getCurrentStatus', () => {
    it('should return status when active', () => {
      const status = { jobId: 'j1', status: 'running' };
      mockService.getCurrentJobStatus.mockReturnValue(status);
      expect(controller.getCurrentStatus()).toBe(status);
    });

    it('should throw NOT_FOUND when no active job', () => {
      mockService.getCurrentJobStatus.mockReturnValue(null);
      expect(() => controller.getCurrentStatus()).toThrow(HttpException);
    });
  });

  describe('getJobStatus', () => {
    it('should return job status', () => {
      const status = { jobId: 'j1' };
      mockService.getJobStatus.mockReturnValue(status);
      expect(controller.getJobStatus('j1')).toBe(status);
    });

    it('should throw NOT_FOUND for unknown job', () => {
      mockService.getJobStatus.mockReturnValue(null);
      expect(() => controller.getJobStatus('missing')).toThrow(HttpException);
    });
  });

  describe('listJobs', () => {
    it('should pass limit to service', () => {
      mockService.listJobs.mockReturnValue([]);
      controller.listJobs(5);
      expect(mockService.listJobs).toHaveBeenCalledWith(5);
    });

    it('should default limit to 10', () => {
      mockService.listJobs.mockReturnValue([]);
      controller.listJobs(undefined);
      expect(mockService.listJobs).toHaveBeenCalledWith(10);
    });
  });

  describe('previewEnrichment', () => {
    it('should return preview', async () => {
      const preview = { memoryId: 'm1', enriched: 'text' };
      mockService.previewEnrichment.mockResolvedValue(preview);
      expect(await controller.previewEnrichment('m1')).toBe(preview);
    });

    it('should throw NOT_FOUND when memory missing', async () => {
      mockService.previewEnrichment.mockResolvedValue(null);
      await expect(controller.previewEnrichment('missing')).rejects.toThrow(
        HttpException,
      );
    });
  });

  describe('reembedMemory', () => {
    it('should throw BAD_REQUEST when disabled', async () => {
      mockService.isEnabled.mockReturnValue(false);
      await expect(controller.reembedMemory('m1')).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
      });
    });

    it('should re-embed when enabled', async () => {
      mockService.isEnabled.mockReturnValue(true);
      const result = { memoryId: 'm1' };
      mockService.reembedMemory.mockResolvedValue(result);
      expect(await controller.reembedMemory('m1', 'false')).toBe(result);
      expect(mockService.reembedMemory).toHaveBeenCalledWith('m1', false);
    });

    it('should pass dryRun=true', async () => {
      mockService.isEnabled.mockReturnValue(true);
      mockService.reembedMemory.mockResolvedValue({ memoryId: 'm1' });
      await controller.reembedMemory('m1', 'true');
      expect(mockService.reembedMemory).toHaveBeenCalledWith('m1', true);
    });

    it('should throw NOT_FOUND when memory not found', async () => {
      mockService.isEnabled.mockReturnValue(true);
      mockService.reembedMemory.mockResolvedValue(null);
      await expect(controller.reembedMemory('missing')).rejects.toMatchObject({
        status: HttpStatus.NOT_FOUND,
      });
    });

    it('should re-throw HttpExceptions as-is', async () => {
      mockService.isEnabled.mockReturnValue(true);
      const err = new HttpException('Custom', HttpStatus.CONFLICT);
      mockService.reembedMemory.mockRejectedValue(err);
      await expect(controller.reembedMemory('m1')).rejects.toBe(err);
    });
  });

  describe('isEnabled', () => {
    it('should return enabled status and version', () => {
      mockService.isEnabled.mockReturnValue(true);
      expect(controller.isEnabled()).toEqual({
        enabled: true,
        version: '1.0.0',
      });
    });
  });
});

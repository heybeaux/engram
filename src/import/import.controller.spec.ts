import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ImportController } from './import.controller';
import { ImportExecutionService } from './import-execution.service';
import { ImportJobService } from './import-job.service';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';

describe('ImportController', () => {
  let controller: ImportController;
  let executionService: ImportExecutionService;
  let jobService: ImportJobService;

  const mockAgent = { id: 'agent-1', accountId: 'account-1' };

  const mockExecutionService = {
    preview: jest.fn(),
    execute: jest.fn(),
  };

  const mockJobService = {
    getJob: jest.fn(),
  };

  const validConfig = JSON.stringify({
    profileMapping: { name: 'name', type: 'type' },
    attributeMapping: [{ key: 'email', column: 'email', valueType: 'EMAIL' }],
    memoryMapping: { content: 'notes' },
  });

  const mockFile = {
    buffer: Buffer.from(
      'name,type,email,notes\nAlice,PERSON,alice@example.com,test',
    ),
    originalname: 'import.csv',
    mimetype: 'text/csv',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ImportController],
      providers: [
        { provide: ImportExecutionService, useValue: mockExecutionService },
        { provide: ImportJobService, useValue: mockJobService },
      ],
    })
      .overrideGuard(ApiKeyOrJwtGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<ImportController>(ImportController);
    executionService = module.get<ImportExecutionService>(
      ImportExecutionService,
    );
    jobService = module.get<ImportJobService>(ImportJobService);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  // ── preview ────────────────────────────────────────────────────────────────

  describe('POST /preview', () => {
    it('calls executionService.preview with parsed config and buffer', async () => {
      const mockResult = {
        profiles: [
          {
            rowNumber: 2,
            name: 'Alice',
            type: 'PERSON',
            attributeCount: 1,
            hasMemory: true,
          },
        ],
        memories: [{ rowNumber: 2, content: 'test' }],
        errors: [],
        stats: { profileCount: 1, memoryCount: 1, errorCount: 0 },
      };
      mockExecutionService.preview.mockResolvedValue(mockResult);

      const result = await controller.preview(mockAgent, mockFile, validConfig);

      expect(mockExecutionService.preview).toHaveBeenCalledWith(
        mockFile.buffer,
        expect.objectContaining({
          profileMapping: { name: 'name', type: 'type' },
        }),
        'agent-1',
      );
      expect(result).toEqual(mockResult);
    });

    it('throws BadRequestException when file is missing', async () => {
      await expect(
        controller.preview(mockAgent, undefined as any, validConfig),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when config is missing', async () => {
      await expect(
        controller.preview(mockAgent, mockFile, undefined as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when config is invalid JSON', async () => {
      await expect(
        controller.preview(mockAgent, mockFile, '{invalid json}'),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when profileMapping.name is missing from config', async () => {
      const badConfig = JSON.stringify({ profileMapping: {} });
      await expect(
        controller.preview(mockAgent, mockFile, badConfig),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── execute ────────────────────────────────────────────────────────────────

  describe('POST /', () => {
    it('calls executionService.execute and returns jobId + PROCESSING status', async () => {
      mockExecutionService.execute.mockResolvedValue({ jobId: 'job-123' });

      const result = await controller.execute(mockAgent, mockFile, validConfig);

      expect(mockExecutionService.execute).toHaveBeenCalledWith(
        mockFile.buffer,
        expect.objectContaining({
          profileMapping: { name: 'name', type: 'type' },
        }),
        'agent-1',
      );
      expect(result).toEqual({ jobId: 'job-123', status: 'PROCESSING' });
    });

    it('throws BadRequestException when file is missing', async () => {
      await expect(
        controller.execute(mockAgent, undefined as any, validConfig),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── getStatus ──────────────────────────────────────────────────────────────

  describe('GET /:jobId', () => {
    it('returns job status from jobService', async () => {
      const mockJob = {
        jobId: 'job-123',
        userId: 'user-1',
        status: 'COMPLETED',
        progress: 1,
        stats: { profileCount: 5, memoryCount: 5, errorCount: 0 },
        errors: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockJobService.getJob.mockReturnValue(mockJob);

      const result = await controller.getStatus(mockAgent, 'job-123');

      expect(mockJobService.getJob).toHaveBeenCalledWith('job-123');
      expect(result.status).toBe('COMPLETED');
      expect(result.progress).toBe(1);
      expect(result.stats.profileCount).toBe(5);
    });

    it('propagates NotFoundException from jobService', async () => {
      const { NotFoundException } = require('@nestjs/common');
      mockJobService.getJob.mockImplementation(() => {
        throw new NotFoundException('Import job not found: bad-id');
      });

      await expect(controller.getStatus(mockAgent, 'bad-id')).rejects.toThrow(
        'Import job not found',
      );
    });
  });
});

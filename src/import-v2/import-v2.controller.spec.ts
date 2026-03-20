import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
} from '@nestjs/common';
import { ImportV2Controller } from './import-v2.controller';
import { ImportPreviewService } from './import-preview.service';
import { ImportJobService } from '../import/import-job.service';
import { EntityProfileService } from '../entity-profile/entity-profile.service';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';
import { MappingConfig, PreviewResult } from '../import/import.types';
import { BULK_IMPORT_V2_QUEUE } from './import-v2.queue';
import { getQueueToken } from '@nestjs/bullmq';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockPreviewService = {
  preview: jest.fn(),
};

const mockJobService = {
  createJob: jest.fn(),
  getJob: jest.fn(),
  failJob: jest.fn(),
};

const mockProfileService = {
  getOrCreateUser: jest.fn().mockResolvedValue('user-id-123'),
};

const mockQueue = {
  add: jest.fn().mockResolvedValue({ id: 'bull-job-1' }),
};

/** Passthrough guard — skips auth in unit tests */
class AlwaysPassGuard implements CanActivate {
  canActivate(_ctx: ExecutionContext) {
    return true;
  }
}

const AGENT = { id: 'agent-1', accountId: 'account-1' };

const BASE_MAPPING: MappingConfig = {
  profileMapping: { name: 'name', type: 'PERSON' },
  attributeMapping: [{ key: 'email', column: 'email' }],
};

interface MockFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

const buildFile = (
  content = 'name,email\nAlice,alice@example.com',
): MockFile => ({
  buffer: Buffer.from(content),
  originalname: 'import.csv',
  mimetype: 'text/csv',
  size: content.length,
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ImportV2Controller', () => {
  let controller: ImportV2Controller;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Default mock implementations
    mockJobService.createJob.mockReturnValue({ jobId: 'job-uuid-1' });
    mockJobService.getJob.mockReturnValue({
      jobId: 'job-uuid-1',
      userId: 'user-id-123',
      status: 'PROCESSING',
      progress: 0.5,
      stats: { profileCount: 5, memoryCount: 3, errorCount: 0 },
      errors: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const previewResult: PreviewResult = {
      profiles: [
        {
          rowNumber: 2,
          name: 'Alice',
          type: 'PERSON' as any,
          attributeCount: 1,
          hasMemory: false,
        },
      ],
      memories: [],
      errors: [],
      stats: { profileCount: 1, memoryCount: 0, errorCount: 0 },
    };
    mockPreviewService.preview.mockResolvedValue(previewResult);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ImportV2Controller],
      providers: [
        { provide: ImportPreviewService, useValue: mockPreviewService },
        { provide: ImportJobService, useValue: mockJobService },
        { provide: EntityProfileService, useValue: mockProfileService },
        { provide: getQueueToken(BULK_IMPORT_V2_QUEUE), useValue: mockQueue },
      ],
    })
      .overrideGuard(ApiKeyOrJwtGuard)
      .useClass(AlwaysPassGuard)
      .compile();

    controller = module.get<ImportV2Controller>(ImportV2Controller);
  });

  // ── POST /preview ──────────────────────────────────────────────────────────

  describe('POST /v1/profiles/import/preview', () => {
    it('returns preview result for valid input', async () => {
      const file = buildFile();
      const result = await controller.preview(
        file as any,
        JSON.stringify(BASE_MAPPING),
      );

      expect(mockPreviewService.preview).toHaveBeenCalledWith(
        file.buffer,
        BASE_MAPPING,
      );
      expect(result.profiles).toHaveLength(1);
      expect(result.stats.profileCount).toBe(1);
    });

    it('throws BadRequestException when file is missing', async () => {
      await expect(
        controller.preview(undefined as any, JSON.stringify(BASE_MAPPING)),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when mapping is missing', async () => {
      await expect(
        controller.preview(buildFile() as any, undefined as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException on invalid JSON mapping', async () => {
      await expect(
        controller.preview(buildFile() as any, 'not-valid-json'),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when profileMapping.name is missing', async () => {
      const badMapping = { profileMapping: {} };
      await expect(
        controller.preview(buildFile() as any, JSON.stringify(badMapping)),
      ).rejects.toThrow(BadRequestException);
    });

    it('does NOT call preview service if validation fails', async () => {
      const badMapping = { profileMapping: {} };
      try {
        await controller.preview(
          buildFile() as any,
          JSON.stringify(badMapping),
        );
      } catch {
        // expected
      }
      expect(mockPreviewService.preview).not.toHaveBeenCalled();
    });
  });

  // ── POST /import ───────────────────────────────────────────────────────────

  describe('POST /v1/profiles/import', () => {
    beforeEach(() => {
      process.env.REDIS_URL = 'redis://localhost:6379';
    });

    afterEach(() => {
      delete process.env.REDIS_URL;
    });

    it('creates a job and enqueues it, returns jobId + PROCESSING status', async () => {
      const file = buildFile();
      const result = await controller.startImport(
        AGENT,
        file as any,
        JSON.stringify(BASE_MAPPING),
      );

      expect(mockJobService.createJob).toHaveBeenCalledWith('user-id-123');
      expect(mockQueue.add).toHaveBeenCalled();
      expect(result).toEqual({ jobId: 'job-uuid-1', status: 'PROCESSING' });
    });

    it('passes the base64-encoded file buffer in the queue job data', async () => {
      const csvContent = 'name,email\nBob,bob@example.com';
      const file = buildFile(csvContent);

      await controller.startImport(
        AGENT,
        file as any,
        JSON.stringify(BASE_MAPPING),
      );

      const [, jobData] = mockQueue.add.mock.calls[0];
      expect(jobData.fileBase64).toBe(file.buffer.toString('base64'));
      expect(jobData.jobId).toBe('job-uuid-1');
      expect(jobData.userId).toBe('user-id-123');
    });

    it('throws BadRequestException when file is missing', async () => {
      await expect(
        controller.startImport(
          AGENT,
          undefined as any,
          JSON.stringify(BASE_MAPPING),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException on invalid JSON mapping', async () => {
      await expect(
        controller.startImport(AGENT, buildFile() as any, 'bad-json'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── GET /import/:jobId ─────────────────────────────────────────────────────

  describe('GET /v1/profiles/import/:jobId', () => {
    it('returns job status from the job service', async () => {
      const result = await controller.getJobStatus('job-uuid-1');

      expect(mockJobService.getJob).toHaveBeenCalledWith('job-uuid-1');
      expect(result.status).toBe('PROCESSING');
      expect(result.progress).toBe(0.5);
      expect(result.stats).toEqual({
        profileCount: 5,
        memoryCount: 3,
        errorCount: 0,
      });
    });

    it('propagates NotFoundException from job service', async () => {
      const { NotFoundException } = jest.requireActual('@nestjs/common');
      mockJobService.getJob.mockImplementation(() => {
        throw new NotFoundException('Job not found');
      });

      await expect(controller.getJobStatus('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});

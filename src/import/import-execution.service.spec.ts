import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import {
  ImportExecutionService,
  BULK_IMPORT_QUEUE,
} from './import-execution.service';
import { CsvParserService } from './csv-parser.service';
import { ImportMappingService } from './import-mapping.service';
import { ImportJobService } from './import-job.service';
import { PrismaService } from '../prisma/prisma.service';
import { MappingConfig, ImportJobState } from './import.types';

describe('ImportExecutionService', () => {
  let service: ImportExecutionService;
  let jobService: ImportJobService;

  const mockPrisma = {
    $transaction: jest.fn(),
  };

  const mockQueue = {
    add: jest.fn().mockResolvedValue({ id: 'queue-job-1' }),
  };

  const csvContent = `name,type,email,notes,priority
Alice Johnson,PERSON,alice@example.com,Met at a conference,4
Bob Smith,PERSON,bob@example.com,Potential partner,3`;

  const config: MappingConfig = {
    profileMapping: { name: 'name', type: 'type' },
    attributeMapping: [
      { key: 'email', column: 'email', valueType: 'EMAIL' as any, category: 'contact' },
    ],
    memoryMapping: { content: 'notes', importance: 'priority' },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ImportExecutionService,
        CsvParserService,
        ImportMappingService,
        ImportJobService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: getQueueToken(BULK_IMPORT_QUEUE), useValue: mockQueue },
      ],
    }).compile();

    service = module.get<ImportExecutionService>(ImportExecutionService);
    jobService = module.get<ImportJobService>(ImportJobService);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ── preview ──────────────────────────────────────────────────────────────────

  describe('preview', () => {
    it('returns correct profiles and memories without writing to DB', async () => {
      const file = Buffer.from(csvContent);
      const result = await service.preview(file, config, 'user-1');

      expect(result.profiles).toHaveLength(2);
      expect(result.memories).toHaveLength(2);
      expect(result.stats.profileCount).toBe(2);
      expect(result.stats.memoryCount).toBe(2);
      expect(result.stats.errorCount).toBe(0);

      // Ensure no DB calls were made
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('returns profile names correctly', async () => {
      const file = Buffer.from(csvContent);
      const result = await service.preview(file, config, 'user-1');
      expect(result.profiles[0].name).toBe('Alice Johnson');
      expect(result.profiles[1].name).toBe('Bob Smith');
    });

    it('includes per-row errors in preview result', async () => {
      const csvWithBadRow = `name,type,email,notes,priority\n,PERSON,oops@example.com,no name,3`;
      const file = Buffer.from(csvWithBadRow);
      const result = await service.preview(file, config, 'user-1');

      expect(result.profiles).toHaveLength(0); // skipped
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('required');
    });

    it('throws BadRequestException when CSV is missing required columns', async () => {
      const csvMissingName = `full_name,type\nAlice,PERSON`;
      const file = Buffer.from(csvMissingName);

      await expect(service.preview(file, config, 'user-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── execute ──────────────────────────────────────────────────────────────────

  describe('execute', () => {
    it('creates a job and enqueues it', async () => {
      const file = Buffer.from(csvContent);
      const result = await service.execute(file, config, 'user-1');

      expect(result.jobId).toBeDefined();
      expect(typeof result.jobId).toBe('string');
      expect(mockQueue.add).toHaveBeenCalledWith(
        'bulk-import:process',
        expect.objectContaining({ jobId: result.jobId, userId: 'user-1' }),
        expect.any(Object),
      );
    });

    it('throws BadRequestException when CSV is missing required columns', async () => {
      const csvMissingName = `full_name,type\nAlice,PERSON`;
      const file = Buffer.from(csvMissingName);

      await expect(service.execute(file, config, 'user-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── processJob ───────────────────────────────────────────────────────────────

  describe('processJob', () => {
    const buildJobData = (csv: string) => ({
      jobId: 'test-job-1',
      userId: 'user-1',
      fileBase64: Buffer.from(csv).toString('base64'),
      config,
    });

    const seedJob = () => {
      (jobService as any).jobs.set('test-job-1', {
        jobId: 'test-job-1',
        userId: 'user-1',
        status: 'PROCESSING',
        progress: 0,
        stats: { profileCount: 0, memoryCount: 0, errorCount: 0 },
        errors: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      } as ImportJobState);
    };

    const makeTxMock = () => ({
      entityProfile: {
        create: jest.fn().mockResolvedValue({ id: 'profile-1' }),
      },
      entityAttribute: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
      memory: { create: jest.fn().mockResolvedValue({ id: 'memory-1' }) },
      entityProfileMemory: { create: jest.fn().mockResolvedValue({}) },
    });

    beforeEach(() => {
      seedJob();
      mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(makeTxMock()));
    });

    it('creates profiles, attributes, and memories for valid rows', async () => {
      const jobData = buildJobData(csvContent);
      await service.processJob(jobData);

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2); // 2 rows
      const job = jobService.getJob('test-job-1');
      expect(job.status).toBe('COMPLETED');
      expect(job.stats.profileCount).toBe(2);
      expect(job.stats.memoryCount).toBe(2);
    });

    it('skips bad rows but continues processing good rows', async () => {
      const csvWithOneBadRow = `name,type,email,notes,priority
Alice,PERSON,alice@example.com,good row,3
,PERSON,,no name,
Bob,PERSON,bob@example.com,another good row,2`;

      const jobData = buildJobData(csvWithOneBadRow);
      await service.processJob(jobData);

      // Alice and Bob should be created; blank name row skipped
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
      const job = jobService.getJob('test-job-1');
      expect(job.status).toBe('COMPLETED');
    });

    it('marks job as COMPLETED after processing', async () => {
      const jobData = buildJobData(csvContent);
      await service.processJob(jobData);

      const job = jobService.getJob('test-job-1');
      expect(job.status).toBe('COMPLETED');
      expect(job.progress).toBe(1);
    });

    it('records per-row errors when individual rows fail', async () => {
      let callCount = 0;
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        callCount++;
        if (callCount === 1) throw new Error('DB error on row 1');
        return fn(makeTxMock());
      });

      const jobData = buildJobData(csvContent);
      await service.processJob(jobData);

      const job = jobService.getJob('test-job-1');
      expect(job.status).toBe('COMPLETED');
      expect(job.errors.some((e) => e.message.includes('DB error'))).toBe(true);
    });

    it('marks job FAILED on CSV parse error', async () => {
      const jobData = {
        jobId: 'test-job-1',
        userId: 'user-1',
        fileBase64: Buffer.from('').toString('base64'),
        config,
      };

      await service.processJob(jobData);

      const job = jobService.getJob('test-job-1');
      expect(job.status).toBe('FAILED');
    });
  });

  // ── progress tracking ────────────────────────────────────────────────────────

  describe('progress tracking', () => {
    it('updates job progress during processing', async () => {
      const jobId = 'progress-job';
      (jobService as any).jobs.set(jobId, {
        jobId,
        userId: 'user-1',
        status: 'PROCESSING',
        progress: 0,
        stats: { profileCount: 0, memoryCount: 0, errorCount: 0 },
        errors: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      } as ImportJobState);

      const updateSpy = jest.spyOn(jobService, 'updateProgress');

      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const tx = {
          entityProfile: { create: jest.fn().mockResolvedValue({ id: 'p1' }) },
          entityAttribute: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
          memory: { create: jest.fn().mockResolvedValue({ id: 'm1' }) },
          entityProfileMemory: { create: jest.fn().mockResolvedValue({}) },
        };
        return fn(tx);
      });

      await service.processJob({
        jobId,
        userId: 'user-1',
        fileBase64: Buffer.from(`name,type,notes\nAlice,PERSON,test`).toString('base64'),
        config: {
          profileMapping: { name: 'name', type: 'type' },
          memoryMapping: { content: 'notes' },
        },
      });

      expect(updateSpy).toHaveBeenCalled();
    });
  });
});

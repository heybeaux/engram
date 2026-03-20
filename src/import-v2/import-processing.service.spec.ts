import { Test, TestingModule } from '@nestjs/testing';
import { ImportProcessingService } from './import-processing.service';
import { ImportJobService } from '../import/import-job.service';
import { CsvParserService } from '../import/csv-parser.service';
import { ImportMappingService } from '../import/import-mapping.service';
import { PrismaService } from '../prisma/prisma.service';
import { MappingConfig } from '../import/import.types';

// ── Helpers ───────────────────────────────────────────────────────────────────

const buildCsv = (rows: string[]): Buffer =>
  Buffer.from(['name,type,email,notes,priority', ...rows].join('\n'));

const BASE_CONFIG: MappingConfig = {
  profileMapping: { name: 'name', type: 'PERSON' },
  attributeMapping: [
    {
      key: 'email',
      column: 'email',
      valueType: 'EMAIL' as any,
      category: 'contact',
    },
  ],
  memoryMapping: { content: 'notes', importance: 'priority' },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ImportProcessingService', () => {
  let service: ImportProcessingService;
  let jobService: ImportJobService;
  let mockPrisma: { $transaction: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();

    mockPrisma = { $transaction: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ImportProcessingService,
        ImportJobService,
        CsvParserService,
        ImportMappingService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get(ImportProcessingService);
    jobService = module.get(ImportJobService);
  });

  // ── Mapping config ─────────────────────────────────────────────────────────

  describe('mapping config', () => {
    it('correctly maps CSV columns to profile fields', async () => {
      const { jobId } = jobService.createJob('user-1');

      const createdProfiles: any[] = [];
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const fakeTx = {
          entityProfile: {
            create: jest.fn().mockImplementation((args: any) => {
              createdProfiles.push(args.data);
              return { id: 'profile-1', ...args.data };
            }),
          },
          entityAttribute: {
            createMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
          memory: { create: jest.fn().mockResolvedValue({ id: 'mem-1' }) },
          entityProfileMemory: { create: jest.fn().mockResolvedValue({}) },
        };
        return fn(fakeTx);
      });

      const csv = buildCsv(['Alice,PERSON,alice@example.com,Met at conf,4']);
      await service.processImport(jobId, 'user-1', csv, BASE_CONFIG);

      expect(createdProfiles).toHaveLength(1);
      expect(createdProfiles[0].name).toBe('Alice');
      expect(createdProfiles[0].type).toBe('PERSON');
    });
  });

  // ── processImport stats ────────────────────────────────────────────────────

  describe('processImport stats', () => {
    it('returns correct stats after processing', async () => {
      const { jobId } = jobService.createJob('user-1');

      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const fakeTx = {
          entityProfile: {
            create: jest.fn().mockResolvedValue({ id: 'profile-1' }),
          },
          entityAttribute: {
            createMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
          memory: { create: jest.fn().mockResolvedValue({ id: 'mem-1' }) },
          entityProfileMemory: { create: jest.fn().mockResolvedValue({}) },
        };
        return fn(fakeTx);
      });

      const csv = buildCsv([
        'Alice,PERSON,alice@example.com,Note for Alice,3',
        'Bob,PERSON,bob@example.com,Note for Bob,4',
      ]);

      const result = await service.processImport(
        jobId,
        'user-1',
        csv,
        BASE_CONFIG,
      );

      expect(result.stats.profileCount).toBe(2);
      expect(result.stats.memoryCount).toBe(2);
      expect(result.stats.errorCount).toBe(0);
    });
  });

  // ── Bad rows skipped, good rows processed ─────────────────────────────────

  describe('bad row handling', () => {
    it('skips rows with missing name, processes others', async () => {
      const { jobId } = jobService.createJob('user-1');

      const profiles: any[] = [];
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const fakeTx = {
          entityProfile: {
            create: jest.fn().mockImplementation((args: any) => {
              profiles.push(args.data);
              return { id: 'profile-x', ...args.data };
            }),
          },
          entityAttribute: {
            createMany: jest.fn().mockResolvedValue({ count: 0 }),
          },
          memory: { create: jest.fn().mockResolvedValue({ id: 'mem-x' }) },
          entityProfileMemory: { create: jest.fn().mockResolvedValue({}) },
        };
        return fn(fakeTx);
      });

      // Row 2 has missing name (empty), Row 3 is valid
      const csv = buildCsv([
        ',PERSON,no-name@example.com,Note,3',
        'Charlie,PERSON,charlie@example.com,Note for Charlie,2',
      ]);

      const result = await service.processImport(
        jobId,
        'user-1',
        csv,
        BASE_CONFIG,
      );

      expect(profiles).toHaveLength(1);
      expect(profiles[0].name).toBe('Charlie');
      expect(result.stats.profileCount).toBe(1);
      expect(result.stats.errorCount).toBeGreaterThan(0);
    });

    it('continues processing after a DB error on one row', async () => {
      const { jobId } = jobService.createJob('user-1');

      let callCount = 0;
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        callCount++;
        if (callCount === 1) throw new Error('DB constraint violation');

        const fakeTx = {
          entityProfile: {
            create: jest.fn().mockResolvedValue({ id: 'profile-2' }),
          },
          entityAttribute: {
            createMany: jest.fn().mockResolvedValue({ count: 0 }),
          },
          memory: { create: jest.fn().mockResolvedValue({ id: 'mem-2' }) },
          entityProfileMemory: { create: jest.fn().mockResolvedValue({}) },
        };
        return fn(fakeTx);
      });

      const csv = buildCsv([
        'Alice,PERSON,alice@example.com,Note,3',
        'Bob,PERSON,bob@example.com,Note for Bob,3',
      ]);

      const result = await service.processImport(
        jobId,
        'user-1',
        csv,
        BASE_CONFIG,
      );

      expect(result.stats.profileCount).toBe(1);
      expect(result.stats.errorCount).toBe(1);
    });
  });

  // ── Job status tracking ────────────────────────────────────────────────────

  describe('job status tracking', () => {
    it('marks job as COMPLETED after successful processing', async () => {
      const { jobId } = jobService.createJob('user-1');

      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const fakeTx = {
          entityProfile: { create: jest.fn().mockResolvedValue({ id: 'p1' }) },
          entityAttribute: {
            createMany: jest.fn().mockResolvedValue({ count: 0 }),
          },
          memory: { create: jest.fn().mockResolvedValue({ id: 'm1' }) },
          entityProfileMemory: { create: jest.fn().mockResolvedValue({}) },
        };
        return fn(fakeTx);
      });

      const csv = buildCsv(['Dave,PERSON,dave@example.com,Note,3']);
      await service.processImport(jobId, 'user-1', csv, BASE_CONFIG);

      const job = jobService.getJob(jobId);
      expect(job.status).toBe('COMPLETED');
      expect(job.progress).toBe(1);
    });

    it('reports progress incrementally (multiple update calls for >10 rows)', async () => {
      const { jobId } = jobService.createJob('user-1');
      const progressValues: number[] = [];

      const spy = jest
        .spyOn(jobService, 'updateProgress')
        .mockImplementation((_id: string, progress: number) => {
          progressValues.push(progress);
        });

      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        const fakeTx = {
          entityProfile: { create: jest.fn().mockResolvedValue({ id: 'px' }) },
          entityAttribute: {
            createMany: jest.fn().mockResolvedValue({ count: 0 }),
          },
          memory: { create: jest.fn().mockResolvedValue({ id: 'mx' }) },
          entityProfileMemory: { create: jest.fn().mockResolvedValue({}) },
        };
        return fn(fakeTx);
      });

      // 15 rows → progress updates at index 0, 10, 14
      const rows = Array.from(
        { length: 15 },
        (_, i) => `User${i},PERSON,u${i}@x.com,Note,3`,
      );
      const csv = buildCsv(rows);

      await service.processImport(jobId, 'user-1', csv, BASE_CONFIG);

      expect(progressValues.length).toBeGreaterThan(1);
      spy.mockRestore();
    });
  });

  // ── Missing required fields ────────────────────────────────────────────────

  describe('missing required fields', () => {
    it('reports error for rows missing required name column', async () => {
      const { jobId } = jobService.createJob('user-1');

      // No DB calls expected for this row (it gets skipped)
      mockPrisma.$transaction.mockResolvedValue(undefined);

      const csv = buildCsv([',,missing@example.com,Note,3']);
      const result = await service.processImport(
        jobId,
        'user-1',
        csv,
        BASE_CONFIG,
      );

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].message).toMatch(/required/i);
    });
  });
});

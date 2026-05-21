import { Test, TestingModule } from '@nestjs/testing';
import { DreamCycleRunTrackerService } from './dream-cycle-run-tracker.service';
import { ServicePrismaService } from '../prisma/service-prisma.service';

const mockRecord = {
  id: 'stage-run-1',
  runId: 'dc-123-abcd1234',
  stage: 'PENDING',
  status: 'STARTED',
  totalRows: 50,
};

const mockPrisma = {
  dreamCycleStageRun: {
    create: jest.fn().mockResolvedValue(mockRecord),
    update: jest.fn().mockResolvedValue({}),
  },
  memory: {
    count: jest.fn().mockResolvedValue(42),
  },
};

describe('DreamCycleRunTrackerService', () => {
  let service: DreamCycleRunTrackerService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DreamCycleRunTrackerService,
        { provide: ServicePrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<DreamCycleRunTrackerService>(
      DreamCycleRunTrackerService,
    );
  });

  describe('startStage', () => {
    it('should create a stage run record and return StageRunRecord', async () => {
      const result = await service.startStage('dc-123', 'PENDING', 50);
      expect(result).toEqual({
        id: 'stage-run-1',
        runId: 'dc-123-abcd1234',
        stage: 'PENDING',
      });
    });

    it('should call prisma.dreamCycleStageRun.create with STARTED status', async () => {
      await service.startStage('run-1', 'TIERING');
      expect(mockPrisma.dreamCycleStageRun.create).toHaveBeenCalledWith({
        data: {
          runId: 'run-1',
          stage: 'TIERING',
          status: 'STARTED',
          totalRows: undefined,
        },
      });
    });

    it('should pass totalRows when provided', async () => {
      await service.startStage('run-1', 'PATTERNS', 100);
      expect(mockPrisma.dreamCycleStageRun.create).toHaveBeenCalledWith({
        data: {
          runId: 'run-1',
          stage: 'PATTERNS',
          status: 'STARTED',
          totalRows: 100,
        },
      });
    });

    it('should propagate database errors', async () => {
      mockPrisma.dreamCycleStageRun.create.mockRejectedValueOnce(
        new Error('DB error'),
      );
      await expect(service.startStage('run-1', 'PENDING')).rejects.toThrow(
        'DB error',
      );
    });
  });

  describe('completeStage', () => {
    it('should update the stage run to COMPLETED status', async () => {
      const startedAt = new Date(Date.now() - 1000);
      await service.completeStage('stage-run-1', 25, startedAt);
      const call = mockPrisma.dreamCycleStageRun.update.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'stage-run-1' });
      expect(call.data.status).toBe('COMPLETED');
      expect(call.data.rowsTouched).toBe(25);
    });

    it('should compute positive durationMs', async () => {
      const startedAt = new Date(Date.now() - 500);
      await service.completeStage('stage-run-1', 10, startedAt);
      const call = mockPrisma.dreamCycleStageRun.update.mock.calls[0][0];
      expect(call.data.durationMs).toBeGreaterThan(0);
    });

    it('should set finishedAt to a date', async () => {
      const startedAt = new Date();
      await service.completeStage('stage-run-1', 0, startedAt);
      const call = mockPrisma.dreamCycleStageRun.update.mock.calls[0][0];
      expect(call.data.finishedAt).toBeInstanceOf(Date);
    });
  });

  describe('abortStage', () => {
    it('should update stage to ABORTED with reason truncated to 500 chars', async () => {
      const longReason = 'x'.repeat(600);
      const startedAt = new Date();
      await service.abortStage('stage-1', 5, 100, longReason, startedAt);
      const call = mockPrisma.dreamCycleStageRun.update.mock.calls[0][0];
      expect(call.data.status).toBe('ABORTED');
      expect(call.data.errorMsg.length).toBe(500);
    });

    it('should record rowsTouched and totalRows', async () => {
      const startedAt = new Date();
      await service.abortStage('stage-1', 10, 50, 'reason', startedAt);
      const call = mockPrisma.dreamCycleStageRun.update.mock.calls[0][0];
      expect(call.data.rowsTouched).toBe(10);
      expect(call.data.totalRows).toBe(50);
    });

    it('should not truncate reason under 500 chars', async () => {
      const reason = 'Short reason';
      const startedAt = new Date();
      await service.abortStage('stage-1', 0, 0, reason, startedAt);
      const call = mockPrisma.dreamCycleStageRun.update.mock.calls[0][0];
      expect(call.data.errorMsg).toBe('Short reason');
    });
  });

  describe('errorStage', () => {
    it('should update stage to ERROR with error message', async () => {
      const error = new Error('Something exploded');
      const startedAt = new Date();
      await service.errorStage('stage-1', error, startedAt);
      const call = mockPrisma.dreamCycleStageRun.update.mock.calls[0][0];
      expect(call.data.status).toBe('ERROR');
      expect(call.data.errorMsg).toBe('Something exploded');
    });

    it('should truncate error messages over 500 chars', async () => {
      const error = new Error('e'.repeat(600));
      await service.errorStage('stage-1', error, new Date());
      const call = mockPrisma.dreamCycleStageRun.update.mock.calls[0][0];
      expect(call.data.errorMsg.length).toBe(500);
    });

    it('should set finishedAt', async () => {
      await service.errorStage('stage-1', new Error('err'), new Date());
      const call = mockPrisma.dreamCycleStageRun.update.mock.calls[0][0];
      expect(call.data.finishedAt).toBeInstanceOf(Date);
    });
  });

  describe('getTotalMemoryCount', () => {
    it('should return total memory count without userId filter', async () => {
      const count = await service.getTotalMemoryCount();
      expect(count).toBe(42);
      expect(mockPrisma.memory.count).toHaveBeenCalledWith({
        where: { deletedAt: null },
      });
    });

    it('should filter by userId when provided', async () => {
      await service.getTotalMemoryCount('user-xyz');
      expect(mockPrisma.memory.count).toHaveBeenCalledWith({
        where: { deletedAt: null, userId: 'user-xyz' },
      });
    });

    it('should return 0 when no memories exist', async () => {
      mockPrisma.memory.count.mockResolvedValueOnce(0);
      const count = await service.getTotalMemoryCount();
      expect(count).toBe(0);
    });
  });
});

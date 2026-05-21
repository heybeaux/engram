import { Test, TestingModule } from '@nestjs/testing';
import { TrajectoryFeedbackService } from './feedback.service';
import { PrismaService } from '../../prisma/prisma.service';

describe('TrajectoryFeedbackService', () => {
  let service: TrajectoryFeedbackService;
  let mockPrisma: {
    memory: {
      updateMany: jest.Mock;
    };
  };

  beforeEach(async () => {
    mockPrisma = {
      memory: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TrajectoryFeedbackService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<TrajectoryFeedbackService>(TrajectoryFeedbackService);
    jest.clearAllMocks();
  });

  it('increments usedCount for usedMemoryIds', async () => {
    mockPrisma.memory.updateMany.mockResolvedValue({ count: 2 });

    const result = await service.processFeedback({
      recallId: 'recall-1',
      usedMemoryIds: ['mem-1', 'mem-2'],
    });

    expect(mockPrisma.memory.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['mem-1', 'mem-2'] }, deletedAt: null },
      data: {
        usedCount: { increment: 1 },
        lastUsedAt: expect.any(Date),
      },
    });
    expect(result.updated).toBe(2);
    expect(result.recallId).toBe('recall-1');
  });

  it('increments unusedCount for unusedMemoryIds', async () => {
    mockPrisma.memory.updateMany
      .mockResolvedValueOnce({ count: 1 }) // usedMemoryIds
      .mockResolvedValueOnce({ count: 2 }); // unusedMemoryIds

    const result = await service.processFeedback({
      recallId: 'recall-2',
      usedMemoryIds: ['mem-1'],
      unusedMemoryIds: ['mem-3', 'mem-4'],
    });

    expect(mockPrisma.memory.updateMany).toHaveBeenCalledTimes(2);
    expect(mockPrisma.memory.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['mem-3', 'mem-4'] }, deletedAt: null },
      data: {
        unusedCount: { increment: 1 },
      },
    });
    expect(result.updated).toBe(3);
    expect(result.recallId).toBe('recall-2');
  });

  it('returns correct updated count', async () => {
    mockPrisma.memory.updateMany.mockResolvedValue({ count: 5 });

    const result = await service.processFeedback({
      recallId: 'recall-3',
      usedMemoryIds: ['m1', 'm2', 'm3', 'm4', 'm5'],
    });

    expect(result.updated).toBe(5);
  });

  it('handles empty usedMemoryIds gracefully', async () => {
    const result = await service.processFeedback({
      recallId: 'recall-4',
      usedMemoryIds: [],
    });

    expect(mockPrisma.memory.updateMany).not.toHaveBeenCalled();
    expect(result.updated).toBe(0);
    expect(result.recallId).toBe('recall-4');
  });

  it('handles empty unusedMemoryIds gracefully', async () => {
    mockPrisma.memory.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.processFeedback({
      recallId: 'recall-5',
      usedMemoryIds: ['mem-1'],
      unusedMemoryIds: [],
    });

    expect(mockPrisma.memory.updateMany).toHaveBeenCalledTimes(1);
    expect(result.updated).toBe(1);
  });
});

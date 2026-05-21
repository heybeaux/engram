import { Test, TestingModule } from '@nestjs/testing';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';

describe('AnalyticsController', () => {
  let controller: AnalyticsController;
  let service: jest.Mocked<AnalyticsService>;

  const agent = { id: 'agent-1', accountId: 'acc-1' };

  beforeEach(async () => {
    const mockService = {
      getTimeline: jest.fn(),
      getTypeBreakdown: jest.fn(),
      getLayerDistribution: jest.fn(),
      getSummary: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AnalyticsController],
      providers: [{ provide: AnalyticsService, useValue: mockService }],
    })
      .overrideGuard(ApiKeyOrJwtGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<AnalyticsController>(AnalyticsController);
    service = module.get(AnalyticsService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('GET /timeline', () => {
    it('should return timeline data', async () => {
      const timeline = { data: [{ date: '2026-01-01', count: 10 }] };
      service.getTimeline.mockResolvedValue(timeline as any);

      const dto = { granularity: 'day' } as any;
      const result = await controller.getTimeline(agent, dto);
      expect(result).toEqual(timeline);
      expect(service.getTimeline).toHaveBeenCalledWith('agent-1', dto);
    });

    it('should propagate service errors', async () => {
      service.getTimeline.mockRejectedValue(new Error('Query failed'));
      await expect(controller.getTimeline(agent, {} as any)).rejects.toThrow(
        'Query failed',
      );
    });
  });

  describe('GET /breakdown/type', () => {
    it('should return type breakdown', async () => {
      const breakdown = { data: [{ type: 'EPISODIC', count: 50 }] };
      service.getTypeBreakdown.mockResolvedValue(breakdown as any);

      const dto = { days: 30 } as any;
      const result = await controller.getTypeBreakdown(agent, dto);
      expect(result).toEqual(breakdown);
      expect(service.getTypeBreakdown).toHaveBeenCalledWith('agent-1', dto);
    });
  });

  describe('GET /breakdown/layer', () => {
    it('should return layer breakdown', async () => {
      const distribution = { data: [{ layer: 'L1', count: 30 }] };
      service.getLayerDistribution.mockResolvedValue(distribution as any);

      const dto = { days: 7 } as any;
      const result = await controller.getLayerBreakdown(agent, dto);
      expect(result).toEqual(distribution);
      expect(service.getLayerDistribution).toHaveBeenCalledWith('agent-1', dto);
    });

    it('should propagate service errors', async () => {
      service.getLayerDistribution.mockRejectedValue(new Error('DB error'));
      await expect(
        controller.getLayerBreakdown(agent, {} as any),
      ).rejects.toThrow('DB error');
    });
  });

  describe('GET /summary', () => {
    it('should return analytics summary', async () => {
      const summary = { totalMemories: 500, avgPerDay: 10 };
      service.getSummary.mockResolvedValue(summary as any);

      const result = await controller.getSummary(agent);
      expect(result).toEqual(summary);
      expect(service.getSummary).toHaveBeenCalledWith('agent-1');
    });

    it('should propagate service errors', async () => {
      service.getSummary.mockRejectedValue(new Error('Timeout'));
      await expect(controller.getSummary(agent)).rejects.toThrow('Timeout');
    });
  });
});

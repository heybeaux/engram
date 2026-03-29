import { Test, TestingModule } from '@nestjs/testing';
import { MonitoringController } from './monitoring.controller';
import { MonitoringService } from './monitoring.service';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';

describe('MonitoringController', () => {
  let controller: MonitoringController;
  let service: jest.Mocked<MonitoringService>;

  beforeEach(async () => {
    const mockService = {
      getMetrics: jest.fn(),
      getAlerts: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MonitoringController],
      providers: [{ provide: MonitoringService, useValue: mockService }],
    })
      .overrideGuard(ApiKeyOrJwtGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<MonitoringController>(MonitoringController);
    service = module.get(MonitoringService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('GET /status', () => {
    it('should return monitoring metrics', async () => {
      const metrics = {
        memoryCount: 1000,
        avgResponseTime: 45,
        uptime: 99.9,
      };
      service.getMetrics.mockResolvedValue(metrics as any);

      const result = await controller.getStatus();
      expect(result).toEqual(metrics);
      expect(service.getMetrics).toHaveBeenCalled();
    });

    it('should propagate service errors', async () => {
      service.getMetrics.mockRejectedValue(new Error('Metrics unavailable'));
      await expect(controller.getStatus()).rejects.toThrow('Metrics unavailable');
    });
  });

  describe('GET /alerts', () => {
    it('should return alerts with count', async () => {
      const alerts = [
        { id: 'a1', severity: 'warning', message: 'High latency' },
        { id: 'a2', severity: 'critical', message: 'Memory full' },
      ];
      service.getAlerts.mockResolvedValue(alerts as any);

      const result = await controller.getAlerts();
      expect(result).toEqual({ alerts, count: 2 });
      expect(service.getAlerts).toHaveBeenCalled();
    });

    it('should return empty alerts array', async () => {
      service.getAlerts.mockResolvedValue([]);

      const result = await controller.getAlerts();
      expect(result).toEqual({ alerts: [], count: 0 });
    });

    it('should propagate service errors', async () => {
      service.getAlerts.mockRejectedValue(new Error('DB down'));
      await expect(controller.getAlerts()).rejects.toThrow('DB down');
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { EvalController } from './eval.controller';
import { EvalService } from './eval.service';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';

describe('EvalController', () => {
  let controller: EvalController;
  let service: jest.Mocked<EvalService>;

  beforeEach(async () => {
    const mockService = {
      runEval: jest.fn(),
      getHistory: jest.fn(),
      detectRegression: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [EvalController],
      providers: [{ provide: EvalService, useValue: mockService }],
    })
      .overrideGuard(ApiKeyOrJwtGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<EvalController>(EvalController);
    service = module.get(EvalService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('POST /run', () => {
    it('should run eval with triggeredBy from body', async () => {
      const expected = { runId: 'r1', score: 0.95 };
      service.runEval.mockResolvedValue(expected as any);

      const result = await controller.runEval({ triggeredBy: 'ci' });
      expect(result).toEqual(expected);
      expect(service.runEval).toHaveBeenCalledWith('ci');
    });

    it('should default triggeredBy to api when body is empty', async () => {
      service.runEval.mockResolvedValue({} as any);

      await controller.runEval();
      expect(service.runEval).toHaveBeenCalledWith('api');
    });

    it('should default triggeredBy to api when triggeredBy is undefined', async () => {
      service.runEval.mockResolvedValue({} as any);

      await controller.runEval({});
      expect(service.runEval).toHaveBeenCalledWith('api');
    });

    it('should propagate service errors', async () => {
      service.runEval.mockRejectedValue(new Error('Eval failed'));
      await expect(controller.runEval()).rejects.toThrow('Eval failed');
    });
  });

  describe('GET /history', () => {
    it('should return history with default limit', async () => {
      const history = [{ runId: 'r1', score: 0.9 }];
      service.getHistory.mockResolvedValue(history as any);

      const result = await controller.getHistory();
      expect(result).toEqual(history);
      expect(service.getHistory).toHaveBeenCalledWith(20);
    });

    it('should parse custom limit', async () => {
      service.getHistory.mockResolvedValue([]);

      await controller.getHistory('5');
      expect(service.getHistory).toHaveBeenCalledWith(5);
    });
  });

  describe('GET /regression', () => {
    it('should return regression detection result', async () => {
      const expected = { hasRegression: false, baseline: 0.95, current: 0.94 };
      service.detectRegression.mockResolvedValue(expected as any);

      const result = await controller.detectRegression();
      expect(result).toEqual(expected);
      expect(service.detectRegression).toHaveBeenCalled();
    });

    it('should propagate service errors', async () => {
      service.detectRegression.mockRejectedValue(new Error('No baseline'));
      await expect(controller.detectRegression()).rejects.toThrow('No baseline');
    });
  });
});

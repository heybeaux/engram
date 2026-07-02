import { Test, TestingModule } from '@nestjs/testing';
import { DelegationLedgerController } from './delegation-ledger.controller';
import { DelegationLedgerService } from './delegation-ledger.service';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';

describe('DelegationLedgerController', () => {
  let controller: DelegationLedgerController;
  let service: any;

  beforeEach(async () => {
    service = {
      recordEvent: jest.fn().mockResolvedValue({ id: 'event-1' }),
      recordValidation: jest.fn().mockResolvedValue({ id: 'validation-1' }),
      attachReceipt: jest.fn().mockResolvedValue({ id: 'receipt-row-1' }),
      getTaskTrustReport: jest
        .fn()
        .mockResolvedValue({ task: { id: 'task-1' } }),
      getAgentTrustReports: jest.fn().mockResolvedValue({ agentId: 'rook' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DelegationLedgerController],
      providers: [{ provide: DelegationLedgerService, useValue: service }],
    })
      .overrideGuard(ApiKeyOrJwtGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(DelegationLedgerController);
  });

  it('records generic AOP/Sonder-compatible lifecycle events', async () => {
    const dto = {
      eventType: 'AOP_EVENT_RECORDED' as const,
      source: 'SONDER' as const,
      taskId: 'task-1',
      traceId: 'trace-1',
      payload: { memory: { refs: ['mem_1'] } },
    };

    const result = await controller.recordEvent('user-1', dto);

    expect(service.recordEvent).toHaveBeenCalledWith('user-1', dto);
    expect(result).toEqual({ id: 'event-1' });
  });

  it('records Lattice validation evidence for a delegation contract', async () => {
    const dto = {
      stateContract: { id: 'lat_1' },
      validationResult: { passed: true, tier: 'L0+L1' },
      taskId: 'task-1',
    };

    await controller.recordValidation('user-1', 'contract-1', dto);

    expect(service.recordValidation).toHaveBeenCalledWith(
      'user-1',
      'contract-1',
      dto,
    );
  });

  it('attaches receipt proof-of-work to a task', async () => {
    const dto = { receipt: { id: 'rcpt_1', status: 'needs-review' } };

    await controller.attachReceipt('user-1', 'task-1', dto);

    expect(service.attachReceipt).toHaveBeenCalledWith('user-1', 'task-1', dto);
  });

  it('returns a task trust report', async () => {
    await controller.taskTrustReport('user-1', 'task-1');

    expect(service.getTaskTrustReport).toHaveBeenCalledWith('user-1', 'task-1');
  });

  it('returns agent trust reports', async () => {
    await controller.agentTrustReports('user-1', 'rook');

    expect(service.getAgentTrustReports).toHaveBeenCalledWith('user-1', 'rook');
  });
});

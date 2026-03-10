import { BadRequestException } from '@nestjs/common';
import {
  CloudSyncController,
  ReconciliationController,
  SyncIngestController,
} from './cloud-sync.controller';
import { CloudSyncService } from './cloud-sync.service';
import { SyncReconciliationService } from './sync-reconciliation.service';

describe('CloudSyncController', () => {
  let controller: CloudSyncController;
  let cloudSyncService: jest.Mocked<CloudSyncService>;
  let reconciliationService: jest.Mocked<SyncReconciliationService>;

  const mockReq = { accountId: 'acct-1' };

  beforeEach(() => {
    jest.clearAllMocks();

    cloudSyncService = {
      triggerSync: jest.fn(),
      getSyncStatus: jest.fn(),
      cancelSync: jest.fn(),
      setAutoSync: jest.fn(),
      getSyncHistory: jest.fn(),
      triggerPull: jest.fn(),
      handleSyncPush: jest.fn(),
      handleSyncPull: jest.fn(),
      getInstances: jest.fn(),
    } as any;

    reconciliationService = {
      reconcile: jest.fn(),
      executeReconciliation: jest.fn(),
    } as any;

    controller = new CloudSyncController(
      cloudSyncService,
      reconciliationService,
    );
  });

  describe('sync', () => {
    it('should trigger sync for the account', async () => {
      cloudSyncService.triggerSync.mockResolvedValue({ started: true } as any);
      const result = await controller.sync(mockReq);
      expect(cloudSyncService.triggerSync).toHaveBeenCalledWith('acct-1');
      expect(result).toEqual({ started: true });
    });
  });

  describe('status', () => {
    it('should return sync status', async () => {
      const status = { inProgress: false, lastSync: '2026-03-07' };
      cloudSyncService.getSyncStatus.mockResolvedValue(status as any);
      const result = await controller.status(mockReq);
      expect(result).toEqual(status);
    });
  });

  describe('cancelSync', () => {
    it('should cancel sync and return confirmation', async () => {
      const result = await controller.cancelSync();
      expect(cloudSyncService.cancelSync).toHaveBeenCalled();
      expect(result).toEqual({ cancelled: true });
    });
  });

  describe('setAutoSync', () => {
    it('should enable auto-sync', async () => {
      const result = await controller.setAutoSync(mockReq, { enabled: true });
      expect(cloudSyncService.setAutoSync).toHaveBeenCalledWith('acct-1', true);
      expect(result).toEqual({ autoSync: true });
    });

    it('should disable auto-sync', async () => {
      const result = await controller.setAutoSync(mockReq, { enabled: false });
      expect(cloudSyncService.setAutoSync).toHaveBeenCalledWith(
        'acct-1',
        false,
      );
      expect(result).toEqual({ autoSync: false });
    });
  });

  describe('history', () => {
    it('should return sync history with limit 10', async () => {
      const history = [{ id: '1', status: 'completed' }];
      cloudSyncService.getSyncHistory.mockResolvedValue(history as any);
      const result = await controller.history(mockReq);
      expect(cloudSyncService.getSyncHistory).toHaveBeenCalledWith(
        'acct-1',
        10,
      );
      expect(result).toEqual(history);
    });
  });

  describe('pull', () => {
    it('should trigger pull for the account', async () => {
      cloudSyncService.triggerPull.mockResolvedValue({ pulled: 5 } as any);
      const result = await controller.pull(mockReq);
      expect(cloudSyncService.triggerPull).toHaveBeenCalledWith('acct-1');
      expect(result).toEqual({ pulled: 5 });
    });
  });
});

describe('ReconciliationController', () => {
  let controller: ReconciliationController;
  let reconciliationService: jest.Mocked<SyncReconciliationService>;

  const mockReq = { accountId: 'acct-1' };

  beforeEach(() => {
    jest.clearAllMocks();
    reconciliationService = {
      reconcile: jest.fn(),
      executeReconciliation: jest.fn(),
    } as any;
    controller = new ReconciliationController(reconciliationService);
  });

  describe('preview', () => {
    it('should return reconciliation preview', async () => {
      const plan = { additions: 3, deletions: 1 };
      reconciliationService.reconcile.mockResolvedValue(plan as any);
      const result = await controller.preview(mockReq);
      expect(reconciliationService.reconcile).toHaveBeenCalledWith('acct-1');
      expect(result).toEqual(plan);
    });
  });

  describe('execute', () => {
    it('should reconcile then execute the plan', async () => {
      const plan = { additions: 3, deletions: 1 };
      const execResult = { applied: true, changes: 4 };
      reconciliationService.reconcile.mockResolvedValue(plan as any);
      reconciliationService.executeReconciliation.mockResolvedValue(
        execResult as any,
      );

      const result = await controller.execute(mockReq);

      expect(reconciliationService.reconcile).toHaveBeenCalledWith('acct-1');
      expect(reconciliationService.executeReconciliation).toHaveBeenCalledWith(
        'acct-1',
        plan,
      );
      expect(result).toEqual(execResult);
    });
  });
});

describe('SyncIngestController', () => {
  let controller: SyncIngestController;
  let cloudSyncService: jest.Mocked<CloudSyncService>;

  const mockReq = { accountId: 'acct-1', instanceId: 'inst-1' };

  beforeEach(() => {
    jest.clearAllMocks();
    cloudSyncService = {
      handleSyncPush: jest.fn(),
      handleSyncPull: jest.fn(),
      getInstances: jest.fn(),
    } as any;
    controller = new SyncIngestController(cloudSyncService);
  });

  describe('pushBatch', () => {
    it('should push memories to cloud', async () => {
      const dto = { memories: [{ id: 'm1', raw: 'test' }] };
      const pushResult = { received: 1, created: 1, updated: 0 };
      cloudSyncService.handleSyncPush.mockResolvedValue(pushResult as any);

      const result = await controller.pushBatch(dto as any, mockReq);

      expect(cloudSyncService.handleSyncPush).toHaveBeenCalledWith(
        'acct-1',
        'inst-1',
        dto,
      );
      expect(result).toEqual(pushResult);
    });

    it('should accept sync protocol version 1', async () => {
      const dto = {
        memories: [],
        syncProtocolVersion: 1,
      };
      cloudSyncService.handleSyncPush.mockResolvedValue({} as any);
      await expect(
        controller.pushBatch(dto as any, mockReq),
      ).resolves.toBeDefined();
    });

    it('should accept sync protocol version 2', async () => {
      const dto = {
        memories: [],
        syncProtocolVersion: 2,
      };
      cloudSyncService.handleSyncPush.mockResolvedValue({} as any);
      await expect(
        controller.pushBatch(dto as any, mockReq),
      ).resolves.toBeDefined();
    });

    it('should reject unsupported sync protocol version (>2)', async () => {
      const dto = {
        memories: [],
        syncProtocolVersion: 3,
      };
      await expect(
        controller.pushBatch(dto as any, mockReq),
      ).rejects.toThrow(BadRequestException);
    });

    it('should allow undefined syncProtocolVersion', async () => {
      const dto = { memories: [] };
      cloudSyncService.handleSyncPush.mockResolvedValue({} as any);
      await expect(
        controller.pushBatch(dto as any, mockReq),
      ).resolves.toBeDefined();
    });
  });

  describe('pullBatch', () => {
    it('should pull with provided since and limit', async () => {
      cloudSyncService.handleSyncPull.mockResolvedValue({
        memories: [],
      } as any);

      await controller.pullBatch('2026-03-01T00:00:00Z', '50', mockReq);

      expect(cloudSyncService.handleSyncPull).toHaveBeenCalledWith(
        'acct-1',
        'inst-1',
        new Date('2026-03-01T00:00:00Z'),
        50,
      );
    });

    it('should default to epoch when since is empty', async () => {
      cloudSyncService.handleSyncPull.mockResolvedValue({
        memories: [],
      } as any);

      await controller.pullBatch('', '100', mockReq);

      expect(cloudSyncService.handleSyncPull).toHaveBeenCalledWith(
        'acct-1',
        'inst-1',
        new Date(0),
        100,
      );
    });

    it('should cap limit at 500', async () => {
      cloudSyncService.handleSyncPull.mockResolvedValue({
        memories: [],
      } as any);

      await controller.pullBatch('2026-01-01', '9999', mockReq);

      expect(cloudSyncService.handleSyncPull).toHaveBeenCalledWith(
        'acct-1',
        'inst-1',
        expect.any(Date),
        500,
      );
    });

    it('should default limit to 100 when not provided', async () => {
      cloudSyncService.handleSyncPull.mockResolvedValue({
        memories: [],
      } as any);

      await controller.pullBatch('2026-01-01', undefined as any, mockReq);

      expect(cloudSyncService.handleSyncPull).toHaveBeenCalledWith(
        'acct-1',
        'inst-1',
        expect.any(Date),
        100,
      );
    });
  });

  describe('listInstances', () => {
    it('should return instances for the account', async () => {
      const instances = [{ id: 'inst-1', name: 'local' }];
      cloudSyncService.getInstances.mockResolvedValue(instances as any);

      const result = await controller.listInstances(mockReq);

      expect(cloudSyncService.getInstances).toHaveBeenCalledWith('acct-1');
      expect(result).toEqual(instances);
    });
  });
});

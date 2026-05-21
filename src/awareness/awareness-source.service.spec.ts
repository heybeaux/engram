import { AwarenessSourceService } from './awareness-source.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AwarenessSourceService', () => {
  let service: AwarenessSourceService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      awarenessState: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    service = new AwarenessSourceService(prisma as unknown as PrismaService);
    await service.onModuleInit();
  });

  it('should create a source', async () => {
    const result = await service.create({ name: 'Linear', type: 'linear' });
    expect(result.id).toBeDefined();
    expect(result.name).toBe('Linear');
    expect(result.enabled).toBe(true);
    expect(prisma.awarenessState.upsert).toHaveBeenCalled();
  });

  it('should list sources', async () => {
    await service.create({ name: 'S1', type: 'github' });
    await service.create({ name: 'S2', type: 'memory' });
    expect(service.listAll()).toHaveLength(2);
  });

  it('should get by id', async () => {
    const created = await service.create({ name: 'S3', type: 'linear' });
    expect(service.getById(created.id).name).toBe('S3');
  });

  it('should update a source', async () => {
    const created = await service.create({ name: 'S4', type: 'linear' });
    const updated = await service.update(created.id, { enabled: false });
    expect(updated.enabled).toBe(false);
    // upsert called twice: once for create, once for update
    expect(prisma.awarenessState.upsert).toHaveBeenCalledTimes(2);
  });

  it('should delete a source', async () => {
    const created = await service.create({ name: 'S5', type: 'custom' });
    expect((await service.delete(created.id)).deleted).toBe(true);
    expect(() => service.getById(created.id)).toThrow();
    expect(prisma.awarenessState.deleteMany).toHaveBeenCalled();
  });

  it('should load sources from DB on init', async () => {
    const storedSource = {
      id: 'existing-id',
      name: 'Persisted',
      type: 'github',
      enabled: true,
      config: {},
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    };

    prisma.awarenessState.findMany.mockResolvedValue([
      {
        id: 'row-1',
        accountId: 'system',
        signalSource: 'source:existing-id',
        checkpoint: storedSource,
      },
    ]);

    const freshService = new AwarenessSourceService(
      prisma as unknown as PrismaService,
    );
    await freshService.onModuleInit();

    const loaded = freshService.getById('existing-id');
    expect(loaded.name).toBe('Persisted');
    expect(loaded.createdAt).toBeInstanceOf(Date);
  });

  it('should not crash on init when DB connection fails (ENG-78)', async () => {
    prisma.awarenessState.findMany.mockRejectedValue(
      new Error('Connection refused'),
    );

    const freshService = new AwarenessSourceService(
      prisma as unknown as PrismaService,
    );
    // Should not throw — try/catch in onModuleInit handles the error
    await expect(freshService.onModuleInit()).resolves.not.toThrow();
    expect(freshService.listAll()).toEqual([]);
  });
});

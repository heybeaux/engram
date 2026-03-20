import { Test, TestingModule } from '@nestjs/testing';
import {
  SyncReconciliationService,
  ReconciliationPlan,
} from './sync-reconciliation.service';
import { PrismaService } from '../prisma/prisma.service';
import { CloudLinkService } from '../cloud-link/cloud-link.service';
import { CloudLinkAuthService } from '../cloud-link/cloud-link-auth.service';
import { CloudLinkMappingService } from '../cloud-link/cloud-link-mapping.service';

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

// Mock encryption
jest.mock('../common/encryption.util', () => ({
  encrypt: (text: string) => `encrypted:${text}`,
  decrypt: (text: string) => text.replace('encrypted:', ''),
}));

describe('SyncReconciliationService', () => {
  let service: SyncReconciliationService;
  let prisma: any;
  let cloudLinkService: any;

  const mockCloudLink = {
    id: 'link-1',
    accountId: 'account-1',
    instanceId: 'instance-uuid',
    cloudApiKey: 'encrypted:eng_test_key',
    cloudSyncKey: null,
    cloudAccountId: 'cloud-account-1',
    autoSync: false,
    lastPulledAt: null,
  };

  beforeEach(async () => {
    prisma = {
      cloudLink: {
        findUnique: jest.fn().mockResolvedValue(mockCloudLink),
      },
      memory: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockImplementation(({ data }) => ({
          id: `new-${Date.now()}`,
          ...data,
        })),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      user: {
        findFirst: jest.fn().mockResolvedValue({ id: 'user-1' }),
      },
      syncEvent: {
        create: jest.fn().mockResolvedValue({}),
      },
    };

    cloudLinkService = {
      getStatus: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SyncReconciliationService,
        { provide: PrismaService, useValue: prisma },
        { provide: CloudLinkService, useValue: cloudLinkService },
      ],
    }).compile();

    service = module.get<SyncReconciliationService>(SyncReconciliationService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('reconcile', () => {
    it('should identify local-only, cloud-only, and shared memories', async () => {
      // Local memories
      prisma.memory.findMany.mockResolvedValue([
        {
          id: 'local-1',
          raw: 'shared memory',
          contentHash: 'hash-shared',
          layer: 'SEMANTIC',
          createdAt: new Date(),
        },
        {
          id: 'local-2',
          raw: 'local only memory',
          contentHash: 'hash-local',
          layer: 'SEMANTIC',
          createdAt: new Date(),
        },
      ]);

      // Cloud returns shared + cloud-only via pull endpoint
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          memories: [
            {
              cloudId: 'cloud-1',
              raw: 'shared memory',
              contentHash: 'hash-shared',
              layer: 'SEMANTIC',
              createdAt: '2024-01-01T00:00:00Z',
              updatedAt: '2024-01-01T00:00:00Z',
              deletedAt: null,
            },
            {
              cloudId: 'cloud-2',
              raw: 'cloud only memory',
              contentHash: 'hash-cloud',
              layer: 'SEMANTIC',
              createdAt: '2024-01-01T00:00:00Z',
              updatedAt: '2024-01-02T00:00:00Z',
              deletedAt: null,
            },
          ],
          hasMore: false,
        }),
      });

      const plan = await service.reconcile('account-1');

      expect(plan.summary.localOnlyCount).toBe(1);
      expect(plan.summary.cloudOnlyCount).toBe(1);
      expect(plan.summary.sharedCount).toBe(1);
      expect(plan.localOnly[0].contentHash).toBe('hash-local');
      expect(plan.cloudOnly[0].contentHash).toBe('hash-cloud');
      expect(plan.shared[0].contentHash).toBe('hash-shared');
    });

    it('should handle empty cloud (all local-only)', async () => {
      prisma.memory.findMany.mockResolvedValue([
        {
          id: 'local-1',
          raw: 'mem 1',
          contentHash: 'hash-1',
          layer: 'SEMANTIC',
          createdAt: new Date(),
        },
      ]);

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ memories: [], hasMore: false }),
      });

      const plan = await service.reconcile('account-1');
      expect(plan.summary.localOnlyCount).toBe(1);
      expect(plan.summary.cloudOnlyCount).toBe(0);
      expect(plan.summary.sharedCount).toBe(0);
    });

    it('should handle empty local (all cloud-only)', async () => {
      prisma.memory.findMany.mockResolvedValue([]);

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          memories: [
            {
              cloudId: 'c-1',
              raw: 'cloud mem',
              contentHash: 'hash-c1',
              layer: 'SEMANTIC',
              createdAt: '2024-01-01T00:00:00Z',
              updatedAt: '2024-01-01T00:00:00Z',
              deletedAt: null,
            },
          ],
          hasMore: false,
        }),
      });

      const plan = await service.reconcile('account-1');
      expect(plan.summary.localOnlyCount).toBe(0);
      expect(plan.summary.cloudOnlyCount).toBe(1);
      expect(plan.summary.sharedCount).toBe(0);
    });
  });

  describe('executeReconciliation', () => {
    it('should push local-only and pull cloud-only memories', async () => {
      const plan: ReconciliationPlan = {
        localOnly: [
          {
            contentHash: 'hash-local',
            raw: 'local mem',
            localId: 'local-1',
            layer: 'SEMANTIC',
            createdAt: '2024-01-01T00:00:00Z',
          },
        ],
        cloudOnly: [
          {
            contentHash: 'hash-cloud',
            raw: 'cloud mem',
            cloudId: 'cloud-1',
            layer: 'SEMANTIC',
            createdAt: '2024-01-01T00:00:00Z',
          },
        ],
        shared: [
          {
            contentHash: 'hash-shared',
            raw: 'shared',
            localId: 'local-2',
            cloudId: 'cloud-2',
          },
        ],
        summary: {
          localOnlyCount: 1,
          cloudOnlyCount: 1,
          sharedCount: 1,
          totalLocal: 2,
          totalCloud: 2,
          wouldPush: 1,
          wouldPull: 1,
          alreadySynced: 1,
        },
      };

      // Mock local memory fetch for push
      prisma.memory.findMany.mockResolvedValue([
        {
          id: 'local-1',
          raw: 'local mem',
          layer: 'SEMANTIC',
          source: 'EXPLICIT_STATEMENT',
          contentHash: 'hash-local',
          importanceScore: 0.5,
          effectiveScore: 0.5,
          priority: 3,
          createdAt: new Date(),
          extraction: null,
          entities: [],
        },
      ]);

      // Mock push response
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            results: [
              {
                sourceMemoryId: 'local-1',
                cloudMemoryId: 'cloud-new-1',
                status: 'created',
              },
            ],
          }),
        })
        // Mock cloud memory fetch for pull
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            raw: 'cloud mem',
            layer: 'SEMANTIC',
            source: 'EXPLICIT_STATEMENT',
            createdAt: '2024-01-01T00:00:00Z',
          }),
        });

      const result = await service.executeReconciliation('account-1', plan);

      expect(result.pushed).toBe(1);
      expect(result.pulled).toBe(1);
      // Shared memories should be marked as synced
      expect(prisma.memory.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['local-2'] } },
        }),
      );
    });

    it('should skip pull when memory already exists locally by hash', async () => {
      const plan: ReconciliationPlan = {
        localOnly: [],
        cloudOnly: [
          {
            contentHash: 'hash-dup',
            raw: 'dup mem',
            cloudId: 'cloud-dup',
            layer: 'SEMANTIC',
          },
        ],
        shared: [],
        summary: {
          localOnlyCount: 0,
          cloudOnlyCount: 1,
          sharedCount: 0,
          totalLocal: 0,
          totalCloud: 1,
          wouldPush: 0,
          wouldPull: 1,
          alreadySynced: 0,
        },
      };

      prisma.memory.findMany.mockResolvedValue([]);
      // Already exists locally
      prisma.memory.findFirst.mockResolvedValue({ id: 'existing-local' });

      const result = await service.executeReconciliation('account-1', plan);
      expect(result.pulled).toBe(0);
      expect(result.skipped).toBe(1);
    });
  });
});

describe('CloudLinkService - identity mapping', () => {
  let prisma: any;
  let linkService: CloudLinkService;
  let mockMappingService: any;

  beforeEach(async () => {
    prisma = {
      cloudLink: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
      },
      memory: {
        count: jest.fn().mockResolvedValue(100),
      },
      syncAgentMap: {
        upsert: jest.fn().mockResolvedValue({}),
      },
      syncUserMap: {
        upsert: jest.fn().mockResolvedValue({}),
      },
      agent: {
        findUnique: jest.fn().mockResolvedValue({ name: 'Rook' }),
      },
    };

    // Auth and sync key are now handled by mockAuthService above.
    // Only need to mock the reconciliation cloud data check fetch.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ memories: [{ cloudId: 'c1' }], hasMore: true }),
    });

    const mockAuthService = {
      CLOUD_API_BASE: 'https://api.openengram.ai',
      validateCloudApiKey: jest.fn().mockResolvedValue({
        id: 'cloud-acct',
        email: 'rook@test.com',
        plan: 'pro',
      }),
      createSyncKey: jest.fn().mockResolvedValue('esync_test'),
      getCloudStatus: jest.fn().mockResolvedValue({ linked: true, plan: 'pro' }),
    };

    mockMappingService = {
      createAgentMapping: jest.fn().mockResolvedValue(undefined),
      createUserMapping: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CloudLinkService,
        { provide: PrismaService, useValue: prisma },
        { provide: CloudLinkAuthService, useValue: mockAuthService },
        { provide: CloudLinkMappingService, useValue: mockMappingService },
      ],
    }).compile();

    linkService = module.get<CloudLinkService>(CloudLinkService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should create agent and user mappings when linking with identity options', async () => {
    const result = await linkService.linkCloud('account-1', 'eng_test_key', {
      localAgentId: 'clawd-agent-001',
      cloudAgentId: 'cmllz86ff',
      localUserId: 'cmlo1r25i',
      cloudUserId: 'cmllzv5cv',
      userExternalId: 'rook-discord',
    });

    expect(result.linked).toBe(true);
    expect(mockMappingService.createAgentMapping).toHaveBeenCalledWith(
      expect.any(String), // instanceId (UUID)
      'clawd-agent-001',
      'cmllz86ff',
    );
    expect(mockMappingService.createUserMapping).toHaveBeenCalledWith(
      expect.any(String), // instanceId (UUID)
      'cmlo1r25i',
      'cmllzv5cv',
      'rook-discord',
    );
    expect(result.reconciliationPreview).toBeDefined();
    expect(result.reconciliationPreview.bothSidesHaveData).toBe(true);
  });
});

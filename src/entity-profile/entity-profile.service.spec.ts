import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { EntityProfileService } from './entity-profile.service';
import { AttachmentPipelineService } from './attachment-pipeline.service';
import { PrismaService } from '../prisma/prisma.service';
import { AttributeType, EntityType } from '@prisma/client';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockTx = {
  entityProfile: {
    create: jest.fn(),
    findUnique: jest.fn(),
  },
  entityAttribute: {
    createMany: jest.fn(),
  },
};

const mockAttachmentPipeline = {
  attachMemory: jest.fn(),
  onMemoryCreated: jest.fn(),
  attachBatch: jest.fn(),
  scanRecentUnattached: jest.fn(),
};

const mockPrisma = {
  agent: { findUnique: jest.fn() },
  user: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
  memory: { findMany: jest.fn() },
  entityProfile: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
  },
  entityAttribute: {
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    createMany: jest.fn(),
  },
  entityProfileMemory: {
    upsert: jest.fn(),
    delete: jest.fn(),
  },
  $transaction: jest.fn((fn) =>
    typeof fn === 'function' ? fn(mockTx) : Promise.all(fn),
  ),
};

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ACCOUNT_ID = 'acc-1';
const AGENT_ID = 'agent-1';
const USER_IDS = ['user-1'];

const baseProfile = {
  id: 'profile-1',
  name: 'Alice',
  type: 'PERSON',
  normalizedName: 'alice',
  description: 'A developer',
  aliases: [],
  tags: [],
  deletedAt: null,
  attributes: [],
  _count: { memories: 0 },
  entity: null,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EntityProfileService', () => {
  let service: EntityProfileService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EntityProfileService,
        { provide: PrismaService, useValue: mockPrisma },
        {
          provide: AttachmentPipelineService,
          useValue: mockAttachmentPipeline,
        },
      ],
    }).compile();

    service = module.get<EntityProfileService>(EntityProfileService);
  });

  // =========================================================================
  // resolveAccountUserIds
  // =========================================================================

  describe('resolveAccountUserIds', () => {
    it('should return user IDs for account', async () => {
      mockPrisma.user.findMany.mockResolvedValue(
        USER_IDS.map((id) => ({ id })),
      );
      const result = await service.resolveAccountUserIds(ACCOUNT_ID);
      expect(result).toEqual(USER_IDS);
      expect(mockPrisma.user.findMany).toHaveBeenCalledWith({
        where: { accountId: ACCOUNT_ID, deletedAt: null },
        select: { id: true },
      });
    });

    it('should return empty array when no users', async () => {
      mockPrisma.user.findMany.mockResolvedValue([]);
      const result = await service.resolveAccountUserIds(ACCOUNT_ID);
      expect(result).toEqual([]);
    });
  });

  // =========================================================================
  // getOrCreateUser
  // =========================================================================

  describe('getOrCreateUser', () => {
    it('should return existing user ID', async () => {
      mockPrisma.agent.findUnique.mockResolvedValue({ accountId: ACCOUNT_ID });
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'user-1' });
      const result = await service.getOrCreateUser(AGENT_ID);
      expect(result).toBe('user-1');
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
    });

    it('should create a user when none exists', async () => {
      mockPrisma.agent.findUnique.mockResolvedValue({ accountId: ACCOUNT_ID });
      mockPrisma.user.findFirst.mockResolvedValue(null);
      mockPrisma.user.create.mockResolvedValue({ id: 'user-new' });

      const result = await service.getOrCreateUser(AGENT_ID);
      expect(result).toBe('user-new');
      expect(mockPrisma.user.create).toHaveBeenCalledWith({
        data: {
          accountId: ACCOUNT_ID,
          externalId: 'entity-profile-default',
          displayName: 'Entity Profiles',
        },
      });
    });
  });

  // =========================================================================
  // create
  // =========================================================================

  describe('create', () => {
    beforeEach(() => {
      mockPrisma.agent.findUnique.mockResolvedValue({ accountId: ACCOUNT_ID });
      mockPrisma.user.findFirst.mockResolvedValue({ id: 'user-1' });
      mockTx.entityProfile.create.mockResolvedValue(baseProfile);
      mockTx.entityProfile.findUnique.mockResolvedValue({
        ...baseProfile,
        attributes: [],
      });
    });

    it('should create a profile with attributes', async () => {
      const dto = {
        name: 'Alice',
        type: EntityType.PERSON,
        description: 'A developer',
        attributes: [
          {
            key: 'role',
            value: 'developer',
            valueType: AttributeType.STRING,
            category: 'work',
          },
        ],
      };

      const result = await service.create(AGENT_ID, dto);
      expect(result).toBeDefined();
      expect(mockTx.entityProfile.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          name: 'Alice',
          normalizedName: 'alice',
          userId: 'user-1',
          source: 'MANUAL',
          verified: true,
        }),
      });
      expect(mockTx.entityAttribute.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            key: 'role',
            value: 'developer',
            profileId: 'profile-1',
            source: 'MANUAL',
            confidence: 1.0,
            verified: true,
          }),
        ],
      });
    });

    it('should create a profile without attributes', async () => {
      const dto = { name: 'Bob', type: EntityType.PERSON };
      await service.create(AGENT_ID, dto);
      expect(mockTx.entityAttribute.createMany).not.toHaveBeenCalled();
    });

    it('should normalize the name to lowercase + trimmed', async () => {
      const dto = { name: '  Bob  ', type: EntityType.PERSON };
      await service.create(AGENT_ID, dto);
      expect(mockTx.entityProfile.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ normalizedName: 'bob' }),
        }),
      );
    });

    it('should default aliases and tags to empty arrays', async () => {
      const dto = { name: 'Carol', type: EntityType.PERSON };
      await service.create(AGENT_ID, dto);
      expect(mockTx.entityProfile.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ aliases: [], tags: [] }),
        }),
      );
    });
  });

  // =========================================================================
  // list
  // =========================================================================

  describe('list', () => {
    beforeEach(() => {
      mockPrisma.user.findMany.mockResolvedValue(
        USER_IDS.map((id) => ({ id })),
      );
    });

    it('should paginate results', async () => {
      mockPrisma.$transaction.mockResolvedValue([[baseProfile], 1]);

      const result = await service.list(ACCOUNT_ID, { page: 1, limit: 10 });
      expect(result.total).toBe(1);
      expect(result.totalPages).toBe(1);
      expect(result.profiles).toHaveLength(1);
    });

    it('should apply type filter', async () => {
      mockPrisma.$transaction.mockResolvedValue([[], 0]);

      await service.list(ACCOUNT_ID, { type: 'PERSON', page: 1, limit: 10 });
      // Verify $transaction was called (passes through the where clause)
      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it('should apply search filter across name, alias, description', async () => {
      mockPrisma.$transaction.mockResolvedValue([[baseProfile], 1]);

      const result = await service.list(ACCOUNT_ID, {
        search: 'ali',
        page: 1,
        limit: 25,
      });
      expect(result.profiles).toHaveLength(1);
    });

    it('should include attributes, tags, and attached memory text in profile search', async () => {
      mockPrisma.$transaction.mockResolvedValue([[baseProfile], 1]);

      await service.list(ACCOUNT_ID, {
        search: 'Powell River',
        page: 1,
        limit: 25,
      });

      const transactionArg = mockPrisma.$transaction.mock.calls[0][0];
      const findManyCall = mockPrisma.entityProfile.findMany.mock.calls[0][0];
      expect(transactionArg).toBeDefined();
      expect(findManyCall.where.OR).toEqual(
        expect.arrayContaining([
          { tags: { hasSome: expect.arrayContaining(['powell river']) } },
          {
            attributes: {
              some: {
                OR: expect.arrayContaining([
                  { value: { contains: 'Powell River', mode: 'insensitive' } },
                ]),
              },
            },
          },
          {
            memories: {
              some: {
                memory: expect.objectContaining({
                  deletedAt: null,
                  raw: { contains: 'Powell River', mode: 'insensitive' },
                }),
              },
            },
          },
        ]),
      );
    });

    it('should return correct pagination metadata', async () => {
      mockPrisma.$transaction.mockResolvedValue([
        [baseProfile, baseProfile],
        50,
      ]);

      const result = await service.list(ACCOUNT_ID, { page: 2, limit: 10 });
      expect(result.page).toBe(2);
      expect(result.limit).toBe(10);
      expect(result.totalPages).toBe(5);
    });
  });

  // =========================================================================
  // getById
  // =========================================================================

  describe('getById', () => {
    beforeEach(() => {
      mockPrisma.user.findMany.mockResolvedValue(
        USER_IDS.map((id) => ({ id })),
      );
    });

    it('should return a profile when found', async () => {
      mockPrisma.entityProfile.findFirst.mockResolvedValue(baseProfile);
      const result = await service.getById(ACCOUNT_ID, 'profile-1');
      expect(result).toEqual(baseProfile);
    });

    it('should throw NotFoundException when profile not found', async () => {
      mockPrisma.entityProfile.findFirst.mockResolvedValue(null);
      await expect(service.getById(ACCOUNT_ID, 'missing-id')).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.getById(ACCOUNT_ID, 'missing-id')).rejects.toThrow(
        'Entity profile missing-id not found',
      );
    });

    it('should scope query to account user IDs', async () => {
      mockPrisma.entityProfile.findFirst.mockResolvedValue(baseProfile);
      await service.getById(ACCOUNT_ID, 'profile-1');
      expect(mockPrisma.entityProfile.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: { in: USER_IDS },
          }),
        }),
      );
    });
  });

  // =========================================================================
  // update
  // =========================================================================

  describe('update', () => {
    beforeEach(() => {
      mockPrisma.user.findMany.mockResolvedValue(
        USER_IDS.map((id) => ({ id })),
      );
      mockPrisma.entityProfile.findFirst.mockResolvedValue(baseProfile);
    });

    it('should update profile fields', async () => {
      mockPrisma.entityProfile.update.mockResolvedValue({
        ...baseProfile,
        description: 'Updated desc',
        attributes: [],
      });

      const result = await service.update(ACCOUNT_ID, 'profile-1', {
        description: 'Updated desc',
      });

      expect(result.description).toBe('Updated desc');
      expect(mockPrisma.entityProfile.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'profile-1' },
          data: expect.objectContaining({ description: 'Updated desc' }),
        }),
      );
    });

    it('should update normalizedName when name changes', async () => {
      mockPrisma.entityProfile.update.mockResolvedValue({
        ...baseProfile,
        name: 'Alicia',
        attributes: [],
      });

      await service.update(ACCOUNT_ID, 'profile-1', { name: 'Alicia' });

      expect(mockPrisma.entityProfile.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ normalizedName: 'alicia' }),
        }),
      );
    });

    it('should throw NotFoundException for unknown profile', async () => {
      mockPrisma.entityProfile.findFirst.mockResolvedValue(null);
      await expect(
        service.update(ACCOUNT_ID, 'bad-id', { description: 'nope' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // =========================================================================
  // softDelete
  // =========================================================================

  describe('softDelete', () => {
    beforeEach(() => {
      mockPrisma.user.findMany.mockResolvedValue(
        USER_IDS.map((id) => ({ id })),
      );
      mockPrisma.entityProfile.findFirst.mockResolvedValue(baseProfile);
    });

    it('should soft delete by setting deletedAt', async () => {
      mockPrisma.entityProfile.update.mockResolvedValue({
        ...baseProfile,
        deletedAt: new Date(),
      });

      const result = await service.softDelete(ACCOUNT_ID, 'profile-1');
      expect(result.deletedAt).not.toBeNull();
      expect(mockPrisma.entityProfile.update).toHaveBeenCalledWith({
        where: { id: 'profile-1' },
        data: { deletedAt: expect.any(Date) },
      });
    });

    it('should throw when profile not found', async () => {
      mockPrisma.entityProfile.findFirst.mockResolvedValue(null);
      await expect(service.softDelete(ACCOUNT_ID, 'bad-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // =========================================================================
  // addAttribute
  // =========================================================================

  describe('addAttribute', () => {
    beforeEach(() => {
      mockPrisma.user.findMany.mockResolvedValue(
        USER_IDS.map((id) => ({ id })),
      );
      mockPrisma.entityProfile.findFirst.mockResolvedValue(baseProfile);
    });

    it('should create an attribute on the profile', async () => {
      const attr = {
        id: 'attr-1',
        profileId: 'profile-1',
        key: 'role',
        value: 'developer',
      };
      mockPrisma.entityAttribute.create.mockResolvedValue(attr);

      const result = await service.addAttribute(ACCOUNT_ID, 'profile-1', {
        key: 'role',
        value: 'developer',
        valueType: AttributeType.STRING,
      });

      expect(result).toEqual(attr);
      expect(mockPrisma.entityAttribute.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          profileId: 'profile-1',
          key: 'role',
          value: 'developer',
          confidence: 1.0,
          verified: true,
          source: 'MANUAL',
        }),
      });
    });

    it('should default valueType to STRING', async () => {
      mockPrisma.entityAttribute.create.mockResolvedValue({ id: 'attr-1' });
      await service.addAttribute(ACCOUNT_ID, 'profile-1', {
        key: 'k',
        value: 'v',
      });
      expect(mockPrisma.entityAttribute.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ valueType: AttributeType.STRING }),
        }),
      );
    });

    it('should throw when profile not found', async () => {
      mockPrisma.entityProfile.findFirst.mockResolvedValue(null);
      await expect(
        service.addAttribute(ACCOUNT_ID, 'bad-id', { key: 'k', value: 'v' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // =========================================================================
  // updateAttribute
  // =========================================================================

  describe('updateAttribute', () => {
    beforeEach(() => {
      mockPrisma.user.findMany.mockResolvedValue(
        USER_IDS.map((id) => ({ id })),
      );
      mockPrisma.entityProfile.findFirst.mockResolvedValue(baseProfile);
    });

    it('should update an attribute', async () => {
      const existingAttr = {
        id: 'attr-1',
        profileId: 'profile-1',
        key: 'role',
        value: 'old',
      };
      mockPrisma.entityAttribute.findFirst.mockResolvedValue(existingAttr);
      mockPrisma.entityAttribute.update.mockResolvedValue({
        ...existingAttr,
        value: 'new',
      });

      const result = await service.updateAttribute(
        ACCOUNT_ID,
        'profile-1',
        'attr-1',
        {
          value: 'new',
        },
      );
      expect(result.value).toBe('new');
    });

    it('should throw NotFoundException when attribute not found on profile', async () => {
      mockPrisma.entityAttribute.findFirst.mockResolvedValue(null);
      await expect(
        service.updateAttribute(ACCOUNT_ID, 'profile-1', 'bad-attr', {
          value: 'x',
        }),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.updateAttribute(ACCOUNT_ID, 'profile-1', 'bad-attr', {
          value: 'x',
        }),
      ).rejects.toThrow('Attribute bad-attr not found on profile profile-1');
    });
  });

  // =========================================================================
  // removeAttribute
  // =========================================================================

  describe('removeAttribute', () => {
    beforeEach(() => {
      mockPrisma.user.findMany.mockResolvedValue(
        USER_IDS.map((id) => ({ id })),
      );
      mockPrisma.entityProfile.findFirst.mockResolvedValue(baseProfile);
    });

    it('should delete the attribute', async () => {
      mockPrisma.entityAttribute.findFirst.mockResolvedValue({
        id: 'attr-1',
        profileId: 'profile-1',
      });
      mockPrisma.entityAttribute.delete.mockResolvedValue({ id: 'attr-1' });

      await service.removeAttribute(ACCOUNT_ID, 'profile-1', 'attr-1');
      expect(mockPrisma.entityAttribute.delete).toHaveBeenCalledWith({
        where: { id: 'attr-1' },
      });
    });

    it('should throw when attribute not found', async () => {
      mockPrisma.entityAttribute.findFirst.mockResolvedValue(null);
      await expect(
        service.removeAttribute(ACCOUNT_ID, 'profile-1', 'bad-attr'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // =========================================================================
  // attachMemory
  // =========================================================================

  describe('attachMemory', () => {
    beforeEach(() => {
      mockPrisma.user.findMany.mockResolvedValue(
        USER_IDS.map((id) => ({ id })),
      );
      mockPrisma.entityProfile.findFirst.mockResolvedValue(baseProfile);
    });

    it('should upsert a memory attachment', async () => {
      const upserted = {
        profileId: 'profile-1',
        memoryId: 'mem-1',
        relevanceScore: 0.9,
      };
      mockPrisma.entityProfileMemory.upsert.mockResolvedValue(upserted);

      const result = await service.attachMemory(
        ACCOUNT_ID,
        'profile-1',
        'mem-1',
        0.9,
      );
      expect(result).toEqual(upserted);
      expect(mockPrisma.entityProfileMemory.upsert).toHaveBeenCalledWith({
        where: {
          profileId_memoryId: { profileId: 'profile-1', memoryId: 'mem-1' },
        },
        create: expect.objectContaining({
          profileId: 'profile-1',
          memoryId: 'mem-1',
          relevanceScore: 0.9,
          attachMethod: 'MANUAL',
        }),
        update: { relevanceScore: 0.9 },
      });
    });

    it('should default relevanceScore to 1.0', async () => {
      mockPrisma.entityProfileMemory.upsert.mockResolvedValue({});
      await service.attachMemory(ACCOUNT_ID, 'profile-1', 'mem-1');
      expect(mockPrisma.entityProfileMemory.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ relevanceScore: 1.0 }),
          update: { relevanceScore: 1.0 },
        }),
      );
    });
  });

  // =========================================================================
  // detachMemory
  // =========================================================================

  describe('detachMemory', () => {
    beforeEach(() => {
      mockPrisma.user.findMany.mockResolvedValue(
        USER_IDS.map((id) => ({ id })),
      );
      mockPrisma.entityProfile.findFirst.mockResolvedValue(baseProfile);
    });

    it('should delete the memory attachment', async () => {
      mockPrisma.entityProfileMemory.delete.mockResolvedValue({});
      await service.detachMemory(ACCOUNT_ID, 'profile-1', 'mem-1');
      expect(mockPrisma.entityProfileMemory.delete).toHaveBeenCalledWith({
        where: {
          profileId_memoryId: { profileId: 'profile-1', memoryId: 'mem-1' },
        },
      });
    });

    it('should throw when profile not found', async () => {
      mockPrisma.entityProfile.findFirst.mockResolvedValue(null);
      await expect(
        service.detachMemory(ACCOUNT_ID, 'bad-id', 'mem-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // =========================================================================
  // backfillAttachments
  // =========================================================================

  describe('backfillAttachments', () => {
    beforeEach(() => {
      mockPrisma.memory.findMany.mockReset();
      mockAttachmentPipeline.attachMemory.mockReset();
    });

    it('should process memories in batches and return stats', async () => {
      mockPrisma.memory.findMany.mockResolvedValueOnce([
        { id: 'mem-1' },
        { id: 'mem-2' },
      ]);

      mockAttachmentPipeline.attachMemory
        .mockResolvedValueOnce({
          memoryId: 'mem-1',
          attached: [{ profileId: 'p1' }],
          skipped: 0,
        })
        .mockResolvedValueOnce({ memoryId: 'mem-2', attached: [], skipped: 1 });

      const stats = await service.backfillAttachments('user-1');

      expect(stats.processed).toBe(2);
      expect(stats.attached).toBe(1);
      expect(stats.skipped).toBe(1);
      expect(stats.errors).toBe(0);
      expect(mockAttachmentPipeline.attachMemory).toHaveBeenCalledTimes(2);
    });

    it('should handle attachment errors gracefully', async () => {
      mockPrisma.memory.findMany.mockResolvedValueOnce([{ id: 'mem-1' }]);

      mockAttachmentPipeline.attachMemory.mockRejectedValueOnce(
        new Error('DB error'),
      );

      const stats = await service.backfillAttachments('user-1');

      expect(stats.processed).toBe(1);
      expect(stats.errors).toBe(1);
      expect(stats.attached).toBe(0);
    });

    it('should return zero stats when no memories to process', async () => {
      mockPrisma.memory.findMany.mockResolvedValueOnce([]);

      const stats = await service.backfillAttachments('user-1');

      expect(stats.processed).toBe(0);
      expect(stats.attached).toBe(0);
      expect(stats.skipped).toBe(0);
      expect(stats.errors).toBe(0);
      expect(mockAttachmentPipeline.attachMemory).not.toHaveBeenCalled();
    });
  });
});

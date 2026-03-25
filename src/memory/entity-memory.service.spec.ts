import { Test, TestingModule } from '@nestjs/testing';
import { EntityMemoryService } from './entity-memory.service';
import { ServicePrismaService } from '../prisma/service-prisma.service';

describe('EntityMemoryService', () => {
  let service: EntityMemoryService;
  let mockPrisma: any;

  beforeEach(async () => {
    mockPrisma = {
      memory: {
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({ id: 'mem-new' }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EntityMemoryService,
        { provide: ServicePrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<EntityMemoryService>(EntityMemoryService);
    jest.clearAllMocks();
  });

  it('creates IDENTITY memory for a new person entity', async () => {
    mockPrisma.memory.findFirst.mockResolvedValue(null);

    await service.ensureEntityMemory({
      name: 'Steve Krueger',
      type: 'person',
      userId: 'user-1',
    });

    expect(mockPrisma.memory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-1',
          raw: 'Steve Krueger is a person known to user-1.',
          layer: 'IDENTITY',
          source: 'AGENT_OBSERVATION',
          tags: ['entity:steve-krueger', 'entity-type:person', 'auto:entity-extraction'],
        }),
      }),
    );
  });

  it('creates IDENTITY memory for a new organization entity', async () => {
    mockPrisma.memory.findFirst.mockResolvedValue(null);

    await service.ensureEntityMemory({
      name: 'JIBE Commerce',
      type: 'organization',
      userId: 'user-1',
    });

    expect(mockPrisma.memory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          raw: 'JIBE Commerce is an organization known to user-1.',
          layer: 'IDENTITY',
          tags: expect.arrayContaining(['entity:jibe-commerce', 'entity-type:organization']),
        }),
      }),
    );
  });

  it('skips non-person/non-org entity types', async () => {
    for (const type of ['location', 'product', 'concept', 'event']) {
      await service.ensureEntityMemory({
        name: 'Something',
        type,
        userId: 'user-1',
      });
    }

    expect(mockPrisma.memory.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.memory.create).not.toHaveBeenCalled();
  });

  it('does NOT create duplicate if IDENTITY memory already exists', async () => {
    mockPrisma.memory.findFirst.mockResolvedValue({ id: 'mem-existing' });

    await service.ensureEntityMemory({
      name: 'Steve Krueger',
      type: 'person',
      userId: 'user-1',
    });

    expect(mockPrisma.memory.create).not.toHaveBeenCalled();
    expect(mockPrisma.memory.update).toHaveBeenCalledWith({
      where: { id: 'mem-existing' },
      data: { lastRetrievedAt: expect.any(Date) },
    });
  });

  it('updates lastRetrievedAt on existing memory', async () => {
    const before = new Date();
    mockPrisma.memory.findFirst.mockResolvedValue({ id: 'mem-existing' });

    await service.ensureEntityMemory({
      name: 'Steve Krueger',
      type: 'person',
      userId: 'user-1',
    });

    const updateCall = mockPrisma.memory.update.mock.calls[0][0];
    expect(updateCall.data.lastRetrievedAt.getTime()).toBeGreaterThanOrEqual(
      before.getTime(),
    );
  });

  it('normalizes entity name correctly in tags', async () => {
    mockPrisma.memory.findFirst.mockResolvedValue(null);

    await service.ensureEntityMemory({
      name: '  John  Paul  Jones  ',
      type: 'person',
      userId: 'user-1',
    });

    expect(mockPrisma.memory.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tags: { has: 'entity:john-paul-jones' },
        }),
      }),
    );

    expect(mockPrisma.memory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tags: expect.arrayContaining(['entity:john-paul-jones']),
        }),
      }),
    );
  });

  it('handles case-insensitive entity types', async () => {
    mockPrisma.memory.findFirst.mockResolvedValue(null);

    await service.ensureEntityMemory({
      name: 'Acme Corp',
      type: 'ORGANIZATION',
      userId: 'user-1',
    });

    expect(mockPrisma.memory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          raw: 'Acme Corp is an organization known to user-1.',
          layer: 'IDENTITY',
        }),
      }),
    );
  });
});

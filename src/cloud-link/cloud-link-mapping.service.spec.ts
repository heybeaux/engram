import { Test, TestingModule } from '@nestjs/testing';
import { CloudLinkMappingService } from './cloud-link-mapping.service';
import { PrismaService } from '../prisma/prisma.service';

describe('CloudLinkMappingService', () => {
  let service: CloudLinkMappingService;
  let mockPrisma: any;

  beforeEach(async () => {
    mockPrisma = {
      agent: {
        findUnique: jest.fn(),
      },
      syncAgentMap: {
        upsert: jest.fn(),
      },
      syncUserMap: {
        upsert: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CloudLinkMappingService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<CloudLinkMappingService>(CloudLinkMappingService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createAgentMapping', () => {
    it('should upsert agent mapping with agent name from DB', async () => {
      mockPrisma.agent.findUnique.mockResolvedValue({ name: 'Rook' });
      mockPrisma.syncAgentMap.upsert.mockResolvedValue({});

      await service.createAgentMapping('inst-1', 'local-1', 'cloud-1');

      expect(mockPrisma.agent.findUnique).toHaveBeenCalledWith({
        where: { id: 'cloud-1' },
        select: { name: true },
      });
      expect(mockPrisma.syncAgentMap.upsert).toHaveBeenCalledWith({
        where: {
          instanceId_localAgentId: {
            instanceId: 'inst-1',
            localAgentId: 'local-1',
          },
        },
        create: {
          instanceId: 'inst-1',
          localAgentId: 'local-1',
          cloudAgentId: 'cloud-1',
          agentName: 'Rook',
        },
        update: {
          cloudAgentId: 'cloud-1',
          agentName: 'Rook',
        },
      });
    });

    it('should fall back to localAgentId when agent not found', async () => {
      mockPrisma.agent.findUnique.mockResolvedValue(null);
      mockPrisma.syncAgentMap.upsert.mockResolvedValue({});

      await service.createAgentMapping('inst-1', 'local-agent-x', 'cloud-2');

      expect(mockPrisma.syncAgentMap.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            agentName: 'local-agent-x',
          }),
          update: expect.objectContaining({
            agentName: 'local-agent-x',
          }),
        }),
      );
    });

    it('should fall back to localAgentId when agent has no name', async () => {
      mockPrisma.agent.findUnique.mockResolvedValue({ name: '' });
      mockPrisma.syncAgentMap.upsert.mockResolvedValue({});

      await service.createAgentMapping('inst-1', 'local-fallback', 'cloud-3');

      expect(mockPrisma.syncAgentMap.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            agentName: 'local-fallback',
          }),
        }),
      );
    });
  });

  describe('createUserMapping', () => {
    it('should upsert user mapping', async () => {
      mockPrisma.syncUserMap.upsert.mockResolvedValue({});

      await service.createUserMapping(
        'inst-1',
        'local-user-1',
        'cloud-user-1',
        'ext-123',
      );

      expect(mockPrisma.syncUserMap.upsert).toHaveBeenCalledWith({
        where: {
          instanceId_localUserId: {
            instanceId: 'inst-1',
            localUserId: 'local-user-1',
          },
        },
        create: {
          instanceId: 'inst-1',
          localUserId: 'local-user-1',
          cloudUserId: 'cloud-user-1',
          externalId: 'ext-123',
        },
        update: {
          cloudUserId: 'cloud-user-1',
          externalId: 'ext-123',
        },
      });
    });
  });
});

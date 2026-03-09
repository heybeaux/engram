import { Test, TestingModule } from '@nestjs/testing';
import { EntityProfileController } from './entity-profile.controller';
import { EntityProfileService } from './entity-profile.service';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';

describe('EntityProfileController', () => {
  let controller: EntityProfileController;
  let service: EntityProfileService;

  const mockService = {
    create: jest.fn(),
    list: jest.fn(),
    getById: jest.fn(),
    update: jest.fn(),
    softDelete: jest.fn(),
    addAttribute: jest.fn(),
    updateAttribute: jest.fn(),
    removeAttribute: jest.fn(),
    attachMemory: jest.fn(),
    detachMemory: jest.fn(),
  };

  const mockAgent = { id: 'agent-1', accountId: 'account-1' };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EntityProfileController],
      providers: [
        { provide: EntityProfileService, useValue: mockService },
      ],
    })
      .overrideGuard(ApiKeyOrJwtGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<EntityProfileController>(EntityProfileController);
    service = module.get<EntityProfileService>(EntityProfileService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('create', () => {
    it('should call service.create with agentId', async () => {
      const dto = { name: 'Matt', type: 'PERSON' as any };
      mockService.create.mockResolvedValue({ id: 'p1', ...dto });
      const result = await controller.create(mockAgent, dto);
      expect(mockService.create).toHaveBeenCalledWith('agent-1', dto);
      expect(result).toHaveProperty('id', 'p1');
    });
  });

  describe('list', () => {
    it('should call service.list with accountId', async () => {
      const query = { page: 1, limit: 25 };
      mockService.list.mockResolvedValue({
        profiles: [],
        total: 0,
        page: 1,
        limit: 25,
        totalPages: 0,
      });
      const result = await controller.list(mockAgent, query);
      expect(mockService.list).toHaveBeenCalledWith('account-1', query);
      expect(result).toHaveProperty('profiles');
      expect(result).toHaveProperty('totalPages');
    });
  });

  describe('getById', () => {
    it('should call service.getById with accountId and id', async () => {
      mockService.getById.mockResolvedValue({ id: 'p1', name: 'Matt' });
      const result = await controller.getById(mockAgent, 'p1');
      expect(mockService.getById).toHaveBeenCalledWith('account-1', 'p1');
      expect(result).toHaveProperty('name', 'Matt');
    });
  });

  describe('update', () => {
    it('should call service.update', async () => {
      const dto = { name: 'Matthew' };
      mockService.update.mockResolvedValue({ id: 'p1', name: 'Matthew' });
      await controller.update(mockAgent, 'p1', dto);
      expect(mockService.update).toHaveBeenCalledWith('account-1', 'p1', dto);
    });
  });

  describe('remove', () => {
    it('should call service.softDelete', async () => {
      mockService.softDelete.mockResolvedValue({ id: 'p1', deletedAt: new Date() });
      await controller.remove(mockAgent, 'p1');
      expect(mockService.softDelete).toHaveBeenCalledWith('account-1', 'p1');
    });
  });

  describe('addAttribute', () => {
    it('should call service.addAttribute', async () => {
      const dto = { key: 'email', value: 'matt@example.com' };
      mockService.addAttribute.mockResolvedValue({ id: 'a1', ...dto });
      await controller.addAttribute(mockAgent, 'p1', dto as any);
      expect(mockService.addAttribute).toHaveBeenCalledWith('account-1', 'p1', dto);
    });
  });

  describe('updateAttribute', () => {
    it('should call service.updateAttribute', async () => {
      const dto = { value: 'new@example.com' };
      mockService.updateAttribute.mockResolvedValue({ id: 'a1', value: 'new@example.com' });
      await controller.updateAttribute(mockAgent, 'p1', 'a1', dto);
      expect(mockService.updateAttribute).toHaveBeenCalledWith('account-1', 'p1', 'a1', dto);
    });
  });

  describe('removeAttribute', () => {
    it('should call service.removeAttribute', async () => {
      mockService.removeAttribute.mockResolvedValue({ id: 'a1' });
      await controller.removeAttribute(mockAgent, 'p1', 'a1');
      expect(mockService.removeAttribute).toHaveBeenCalledWith('account-1', 'p1', 'a1');
    });
  });

  describe('attachMemory', () => {
    it('should call service.attachMemory', async () => {
      mockService.attachMemory.mockResolvedValue({ id: 'pm1' });
      await controller.attachMemory(mockAgent, 'p1', {
        memoryId: 'm1',
        relevanceScore: 0.9,
      });
      expect(mockService.attachMemory).toHaveBeenCalledWith(
        'account-1', 'p1', 'm1', 0.9,
      );
    });
  });

  describe('detachMemory', () => {
    it('should call service.detachMemory', async () => {
      mockService.detachMemory.mockResolvedValue({ id: 'pm1' });
      await controller.detachMemory(mockAgent, 'p1', 'm1');
      expect(mockService.detachMemory).toHaveBeenCalledWith('account-1', 'p1', 'm1');
    });
  });
});

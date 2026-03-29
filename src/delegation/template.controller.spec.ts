import { Test, TestingModule } from '@nestjs/testing';
import { TemplateController } from './template.controller';
import { TemplateService } from './template.service';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';

describe('TemplateController', () => {
  let controller: TemplateController;
  let service: jest.Mocked<TemplateService>;

  const userId = 'user-1';

  beforeEach(async () => {
    const mockService = {
      create: jest.fn(),
      findAll: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TemplateController],
      providers: [{ provide: TemplateService, useValue: mockService }],
    })
      .overrideGuard(ApiKeyOrJwtGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<TemplateController>(TemplateController);
    service = module.get(TemplateService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('POST /', () => {
    it('should create a template', async () => {
      const dto = { name: 'Test Template', description: 'desc' } as any;
      const expected = { id: 't1', ...dto, userId };
      service.create.mockResolvedValue(expected);

      const result = await controller.create(userId, dto);
      expect(result).toEqual(expected);
      expect(service.create).toHaveBeenCalledWith(userId, dto);
    });

    it('should propagate service errors', async () => {
      service.create.mockRejectedValue(new Error('DB error'));
      await expect(controller.create(userId, {} as any)).rejects.toThrow('DB error');
    });
  });

  describe('GET /', () => {
    it('should return all templates for user', async () => {
      const templates = [{ id: 't1' }, { id: 't2' }];
      service.findAll.mockResolvedValue(templates as any);

      const result = await controller.findAll(userId);
      expect(result).toEqual(templates);
      expect(service.findAll).toHaveBeenCalledWith(userId);
    });

    it('should return empty array when no templates', async () => {
      service.findAll.mockResolvedValue([]);
      const result = await controller.findAll(userId);
      expect(result).toEqual([]);
    });
  });

  describe('GET /:id', () => {
    it('should return a single template', async () => {
      const template = { id: 't1', name: 'Test' };
      service.findOne.mockResolvedValue(template as any);

      const result = await controller.findOne(userId, 't1');
      expect(result).toEqual(template);
      expect(service.findOne).toHaveBeenCalledWith(userId, 't1');
    });

    it('should propagate not-found from service', async () => {
      service.findOne.mockRejectedValue(new Error('Not found'));
      await expect(controller.findOne(userId, 'bad-id')).rejects.toThrow('Not found');
    });
  });

  describe('PATCH /:id', () => {
    it('should update a template', async () => {
      const dto = { name: 'Updated' } as any;
      const expected = { id: 't1', name: 'Updated' };
      service.update.mockResolvedValue(expected as any);

      const result = await controller.update(userId, 't1', dto);
      expect(result).toEqual(expected);
      expect(service.update).toHaveBeenCalledWith(userId, 't1', dto);
    });

    it('should propagate service errors on update', async () => {
      service.update.mockRejectedValue(new Error('Forbidden'));
      await expect(controller.update(userId, 't1', {} as any)).rejects.toThrow('Forbidden');
    });
  });

  describe('DELETE /:id', () => {
    it('should remove a template', async () => {
      const expected = { id: 't1', deleted: true };
      service.remove.mockResolvedValue(expected as any);

      const result = await controller.remove(userId, 't1');
      expect(result).toEqual(expected);
      expect(service.remove).toHaveBeenCalledWith(userId, 't1');
    });

    it('should propagate service errors on remove', async () => {
      service.remove.mockRejectedValue(new Error('Not found'));
      await expect(controller.remove(userId, 'bad-id')).rejects.toThrow('Not found');
    });
  });
});

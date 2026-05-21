import { Test, TestingModule } from '@nestjs/testing';
import { AwarenessSourceController } from './awareness-source.controller';
import { AwarenessSourceService } from './awareness-source.service';
import { NotFoundException } from '@nestjs/common';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';

describe('AwarenessSourceController', () => {
  let controller: AwarenessSourceController;
  let service: any;

  const mockSource = {
    id: 'src-1',
    name: 'GitHub Issues',
    type: 'github' as const,
    enabled: true,
    config: { repo: 'org/repo' },
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  };

  beforeEach(async () => {
    service = {
      create: jest.fn(),
      listAll: jest.fn(),
      getById: jest.fn(),
      getStatus: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AwarenessSourceController],
      providers: [{ provide: AwarenessSourceService, useValue: service }],
    })
      .overrideGuard(ApiKeyOrJwtGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<AwarenessSourceController>(
      AwarenessSourceController,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('POST /v1/awareness/sources', () => {
    it('should create a new source', async () => {
      service.create!.mockResolvedValue(mockSource);

      const dto = { name: 'GitHub Issues', type: 'github' as const };
      const result = await controller.create(dto as any);

      expect(service.create).toHaveBeenCalledWith(dto);
      expect(result).toEqual(mockSource);
    });

    it('should create source with optional fields', async () => {
      service.create!.mockResolvedValue({ ...mockSource, enabled: false });

      const dto = {
        name: 'Custom',
        type: 'custom' as const,
        enabled: false,
        config: { url: 'http://test' },
      };
      await controller.create(dto as any);

      expect(service.create).toHaveBeenCalledWith(dto);
    });
  });

  describe('GET /v1/awareness/sources', () => {
    it('should return all sources', async () => {
      service.listAll!.mockReturnValue([mockSource]);

      const result = await controller.list();

      expect(service.listAll).toHaveBeenCalled();
      expect(result).toEqual([mockSource]);
    });

    it('should return empty array when no sources exist', async () => {
      service.listAll!.mockReturnValue([]);

      const result = await controller.list();

      expect(result).toEqual([]);
    });
  });

  describe('GET /v1/awareness/sources/:id', () => {
    it('should return a source by id', async () => {
      service.getById!.mockReturnValue(mockSource);

      const result = await controller.getById('src-1');

      expect(service.getById).toHaveBeenCalledWith('src-1');
      expect(result).toEqual(mockSource);
    });

    it('should throw NotFoundException for unknown id', async () => {
      service.getById!.mockImplementation(() => {
        throw new NotFoundException('Signal source unknown not found');
      });

      await expect(controller.getById('unknown')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('GET /v1/awareness/sources/:id/status', () => {
    it('should return status for an enabled source', async () => {
      const status = {
        id: 'src-1',
        name: 'GitHub Issues',
        type: 'github',
        enabled: true,
        healthy: true,
        lastChecked: '2026-01-01T00:00:00.000Z',
        message: 'Source is configured and active',
      };
      service.getStatus!.mockReturnValue(status);

      const result = await controller.getStatus('src-1');

      expect(service.getStatus).toHaveBeenCalledWith('src-1');
      expect(result).toEqual(status);
    });

    it('should throw NotFoundException for unknown source', async () => {
      service.getStatus!.mockImplementation(() => {
        throw new NotFoundException('Signal source unknown not found');
      });

      await expect(controller.getStatus('unknown')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('PUT /v1/awareness/sources/:id', () => {
    it('should update a source', async () => {
      const updated = { ...mockSource, name: 'Updated' };
      service.update!.mockResolvedValue(updated);

      const dto = { name: 'Updated' };
      const result = await controller.update('src-1', dto as any);

      expect(service.update).toHaveBeenCalledWith('src-1', dto);
      expect(result).toEqual(updated);
    });

    it('should update enabled state', async () => {
      const updated = { ...mockSource, enabled: false };
      service.update!.mockResolvedValue(updated);

      const result = await controller.update('src-1', {
        enabled: false,
      } as any);

      expect(result.enabled).toBe(false);
    });

    it('should throw NotFoundException for unknown id', async () => {
      service.update!.mockImplementation(() => {
        throw new NotFoundException('Signal source unknown not found');
      });

      await expect(controller.update('unknown', {} as any)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('DELETE /v1/awareness/sources/:id', () => {
    it('should delete a source', async () => {
      service.delete!.mockResolvedValue({ deleted: true });

      const result = await controller.delete('src-1');

      expect(service.delete).toHaveBeenCalledWith('src-1');
      expect(result).toEqual({ deleted: true });
    });

    it('should throw NotFoundException for unknown id', async () => {
      service.delete!.mockImplementation(() => {
        throw new NotFoundException('Signal source unknown not found');
      });

      await expect(controller.delete('unknown')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});

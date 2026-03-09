import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { AgentRecallController } from './agent-recall.controller';
import { AgentRecallService, RecallResult } from './agent-recall.service';
import { ApiKeyOrJwtGuard } from '../common/guards/api-key-or-jwt.guard';

describe('AgentRecallController', () => {
  let controller: AgentRecallController;

  const mockResult: RecallResult = {
    profile: {
      id: 'profile-1',
      name: 'MAP International',
      type: 'ORGANIZATION',
      description: 'A global health organization',
      attributes: [
        {
          key: 'founded',
          value: '1954',
          verified: true,
          confidence: 1.0,
          source: 'manual',
        },
      ],
    },
    memories: [
      {
        id: 'mem-1',
        content: 'MAP International ships medical supplies',
        importance: 0.8,
        relevanceScore: 0.92,
        createdAt: new Date('2025-01-01'),
        source: 'API',
      },
    ],
    relationships: [
      { entity: 'Operation Blessing', type: 'PARTNER', strength: 0.7 },
    ],
    unverifiedAttributes: [
      {
        key: 'annual_revenue',
        value: '$50M',
        confidence: 0.5,
        source: 'agent:gemini',
      },
    ],
  };

  const mockService = {
    recallEntity: jest.fn(),
    recallBatch: jest.fn(),
  };

  const mockAgent = { id: 'agent-1', accountId: 'account-1' };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AgentRecallController],
      providers: [{ provide: AgentRecallService, useValue: mockService }],
    })
      .overrideGuard(ApiKeyOrJwtGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<AgentRecallController>(AgentRecallController);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('GET /v1/agent/recall/:entityName', () => {
    it('should return profile + memories for a known entity', async () => {
      mockService.recallEntity.mockResolvedValue(mockResult);

      const result = await controller.recallOne(
        mockAgent,
        'MAP%20International',
        '10',
      );

      expect(mockService.recallEntity).toHaveBeenCalledWith(
        'account-1',
        'MAP International',
        10,
      );
      expect(result.profile).toBeDefined();
      expect(result.profile.name).toBe('MAP International');
      expect(result.memories).toHaveLength(1);
      expect(result.relationships).toHaveLength(1);
      expect(result.unverifiedAttributes).toHaveLength(1);
    });

    it('should throw 404 for unknown entity', async () => {
      mockService.recallEntity.mockResolvedValue(null);

      await expect(
        controller.recallOne(mockAgent, 'Unknown%20Entity'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should use default limit of 10', async () => {
      mockService.recallEntity.mockResolvedValue(mockResult);

      await controller.recallOne(mockAgent, 'MAP%20International');

      expect(mockService.recallEntity).toHaveBeenCalledWith(
        'account-1',
        'MAP International',
        10,
      );
    });
  });

  describe('POST /v1/agent/recall (batch)', () => {
    it('should return array with mixed hits and misses', async () => {
      mockService.recallBatch.mockResolvedValue([mockResult, null]);

      const result = await controller.recallBatch(mockAgent, {
        entities: ['MAP International', 'Unknown Corp'],
        limit: 10,
      });

      expect(mockService.recallBatch).toHaveBeenCalledWith(
        'account-1',
        ['MAP International', 'Unknown Corp'],
        10,
      );
      expect(result).toHaveLength(2);
      expect(result[0]).toBeDefined();
      expect(result[0]!.profile.name).toBe('MAP International');
      expect(result[1]).toBeNull();
    });

    it('should use default limit when not specified', async () => {
      mockService.recallBatch.mockResolvedValue([]);

      await controller.recallBatch(mockAgent, {
        entities: [],
      });

      expect(mockService.recallBatch).toHaveBeenCalledWith(
        'account-1',
        [],
        10,
      );
    });
  });

  describe('Auth guard', () => {
    it('should have ApiKeyOrJwtGuard applied', () => {
      const guards = Reflect.getMetadata(
        '__guards__',
        AgentRecallController,
      );
      // Guard is applied at the class level
      expect(guards).toBeDefined();
      expect(guards.length).toBeGreaterThan(0);
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from './prisma.service';
import { rlsContext } from './rls-context';

// Mock PrismaPg adapter
jest.mock('@prisma/adapter-pg', () => ({
  PrismaPg: jest.fn().mockImplementation(() => ({
    provider: 'postgres',
  })),
}));

// Mock PrismaClient
jest.mock('@prisma/client', () => {
  class MockPrismaClient {
    $connect = jest.fn().mockResolvedValue(undefined);
    $disconnect = jest.fn().mockResolvedValue(undefined);
    $transaction = jest.fn();
    $extends = jest.fn();
    $on = jest.fn();
    memory = { update: jest.fn(), findMany: jest.fn() };
    constructor(_opts?: any) {}
  }
  return { PrismaClient: MockPrismaClient };
});

describe('PrismaService', () => {
  let service: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PrismaService],
    }).compile();

    service = module.get<PrismaService>(PrismaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('onModuleInit', () => {
    it('should call $connect', async () => {
      await service.onModuleInit();
      expect(service.$connect).toHaveBeenCalled();
    });
  });

  describe('onModuleDestroy', () => {
    it('should call $disconnect', async () => {
      await service.onModuleDestroy();
      expect(service.$disconnect).toHaveBeenCalled();
    });
  });

  describe('softDelete', () => {
    it('should set deletedAt on the model', async () => {
      const mockModel = {
        update: jest.fn().mockResolvedValue({ id: '1', deletedAt: new Date() }),
      };
      const result = await service.softDelete(mockModel, { id: '1' });
      expect(mockModel.update).toHaveBeenCalledWith({
        where: { id: '1' },
        data: { deletedAt: expect.any(Date) },
      });
      expect(result.deletedAt).toBeDefined();
    });
  });

  describe('proxy behavior', () => {
    it('should return real service props when no RLS context', () => {
      // $connect is a non-transactional prop, should always come from real service
      expect(service.$connect).toBeDefined();
      expect(typeof service.$connect).toBe('function');
    });

    it('should delegate to txClient when RLS context is active', () => {
      const mockTx = {
        memory: { findMany: jest.fn().mockReturnValue('tx-result') },
      };

      rlsContext.run(mockTx as any, () => {
        // Accessing 'memory' should delegate to the tx client
        expect((service as any).memory).toBe(mockTx.memory);
      });
    });

    it('should not delegate $connect to txClient', () => {
      const mockTx = {
        $connect: jest.fn(),
        memory: { findMany: jest.fn() },
      };

      rlsContext.run(mockTx as any, () => {
        // $connect is in NON_TRANSACTIONAL_PROPS, should not delegate
        expect(service.$connect).not.toBe(mockTx.$connect);
      });
    });
  });
});

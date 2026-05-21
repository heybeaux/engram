// Mock PrismaPg adapter
jest.mock('@prisma/adapter-pg', () => ({
  PrismaPg: jest.fn().mockImplementation(() => ({
    provider: 'postgres',
  })),
}));

// Mock PrismaClient — capture constructor options
let capturedPrismaOpts: any;
jest.mock('@prisma/client', () => {
  class MockPrismaClient {
    $connect = jest.fn().mockResolvedValue(undefined);
    $disconnect = jest.fn().mockResolvedValue(undefined);
    constructor(opts?: any) {
      capturedPrismaOpts = opts;
    }
  }
  return { PrismaClient: MockPrismaClient };
});

import { ServicePrismaService } from './service-prisma.service';

describe('ServicePrismaService', () => {
  it('should be defined', () => {
    const service = new ServicePrismaService();
    expect(service).toBeDefined();
  });

  it('should instantiate without DATABASE_URL_SERVICE', () => {
    const original = process.env.DATABASE_URL_SERVICE;
    delete process.env.DATABASE_URL_SERVICE;
    const service = new ServicePrismaService();
    expect(service).toBeDefined();
    if (original) process.env.DATABASE_URL_SERVICE = original;
  });

  it('should set interactive transaction timeout to 120s', () => {
    new ServicePrismaService();
    expect(capturedPrismaOpts.transactionOptions).toEqual({
      maxWait: 10000,
      timeout: 120000,
    });
  });
});

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
});

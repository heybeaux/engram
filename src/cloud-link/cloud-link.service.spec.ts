import { CloudLinkService } from './cloud-link.service';
import { CloudLinkAuthService } from './cloud-link-auth.service';
import { CloudLinkMappingService } from './cloud-link-mapping.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { encrypt, decrypt } from '../common/encryption.util';

const mockPrisma = {
  cloudLink: {
    upsert: jest.fn(),
    findUnique: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
  },
  memory: {
    count: jest.fn().mockResolvedValue(0),
  },
};

// Mock fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

describe('CloudLinkService', () => {
  let service: CloudLinkService;
  let authService: CloudLinkAuthService;
  let mappingService: CloudLinkMappingService;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = 'test-key-min-32-chars-long-xxxxx';
  });

  afterAll(() => {
    delete process.env.ENCRYPTION_KEY;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    authService = new CloudLinkAuthService(mockPrisma as any);
    mappingService = new CloudLinkMappingService(mockPrisma as any);
    service = new CloudLinkService(
      mockPrisma as any,
      authService,
      mappingService,
    );
  });

  describe('linkCloud', () => {
    it('should validate key and store cloud link', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'cloud-123',
          email: 'test@example.com',
          plan: 'PRO',
        }),
      });
      mockPrisma.cloudLink.findUnique.mockResolvedValue(null);
      mockPrisma.cloudLink.upsert.mockResolvedValue({});

      const result = await service.linkCloud('acc-1', 'valid-key');

      expect(result.linked).toBe(true);
      expect(result.plan).toBe('PRO');
      expect(result.email).toBe('test@example.com');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openengram.ai/v1/auth/me',
        { headers: { 'X-AM-API-Key': 'valid-key' } },
      );
    });

    it('should throw on invalid API key', async () => {
      mockFetch.mockResolvedValue({ ok: false });

      await expect(service.linkCloud('acc-1', 'bad-key')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('unlinkCloud', () => {
    it('should delete existing cloud link', async () => {
      mockPrisma.cloudLink.findUnique.mockResolvedValue({ id: '1' });
      mockPrisma.cloudLink.delete.mockResolvedValue({});

      await service.unlinkCloud('acc-1');
      expect(mockPrisma.cloudLink.delete).toHaveBeenCalledWith({
        where: { accountId: 'acc-1' },
      });
    });

    it('should throw when no link exists', async () => {
      mockPrisma.cloudLink.findUnique.mockResolvedValue(null);

      await expect(service.unlinkCloud('acc-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getStatus', () => {
    it('should return linked status', async () => {
      mockPrisma.cloudLink.findUnique.mockResolvedValue({
        cloudPlan: 'PRO',
        cloudEmail: 'test@example.com',
        lastVerifiedAt: new Date('2026-01-01'),
      });

      const result = await service.getStatus('acc-1');
      expect(result.linked).toBe(true);
      expect(result.plan).toBe('PRO');
    });

    it('should return unlinked status', async () => {
      mockPrisma.cloudLink.findUnique.mockResolvedValue(null);

      const result = await service.getStatus('acc-1');
      expect(result.linked).toBe(false);
    });
  });

  describe('encryption', () => {
    it('should encrypt and decrypt roundtrip with new format', () => {
      const original = 'my-secret-api-key-12345';
      const encrypted = encrypt(original);
      expect(encrypted).not.toBe(original);
      expect(encrypted.split(':')).toHaveLength(4); // salt:iv:encrypted:hmac
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(original);
    });

    it('should decrypt legacy format (hex iv:encrypted)', () => {
      // Create a legacy-format encrypted value using the old method
      const { createCipheriv, scryptSync, randomBytes } = require('crypto');
      const key = process.env.ENCRYPTION_KEY!;
      const derivedKey = scryptSync(key, 'engram-salt', 32);
      const iv = randomBytes(16);
      const cipher = createCipheriv('aes-256-cbc', derivedKey, iv);
      const original = 'legacy-secret-key';
      const enc = Buffer.concat([
        cipher.update(original, 'utf8'),
        cipher.final(),
      ]);
      const legacyEncrypted = iv.toString('hex') + ':' + enc.toString('hex');

      const decrypted = decrypt(legacyEncrypted);
      expect(decrypted).toBe(original);
    });
  });
});

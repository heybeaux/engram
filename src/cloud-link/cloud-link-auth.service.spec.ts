import { BadRequestException } from '@nestjs/common';
import { CloudLinkAuthService } from './cloud-link-auth.service';
import { encrypt, decrypt } from '../common/encryption.util';

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

const mockPrisma = {
  cloudLink: {
    findUnique: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
};

describe('CloudLinkAuthService', () => {
  let service: CloudLinkAuthService;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = 'test-key-min-32-chars-long-xxxxx';
  });

  afterAll(() => {
    delete process.env.ENCRYPTION_KEY;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    service = new CloudLinkAuthService(mockPrisma as any);
  });

  // ─── validateCloudApiKey ────────────────────────────────────────────────────

  describe('validateCloudApiKey', () => {
    it('should return cloud auth response on valid key', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'cloud-123', email: 'user@test.com', plan: 'PRO', name: 'Test User' }),
      });

      const result = await service.validateCloudApiKey('valid-api-key');

      expect(result.id).toBe('cloud-123');
      expect(result.email).toBe('user@test.com');
      expect(result.plan).toBe('PRO');
      expect(mockFetch).toHaveBeenCalledWith(
        `${service.CLOUD_API_BASE}/v1/auth/me`,
        expect.objectContaining({ headers: { 'X-AM-API-Key': 'valid-api-key' } }),
      );
    });

    it('should throw BadRequestException when response is not ok', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 401 });

      await expect(service.validateCloudApiKey('bad-key')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.validateCloudApiKey('bad-key')).rejects.toThrow(
        'Invalid cloud API key',
      );
    });

    it('should throw BadRequestException when response missing id', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ email: 'user@test.com', plan: 'FREE' }), // no id
      });

      await expect(service.validateCloudApiKey('key')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException when response missing email', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'cloud-1', plan: 'FREE' }), // no email
      });

      await expect(service.validateCloudApiKey('key')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ─── createSyncKey ──────────────────────────────────────────────────────────

  describe('createSyncKey', () => {
    it('should return encrypted sync key on success (syncKey field)', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ syncKey: 'raw-sync-key-abc' }),
      });

      const result = await service.createSyncKey('my-api-key');
      expect(result).not.toBeNull();
      // Should be encrypted — decrypt should round-trip
      expect(decrypt(result!)).toBe('raw-sync-key-abc');
    });

    it('should return encrypted sync key on success (key field fallback)', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ key: 'raw-sync-key-xyz' }),
      });

      const result = await service.createSyncKey('my-api-key');
      expect(decrypt(result!)).toBe('raw-sync-key-xyz');
    });

    it('should return null when response is not ok', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500, text: async () => 'Server Error' });

      const result = await service.createSyncKey('my-api-key');
      expect(result).toBeNull();
    });

    it('should return null when sync key absent in response', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({}), // no syncKey or key
      });

      const result = await service.createSyncKey('my-api-key');
      expect(result).toBeNull();
    });

    it('should return null when fetch throws (network error)', async () => {
      mockFetch.mockRejectedValue(new Error('Network failure'));

      const result = await service.createSyncKey('my-api-key');
      expect(result).toBeNull();
    });
  });

  // ─── refreshSubscription ────────────────────────────────────────────────────

  describe('refreshSubscription', () => {
    it('should return linked:false when no cloud link exists', async () => {
      mockPrisma.cloudLink.findUnique.mockResolvedValue(null);

      const result = await service.refreshSubscription('acc-1');
      expect(result).toEqual({ linked: false });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should return linked:true with updated data on success', async () => {
      const encryptedKey = encrypt('test-api-key');
      mockPrisma.cloudLink.findUnique.mockResolvedValue({
        accountId: 'acc-1',
        cloudApiKey: encryptedKey,
        cloudPlan: 'FREE',
        cloudEmail: 'old@test.com',
        lastVerifiedAt: new Date('2026-03-17'),
      });
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'cloud-1', email: 'new@test.com', plan: 'PRO' }),
      });
      mockPrisma.cloudLink.update.mockResolvedValue({});

      const result = await service.refreshSubscription('acc-1');

      expect(result.linked).toBe(true);
      expect(result.plan).toBe('PRO');
      expect(result.email).toBe('new@test.com');
      expect(mockPrisma.cloudLink.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { accountId: 'acc-1' },
          data: expect.objectContaining({ cloudPlan: 'PRO', cloudEmail: 'new@test.com' }),
        }),
      );
    });

    it('should keep link intact on network error', async () => {
      const encryptedKey = encrypt('test-api-key');
      mockPrisma.cloudLink.findUnique.mockResolvedValue({
        accountId: 'acc-1',
        cloudApiKey: encryptedKey,
        cloudPlan: 'PRO',
        cloudEmail: 'user@test.com',
        lastVerifiedAt: new Date('2026-03-17'),
      });
      mockFetch.mockRejectedValue(new Error('ETIMEDOUT'));

      const result = await service.refreshSubscription('acc-1');

      expect(result.linked).toBe(true);
      expect(result.plan).toBe('PRO');
      expect(mockPrisma.cloudLink.delete).not.toHaveBeenCalled();
    });

    it('should keep link on first auth failure (below threshold)', async () => {
      const encryptedKey = encrypt('test-api-key');
      const link = {
        accountId: 'acc-1',
        cloudApiKey: encryptedKey,
        cloudPlan: 'PRO',
        cloudEmail: 'user@test.com',
        lastVerifiedAt: new Date(),
      };
      mockPrisma.cloudLink.findUnique.mockResolvedValue(link);
      mockFetch.mockResolvedValue({ ok: false, status: 401 });

      const result = await service.refreshSubscription('acc-1');

      expect(result.linked).toBe(true);
      expect(mockPrisma.cloudLink.delete).not.toHaveBeenCalled();
    });

    it('should unlink after 3 consecutive auth failures', async () => {
      const encryptedKey = encrypt('test-api-key');
      const link = {
        accountId: 'acc-1',
        cloudApiKey: encryptedKey,
        cloudPlan: 'PRO',
        cloudEmail: 'user@test.com',
        lastVerifiedAt: new Date(),
      };
      mockPrisma.cloudLink.findUnique.mockResolvedValue(link);
      mockFetch.mockResolvedValue({ ok: false, status: 401 });
      mockPrisma.cloudLink.delete.mockResolvedValue({});

      // Create fresh service for clean failure counter
      service = new CloudLinkAuthService(mockPrisma as any);

      await service.refreshSubscription('acc-1'); // failure 1
      await service.refreshSubscription('acc-1'); // failure 2
      const result = await service.refreshSubscription('acc-1'); // failure 3 → unlink

      expect(result.linked).toBe(false);
      expect(mockPrisma.cloudLink.delete).toHaveBeenCalledWith({ where: { accountId: 'acc-1' } });
    });

    it('should reset failure counter after successful auth', async () => {
      const encryptedKey = encrypt('test-api-key');
      const link = {
        accountId: 'acc-1',
        cloudApiKey: encryptedKey,
        cloudPlan: 'PRO',
        cloudEmail: 'user@test.com',
        lastVerifiedAt: new Date(),
      };
      mockPrisma.cloudLink.findUnique.mockResolvedValue(link);

      service = new CloudLinkAuthService(mockPrisma as any);

      // One auth failure
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
      await service.refreshSubscription('acc-1');

      // Then success
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'c-1', email: 'u@t.com', plan: 'PRO' }),
      });
      mockPrisma.cloudLink.update.mockResolvedValue({});
      await service.refreshSubscription('acc-1');

      // Another auth failure — counter was reset, so should not unlink
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
      const result = await service.refreshSubscription('acc-1');

      expect(result.linked).toBe(true);
      expect(mockPrisma.cloudLink.delete).not.toHaveBeenCalled();
    });

    it('should keep link intact on 5xx errors', async () => {
      const encryptedKey = encrypt('test-api-key');
      mockPrisma.cloudLink.findUnique.mockResolvedValue({
        accountId: 'acc-1',
        cloudApiKey: encryptedKey,
        cloudPlan: 'PRO',
        cloudEmail: 'user@test.com',
        lastVerifiedAt: new Date(),
      });
      mockFetch.mockResolvedValue({ ok: false, status: 503 });

      const result = await service.refreshSubscription('acc-1');

      expect(result.linked).toBe(true);
      expect(mockPrisma.cloudLink.delete).not.toHaveBeenCalled();
    });

    it('should return linked:true with undefined plan/email when fields are null', async () => {
      const encryptedKey = encrypt('test-api-key');
      mockPrisma.cloudLink.findUnique.mockResolvedValue({
        accountId: 'acc-1',
        cloudApiKey: encryptedKey,
        cloudPlan: null,
        cloudEmail: null,
        lastVerifiedAt: null,
      });
      mockFetch.mockRejectedValue(new Error('network'));

      const result = await service.refreshSubscription('acc-1');

      expect(result.plan).toBeUndefined();
      expect(result.email).toBeUndefined();
      expect(result.lastVerified).toBeUndefined();
    });

    it('should keep link when cloud API returns invalid response format', async () => {
      const encryptedKey = encrypt('test-api-key');
      mockPrisma.cloudLink.findUnique.mockResolvedValue({
        accountId: 'acc-1',
        cloudApiKey: encryptedKey,
        cloudPlan: 'PRO',
        cloudEmail: 'user@test.com',
        lastVerifiedAt: new Date(),
      });
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ unexpected: 'data' }), // no id/email
      });

      const result = await service.refreshSubscription('acc-1');

      expect(result.linked).toBe(true);
      expect(mockPrisma.cloudLink.update).not.toHaveBeenCalled();
    });
  });

  // ─── healthCheck ────────────────────────────────────────────────────────────

  describe('healthCheck', () => {
    it('should return healthy:false when no cloud link', async () => {
      mockPrisma.cloudLink.findUnique.mockResolvedValue(null);

      const result = await service.healthCheck('acc-1');

      expect(result.healthy).toBe(false);
      expect(result.linked).toBe(false);
      expect(result.credentialsValid).toBe(false);
      expect(result.cloudReachable).toBe(false);
    });

    it('should return all-pass when link is healthy', async () => {
      const encryptedKey = encrypt('test-api-key');
      const encryptedSync = encrypt('test-sync-key');
      mockPrisma.cloudLink.findUnique.mockResolvedValue({
        accountId: 'acc-1',
        cloudApiKey: encryptedKey,
        cloudSyncKey: encryptedSync,
      });
      mockFetch.mockResolvedValue({ ok: true });

      const result = await service.healthCheck('acc-1');

      expect(result.healthy).toBe(true);
      expect(result.linked).toBe(true);
      expect(result.credentialsValid).toBe(true);
      expect(result.syncKeyValid).toBe(true);
      expect(result.cloudReachable).toBe(true);
      expect(result.details).toContain('healthy');
    });

    it('should return cloudReachable:true but credentialsValid:false when API returns 401', async () => {
      const encryptedKey = encrypt('test-api-key');
      mockPrisma.cloudLink.findUnique.mockResolvedValue({
        accountId: 'acc-1',
        cloudApiKey: encryptedKey,
        cloudSyncKey: null,
      });
      mockFetch.mockResolvedValue({ ok: false, status: 401 });

      const result = await service.healthCheck('acc-1');

      expect(result.healthy).toBe(false);
      expect(result.cloudReachable).toBe(true);
      expect(result.credentialsValid).toBe(false);
      expect(result.details).toContain('API key rejected');
    });

    it('should return cloudReachable:false on network error', async () => {
      const encryptedKey = encrypt('test-api-key');
      mockPrisma.cloudLink.findUnique.mockResolvedValue({
        accountId: 'acc-1',
        cloudApiKey: encryptedKey,
        cloudSyncKey: null,
      });
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await service.healthCheck('acc-1');

      expect(result.healthy).toBe(false);
      expect(result.cloudReachable).toBe(false);
      expect(result.details).toContain('unreachable');
    });

    it('should report syncKeyValid:false when sync key decryption fails', async () => {
      const encryptedKey = encrypt('test-api-key');
      mockPrisma.cloudLink.findUnique.mockResolvedValue({
        accountId: 'acc-1',
        cloudApiKey: encryptedKey,
        cloudSyncKey: 'corrupted-sync-key-not-valid-encrypted',
      });
      mockFetch.mockResolvedValue({ ok: true });

      const result = await service.healthCheck('acc-1');

      expect(result.syncKeyValid).toBe(false);
      expect(result.healthy).toBe(false);
    });

    it('should handle corrupted api key gracefully', async () => {
      mockPrisma.cloudLink.findUnique.mockResolvedValue({
        accountId: 'acc-1',
        cloudApiKey: 'corrupted-not-encrypted',
        cloudSyncKey: null,
      });

      const result = await service.healthCheck('acc-1');

      expect(result.healthy).toBe(false);
      expect(result.linked).toBe(true);
      expect(result.credentialsValid).toBe(false);
      expect(result.details).toContain('decrypt');
    });

    it('should handle no sync key (null) gracefully — syncKeyValid defaults true', async () => {
      const encryptedKey = encrypt('test-api-key');
      mockPrisma.cloudLink.findUnique.mockResolvedValue({
        accountId: 'acc-1',
        cloudApiKey: encryptedKey,
        cloudSyncKey: null,
      });
      mockFetch.mockResolvedValue({ ok: true });

      const result = await service.healthCheck('acc-1');

      expect(result.syncKeyValid).toBe(true);
      expect(result.healthy).toBe(true);
    });
  });
});

/**
 * GIN-42: SQL Injection Prevention Tests for Memory Query DTO
 *
 * Verifies that class-validator constraints on QueryMemoryDto reject
 * oversized or malformed input at the API boundary before it reaches
 * any service or database layer.
 */
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { QueryMemoryDto } from './query-memory.dto';

// Classic injection payloads
const SQL_INJECTION_PAYLOADS = [
  "'; DROP TABLE memories; --",
  "' OR '1'='1",
  "' OR 1=1 --",
  "SELECT * FROM users WHERE '1'='1",
  "1; EXEC xp_cmdshell('id') --",
];

describe('QueryMemoryDto — SQL injection input validation (GIN-42)', () => {
  function buildDto(overrides: Partial<QueryMemoryDto>): QueryMemoryDto {
    return plainToInstance(QueryMemoryDto, {
      query: 'test query',
      ...overrides,
    });
  }

  // ---------------------------------------------------------------------------
  // query field — MaxLength(2000)
  // ---------------------------------------------------------------------------
  describe('query field MaxLength constraint', () => {
    it('accepts a query within the 2000-character limit', async () => {
      const dto = buildDto({ query: 'a'.repeat(2000) });
      const errors = await validate(dto);
      const queryErrors = errors.filter((e) => e.property === 'query');
      expect(queryErrors).toHaveLength(0);
    });

    it('rejects a query exceeding 2000 characters', async () => {
      const dto = buildDto({ query: 'a'.repeat(2001) });
      const errors = await validate(dto);
      const queryErrors = errors.filter((e) => e.property === 'query');
      expect(queryErrors.length).toBeGreaterThan(0);
    });

    it('rejects an extremely long query (potential DoS / injection vector)', async () => {
      const dto = buildDto({ query: 'x'.repeat(100_000) });
      const errors = await validate(dto);
      const queryErrors = errors.filter((e) => e.property === 'query');
      expect(queryErrors.length).toBeGreaterThan(0);
    });

    it.each(SQL_INJECTION_PAYLOADS)(
      'passes short injection strings through (parameterized queries handle safety): %j',
      async (payload) => {
        // Injection strings under 2000 chars are allowed through class-validator
        // because the actual safety comes from parameterized queries in the service.
        const dto = buildDto({ query: payload });
        const errors = await validate(dto);
        const queryErrors = errors.filter((e) => e.property === 'query');
        // Short injections should NOT be rejected at the DTO level —
        // they should be safely handled by parameterized DB queries.
        expect(queryErrors).toHaveLength(0);
      },
    );
  });

  // ---------------------------------------------------------------------------
  // limit field — Min(1) / Max(1000)
  // ---------------------------------------------------------------------------
  describe('limit field numeric bounds', () => {
    it('accepts limit = 1', async () => {
      const dto = buildDto({ limit: 1 });
      const errors = await validate(dto);
      const limitErrors = errors.filter((e) => e.property === 'limit');
      expect(limitErrors).toHaveLength(0);
    });

    it('accepts limit = 1000', async () => {
      const dto = buildDto({ limit: 1000 });
      const errors = await validate(dto);
      const limitErrors = errors.filter((e) => e.property === 'limit');
      expect(limitErrors).toHaveLength(0);
    });

    it('rejects limit = 0 (below minimum)', async () => {
      const dto = buildDto({ limit: 0 });
      const errors = await validate(dto);
      const limitErrors = errors.filter((e) => e.property === 'limit');
      expect(limitErrors.length).toBeGreaterThan(0);
    });

    it('rejects limit = -1 (negative)', async () => {
      const dto = buildDto({ limit: -1 });
      const errors = await validate(dto);
      const limitErrors = errors.filter((e) => e.property === 'limit');
      expect(limitErrors.length).toBeGreaterThan(0);
    });

    it('rejects limit = 1001 (above maximum)', async () => {
      const dto = buildDto({ limit: 1001 });
      const errors = await validate(dto);
      const limitErrors = errors.filter((e) => e.property === 'limit');
      expect(limitErrors.length).toBeGreaterThan(0);
    });

    it('rejects limit = 999999 (extreme value)', async () => {
      const dto = buildDto({ limit: 999_999 });
      const errors = await validate(dto);
      const limitErrors = errors.filter((e) => e.property === 'limit');
      expect(limitErrors.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // query field — required
  // ---------------------------------------------------------------------------
  describe('query field presence', () => {
    it('rejects a missing query field', async () => {
      const dto = plainToInstance(QueryMemoryDto, { limit: 10 });
      const errors = await validate(dto);
      const queryErrors = errors.filter((e) => e.property === 'query');
      expect(queryErrors.length).toBeGreaterThan(0);
    });
  });
});

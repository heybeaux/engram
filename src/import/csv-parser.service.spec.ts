import { Test, TestingModule } from '@nestjs/testing';
import { CsvParserService } from './csv-parser.service';
import { MappingConfig } from './import.types';

describe('CsvParserService', () => {
  let service: CsvParserService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CsvParserService],
    }).compile();

    service = module.get<CsvParserService>(CsvParserService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ── parse ────────────────────────────────────────────────────────────────────

  describe('parse', () => {
    it('parses a basic CSV with headers and rows', () => {
      const csv = `name,email,notes\nAlice,alice@example.com,loves cats\nBob,bob@example.com,likes dogs`;
      const result = service.parse(Buffer.from(csv));

      expect(result.headers).toEqual(['name', 'email', 'notes']);
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0]).toEqual({
        name: 'Alice',
        email: 'alice@example.com',
        notes: 'loves cats',
      });
      expect(result.rows[1]).toEqual({
        name: 'Bob',
        email: 'bob@example.com',
        notes: 'likes dogs',
      });
    });

    it('handles CRLF line endings', () => {
      const csv = `name,email\r\nAlice,alice@example.com\r\nBob,bob@example.com`;
      const result = service.parse(Buffer.from(csv));
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0].name).toBe('Alice');
    });

    it('handles quoted fields with commas', () => {
      const csv = `name,address\n"Smith, John","123 Main St, Suite 4"\n`;
      const result = service.parse(Buffer.from(csv));
      expect(result.rows[0].name).toBe('Smith, John');
      expect(result.rows[0].address).toBe('123 Main St, Suite 4');
    });

    it('handles escaped double-quotes inside quoted fields', () => {
      const csv = `name,bio\n"Alice ""The Cat"" Jones",tester\n`;
      const result = service.parse(Buffer.from(csv));
      expect(result.rows[0].name).toBe('Alice "The Cat" Jones');
    });

    it('skips blank lines', () => {
      const csv = `name,email\nAlice,alice@example.com\n\n\nBob,bob@example.com\n`;
      const result = service.parse(Buffer.from(csv));
      expect(result.rows).toHaveLength(2);
    });

    it('fills missing columns with empty string', () => {
      const csv = `name,email,notes\nAlice,alice@example.com`;
      const result = service.parse(Buffer.from(csv));
      expect(result.rows[0].notes).toBe('');
    });

    it('throws BadRequestException on empty buffer', () => {
      expect(() => service.parse(Buffer.from(''))).toThrow('CSV file is empty');
    });

    it('throws BadRequestException on empty file (whitespace only)', () => {
      expect(() => service.parse(Buffer.from('\n   \n'))).toThrow('CSV file is empty');
    });
  });

  // ── validateHeaders ──────────────────────────────────────────────────────────

  describe('validateHeaders', () => {
    const headers = ['name', 'email', 'type', 'notes'];

    const config: MappingConfig = {
      profileMapping: {
        name: 'name',
        type: 'type',
      },
      attributeMapping: [
        { key: 'email', column: 'email', valueType: 'EMAIL' as any },
      ],
      memoryMapping: {
        content: 'notes',
      },
    };

    it('returns empty array when all columns are present', () => {
      expect(service.validateHeaders(headers, config)).toEqual([]);
    });

    it('returns missing column names', () => {
      const missingConfig: MappingConfig = {
        profileMapping: { name: 'full_name' }, // 'full_name' not in headers
        attributeMapping: [
          { key: 'email', column: 'email_address', valueType: 'EMAIL' as any }, // 'email_address' not in headers
        ],
      };
      const missing = service.validateHeaders(headers, missingConfig);
      expect(missing).toContain('full_name');
      expect(missing).toContain('email_address');
    });

    it('treats known EntityType values as static (no missing column error)', () => {
      const configWithStaticType: MappingConfig = {
        profileMapping: { name: 'name', type: 'PERSON' },
      };
      const missing = service.validateHeaders(headers, configWithStaticType);
      expect(missing).not.toContain('PERSON');
    });

    it('treats numeric strings as static importance values', () => {
      const configWithStaticImportance: MappingConfig = {
        profileMapping: { name: 'name' },
        memoryMapping: { content: 'notes', importance: '3' },
      };
      const missing = service.validateHeaders(headers, configWithStaticImportance);
      expect(missing).toHaveLength(0);
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { ImportMappingService } from './import-mapping.service';
import { CsvRow, MappingConfig } from './import.types';

describe('ImportMappingService', () => {
  let service: ImportMappingService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ImportMappingService],
    }).compile();

    service = module.get<ImportMappingService>(ImportMappingService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  const baseConfig: MappingConfig = {
    profileMapping: {
      name: 'name',
      type: 'type',
      description: 'bio',
    },
    attributeMapping: [
      {
        key: 'email',
        column: 'email',
        valueType: 'EMAIL' as any,
        category: 'contact',
      },
    ],
    memoryMapping: {
      content: 'notes',
      importance: 'priority',
    },
  };

  const validRow: CsvRow = {
    name: 'Alice Johnson',
    type: 'PERSON',
    bio: 'Head of marketing',
    email: 'alice@example.com',
    notes: 'Met at conference in 2024',
    priority: '4',
  };

  // ── Basic mapping ──────────────────────────────────────────────────────────

  describe('applyMapping', () => {
    it('maps a valid row to a MappedRecord', () => {
      const { records, errors } = service.applyMapping([validRow], baseConfig);

      expect(errors).toHaveLength(0);
      expect(records).toHaveLength(1);

      const record = records[0];
      expect(record.rowNumber).toBe(2);
      expect(record.profile.name).toBe('Alice Johnson');
      expect(record.profile.type).toBe('PERSON');
      expect(record.profile.description).toBe('Head of marketing');
    });

    it('maps attributes correctly', () => {
      const { records } = service.applyMapping([validRow], baseConfig);
      expect(records[0].attributes).toHaveLength(1);
      expect(records[0].attributes[0]).toEqual({
        key: 'email',
        value: 'alice@example.com',
        valueType: 'EMAIL',
        category: 'contact',
      });
    });

    it('maps memory content and importance', () => {
      const { records } = service.applyMapping([validRow], baseConfig);
      expect(records[0].memory).toEqual({
        content: 'Met at conference in 2024',
        importance: 4,
      });
    });

    it('skips attribute if value is empty', () => {
      const rowWithNoEmail = { ...validRow, email: '' };
      const { records } = service.applyMapping([rowWithNoEmail], baseConfig);
      expect(records[0].attributes).toHaveLength(0);
    });

    it('omits memory if content column is empty', () => {
      const rowWithNoNotes = { ...validRow, notes: '' };
      const { records } = service.applyMapping([rowWithNoNotes], baseConfig);
      expect(records[0].memory).toBeUndefined();
    });
  });

  // ── Required field validation ──────────────────────────────────────────────

  describe('name validation', () => {
    it('returns error and skips row when name is empty', () => {
      const row: CsvRow = { ...validRow, name: '' };
      const { records, errors } = service.applyMapping([row], baseConfig);

      expect(records).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0].rowNumber).toBe(2);
      expect(errors[0].message).toContain('required');
    });

    it('returns error and skips row when name is whitespace only', () => {
      const row: CsvRow = { ...validRow, name: '   ' };
      const { records, errors } = service.applyMapping([row], baseConfig);
      expect(records).toHaveLength(0);
      expect(errors[0].message).toContain('required');
    });
  });

  // ── Entity type handling ───────────────────────────────────────────────────

  describe('entity type handling', () => {
    it('defaults to PERSON when type is not provided', () => {
      const configWithNoType: MappingConfig = {
        profileMapping: { name: 'name' },
      };
      const row: CsvRow = { name: 'Acme Corp' };
      const { records } = service.applyMapping([row], configWithNoType);
      expect(records[0].profile.type).toBe('PERSON');
    });

    it('uses static EntityType value when column not in row', () => {
      const configWithStatic: MappingConfig = {
        profileMapping: { name: 'name', type: 'ORGANIZATION' },
      };
      const row: CsvRow = { name: 'Acme Corp' };
      const { records } = service.applyMapping([row], configWithStatic);
      expect(records[0].profile.type).toBe('ORGANIZATION');
    });

    it('generates non-fatal error on invalid type and defaults to PERSON', () => {
      const row: CsvRow = { ...validRow, type: 'ROBOT' };
      const { records, errors } = service.applyMapping([row], baseConfig);
      expect(records).toHaveLength(1); // row not skipped
      expect(records[0].profile.type).toBe('PERSON');
      expect(errors[0].message).toContain('Invalid entity type');
    });
  });

  // ── Importance validation ──────────────────────────────────────────────────

  describe('importance validation', () => {
    it('generates non-fatal error on invalid importance but keeps the record', () => {
      const row: CsvRow = { ...validRow, priority: 'high' };
      const { records, errors } = service.applyMapping([row], baseConfig);
      expect(records).toHaveLength(1);
      expect(errors.some((e) => e.message.includes('importance'))).toBe(true);
      expect(records[0].memory?.importance).toBeUndefined();
    });

    it('clamps and rounds importance to nearest integer', () => {
      const row: CsvRow = { ...validRow, priority: '3.7' };
      const { records } = service.applyMapping([row], baseConfig);
      expect(records[0].memory?.importance).toBe(4);
    });
  });

  // ── Multiple rows ──────────────────────────────────────────────────────────

  describe('multiple rows', () => {
    it('processes valid and invalid rows independently', () => {
      const rows: CsvRow[] = [
        validRow,
        { ...validRow, name: '', notes: 'bad row' },
        { ...validRow, name: 'Bob', email: 'bob@example.com' },
      ];

      const { records, errors } = service.applyMapping(rows, baseConfig);
      expect(records).toHaveLength(2); // row 2 (valid) + row 4 (valid)
      expect(errors).toHaveLength(1); // row 3 name error
      expect(errors[0].rowNumber).toBe(3);
    });

    it('assigns correct row numbers (header is row 1)', () => {
      const rows: CsvRow[] = [validRow, { ...validRow, name: 'Bob' }];
      const { records } = service.applyMapping(rows, baseConfig);
      expect(records[0].rowNumber).toBe(2);
      expect(records[1].rowNumber).toBe(3);
    });
  });
});

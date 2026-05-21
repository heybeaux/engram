import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ImportPreviewService } from './import-preview.service';
import { CsvParserService } from '../import/csv-parser.service';
import { ImportMappingService } from '../import/import-mapping.service';
import { MappingConfig, MappedRecord } from '../import/import.types';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockCsvParser = {
  parse: jest.fn(),
  validateHeaders: jest.fn(),
};

const mockMappingService = {
  applyMapping: jest.fn(),
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<MappingConfig> = {}): MappingConfig {
  return {
    profileMapping: { name: 'full_name', type: 'person', description: 'bio' },
    ...overrides,
  };
}

function makeParsedCsv(
  rowCount: number,
  headers = ['full_name', 'bio', 'notes'],
) {
  const rows = Array.from({ length: rowCount }, (_, i) => ({
    full_name: `Person ${i + 1}`,
    bio: `Bio ${i + 1}`,
    notes: `Note ${i + 1}`,
  }));
  return { headers, rows };
}

function makeMappedRecord(rowNumber: number, withMemory = false): MappedRecord {
  return {
    rowNumber,
    profile: {
      name: `Person ${rowNumber}`,
      type: 'person' as any,
      description: `Bio ${rowNumber}`,
    },
    attributes: [],
    memory: withMemory
      ? { content: `Memory for row ${rowNumber}`, importance: 3 }
      : undefined,
  };
}

function makeMappingResult(
  count: number,
  withMemory = false,
  errors: any[] = [],
) {
  return {
    records: Array.from({ length: count }, (_, i) =>
      makeMappedRecord(i + 1, withMemory),
    ),
    errors,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ImportPreviewService', () => {
  let service: ImportPreviewService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ImportPreviewService,
        { provide: CsvParserService, useValue: mockCsvParser },
        { provide: ImportMappingService, useValue: mockMappingService },
      ],
    }).compile();

    service = module.get<ImportPreviewService>(ImportPreviewService);
  });

  // ── Happy paths ───────────────────────────────────────────────────────────

  describe('preview — happy paths', () => {
    it('should return profiles for parsed and mapped rows', async () => {
      const parsed = makeParsedCsv(3);
      mockCsvParser.parse.mockReturnValue(parsed);
      mockCsvParser.validateHeaders.mockReturnValue([]);
      mockMappingService.applyMapping.mockReturnValue(makeMappingResult(3));

      const result = await service.preview(Buffer.from('csv'), makeConfig());

      expect(result.profiles).toHaveLength(3);
      expect(result.stats.profileCount).toBe(3);
    });

    it('should return memories only for records that have them', async () => {
      const parsed = makeParsedCsv(3);
      mockCsvParser.parse.mockReturnValue(parsed);
      mockCsvParser.validateHeaders.mockReturnValue([]);
      mockMappingService.applyMapping.mockReturnValue({
        records: [
          makeMappedRecord(1, true),
          makeMappedRecord(2, false),
          makeMappedRecord(3, true),
        ],
        errors: [],
      });

      const result = await service.preview(Buffer.from('csv'), makeConfig());

      expect(result.memories).toHaveLength(2);
      expect(result.stats.memoryCount).toBe(2);
    });

    it('should return empty memories when no records have memory', async () => {
      mockCsvParser.parse.mockReturnValue(makeParsedCsv(2));
      mockCsvParser.validateHeaders.mockReturnValue([]);
      mockMappingService.applyMapping.mockReturnValue(
        makeMappingResult(2, false),
      );

      const result = await service.preview(Buffer.from('csv'), makeConfig());

      expect(result.memories).toEqual([]);
      expect(result.stats.memoryCount).toBe(0);
    });

    it('should include mapping errors in the result', async () => {
      mockCsvParser.parse.mockReturnValue(makeParsedCsv(2));
      mockCsvParser.validateHeaders.mockReturnValue([]);
      const errors = [{ rowNumber: 2, message: 'Name column empty' }];
      mockMappingService.applyMapping.mockReturnValue({
        records: [makeMappedRecord(1)],
        errors,
      });

      const result = await service.preview(Buffer.from('csv'), makeConfig());

      expect(result.errors).toHaveLength(1);
      expect(result.stats.errorCount).toBe(1);
    });

    it('should map profile fields correctly', async () => {
      mockCsvParser.parse.mockReturnValue(makeParsedCsv(1));
      mockCsvParser.validateHeaders.mockReturnValue([]);
      mockMappingService.applyMapping.mockReturnValue({
        records: [makeMappedRecord(1, true)],
        errors: [],
      });

      const result = await service.preview(Buffer.from('csv'), makeConfig());

      expect(result.profiles[0]).toMatchObject({
        rowNumber: 1,
        name: 'Person 1',
        hasMemory: true,
      });
    });

    it('should map memory content and importance correctly', async () => {
      mockCsvParser.parse.mockReturnValue(makeParsedCsv(1));
      mockCsvParser.validateHeaders.mockReturnValue([]);
      mockMappingService.applyMapping.mockReturnValue({
        records: [makeMappedRecord(1, true)],
        errors: [],
      });

      const result = await service.preview(Buffer.from('csv'), makeConfig());

      expect(result.memories[0]).toMatchObject({
        rowNumber: 1,
        content: 'Memory for row 1',
        importance: 3,
      });
    });

    it('should pass the fileBuffer to the csv parser', async () => {
      const buf = Buffer.from('col1,col2\nval1,val2');
      mockCsvParser.parse.mockReturnValue(makeParsedCsv(1));
      mockCsvParser.validateHeaders.mockReturnValue([]);
      mockMappingService.applyMapping.mockReturnValue(makeMappingResult(1));

      await service.preview(buf, makeConfig());

      expect(mockCsvParser.parse).toHaveBeenCalledWith(buf);
    });

    it('should pass headers and config to validateHeaders', async () => {
      const parsed = makeParsedCsv(1, ['full_name', 'bio']);
      mockCsvParser.parse.mockReturnValue(parsed);
      mockCsvParser.validateHeaders.mockReturnValue([]);
      mockMappingService.applyMapping.mockReturnValue(makeMappingResult(1));

      const config = makeConfig();
      await service.preview(Buffer.from('csv'), config);

      expect(mockCsvParser.validateHeaders).toHaveBeenCalledWith(
        parsed.headers,
        config,
      );
    });

    it('should pass sliced rows (not full dataset) to applyMapping', async () => {
      const parsed = makeParsedCsv(1);
      mockCsvParser.parse.mockReturnValue(parsed);
      mockCsvParser.validateHeaders.mockReturnValue([]);
      mockMappingService.applyMapping.mockReturnValue(makeMappingResult(1));

      const config = makeConfig();
      await service.preview(Buffer.from('csv'), config);

      expect(mockMappingService.applyMapping).toHaveBeenCalledWith(
        parsed.rows,
        config,
      );
    });

    it('should return correct stats', async () => {
      mockCsvParser.parse.mockReturnValue(makeParsedCsv(5));
      mockCsvParser.validateHeaders.mockReturnValue([]);
      mockMappingService.applyMapping.mockReturnValue({
        records: [makeMappedRecord(1, true), makeMappedRecord(2, false)],
        errors: [{ rowNumber: 3, message: 'err' }],
      });

      const result = await service.preview(Buffer.from('csv'), makeConfig());

      expect(result.stats).toEqual({
        profileCount: 2,
        memoryCount: 1,
        errorCount: 1,
      });
    });

    it('should handle empty CSV gracefully', async () => {
      mockCsvParser.parse.mockReturnValue({ headers: ['full_name'], rows: [] });
      mockCsvParser.validateHeaders.mockReturnValue([]);
      mockMappingService.applyMapping.mockReturnValue({
        records: [],
        errors: [],
      });

      const result = await service.preview(Buffer.from(''), makeConfig());

      expect(result.profiles).toEqual([]);
      expect(result.memories).toEqual([]);
      expect(result.stats).toEqual({
        profileCount: 0,
        memoryCount: 0,
        errorCount: 0,
      });
    });
  });

  // ── MAX_PREVIEW_ROWS cap ──────────────────────────────────────────────────

  describe('preview — row limiting', () => {
    it('should limit rows to 100 before calling applyMapping', async () => {
      const parsed = makeParsedCsv(150);
      mockCsvParser.parse.mockReturnValue(parsed);
      mockCsvParser.validateHeaders.mockReturnValue([]);
      mockMappingService.applyMapping.mockReturnValue(makeMappingResult(100));

      await service.preview(Buffer.from('csv'), makeConfig());

      const passedRows = mockMappingService.applyMapping.mock.calls[0][0];
      expect(passedRows).toHaveLength(100);
    });

    it('should not limit when row count is exactly 100', async () => {
      const parsed = makeParsedCsv(100);
      mockCsvParser.parse.mockReturnValue(parsed);
      mockCsvParser.validateHeaders.mockReturnValue([]);
      mockMappingService.applyMapping.mockReturnValue(makeMappingResult(100));

      await service.preview(Buffer.from('csv'), makeConfig());

      const passedRows = mockMappingService.applyMapping.mock.calls[0][0];
      expect(passedRows).toHaveLength(100);
    });

    it('should not limit when row count is under 100', async () => {
      const parsed = makeParsedCsv(42);
      mockCsvParser.parse.mockReturnValue(parsed);
      mockCsvParser.validateHeaders.mockReturnValue([]);
      mockMappingService.applyMapping.mockReturnValue(makeMappingResult(42));

      await service.preview(Buffer.from('csv'), makeConfig());

      const passedRows = mockMappingService.applyMapping.mock.calls[0][0];
      expect(passedRows).toHaveLength(42);
    });
  });

  // ── Error handling ────────────────────────────────────────────────────────

  describe('preview — error handling', () => {
    it('should throw BadRequestException when required columns are missing', async () => {
      mockCsvParser.parse.mockReturnValue(makeParsedCsv(3, ['wrong_col']));
      mockCsvParser.validateHeaders.mockReturnValue(['full_name', 'bio']);

      await expect(
        service.preview(Buffer.from('csv'), makeConfig()),
      ).rejects.toThrow(BadRequestException);
    });

    it('should include missing column names in the error message', async () => {
      mockCsvParser.parse.mockReturnValue(makeParsedCsv(1, ['other']));
      mockCsvParser.validateHeaders.mockReturnValue(['full_name', 'bio']);

      await expect(
        service.preview(Buffer.from('csv'), makeConfig()),
      ).rejects.toThrow('CSV is missing mapped columns: full_name, bio');
    });

    it('should throw when exactly one column is missing', async () => {
      mockCsvParser.parse.mockReturnValue(makeParsedCsv(1, ['bio']));
      mockCsvParser.validateHeaders.mockReturnValue(['full_name']);

      await expect(
        service.preview(Buffer.from('csv'), makeConfig()),
      ).rejects.toThrow('CSV is missing mapped columns: full_name');
    });

    it('should propagate errors thrown by csvParser.parse', async () => {
      mockCsvParser.parse.mockImplementation(() => {
        throw new Error('Malformed CSV');
      });

      await expect(
        service.preview(Buffer.from('bad'), makeConfig()),
      ).rejects.toThrow('Malformed CSV');
    });

    it('should propagate errors thrown by applyMapping', async () => {
      mockCsvParser.parse.mockReturnValue(makeParsedCsv(1));
      mockCsvParser.validateHeaders.mockReturnValue([]);
      mockMappingService.applyMapping.mockImplementation(() => {
        throw new Error('Mapping failure');
      });

      await expect(
        service.preview(Buffer.from('csv'), makeConfig()),
      ).rejects.toThrow('Mapping failure');
    });
  });
});

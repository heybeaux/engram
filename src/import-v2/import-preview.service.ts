import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { CsvParserService } from '../import/csv-parser.service';
import { ImportMappingService } from '../import/import-mapping.service';
import { MappingConfig, PreviewResult, PreviewProfile, PreviewMemory } from '../import/import.types';

/**
 * ImportPreviewService
 *
 * Applies CSV parsing + column mapping but performs NO database writes.
 * Returns the first 100 rows as they would be imported, along with errors.
 */
@Injectable()
export class ImportPreviewService {
  private readonly logger = new Logger(ImportPreviewService.name);
  private readonly MAX_PREVIEW_ROWS = 100;

  constructor(
    private readonly csvParser: CsvParserService,
    private readonly mappingService: ImportMappingService,
  ) {}

  /**
   * Parse the CSV and apply the mapping config without writing to DB.
   * Returns a preview of up to 100 rows.
   */
  async preview(fileBuffer: Buffer, config: MappingConfig): Promise<PreviewResult> {
    // Parse CSV
    const parsed = this.csvParser.parse(fileBuffer);

    // Validate column references
    const missingColumns = this.csvParser.validateHeaders(parsed.headers, config);
    if (missingColumns.length > 0) {
      throw new BadRequestException(
        `CSV is missing mapped columns: ${missingColumns.join(', ')}`,
      );
    }

    // Limit to first 100 rows for preview
    const previewRows = parsed.rows.slice(0, this.MAX_PREVIEW_ROWS);

    // Apply mapping
    const { records, errors } = this.mappingService.applyMapping(previewRows, config);

    // Build preview profiles
    const profiles: PreviewProfile[] = records.map((r) => ({
      rowNumber: r.rowNumber,
      name: r.profile.name,
      type: r.profile.type,
      description: r.profile.description,
      attributeCount: r.attributes.length,
      hasMemory: !!r.memory,
    }));

    // Build preview memories
    const memories: PreviewMemory[] = records
      .filter((r) => !!r.memory)
      .map((r) => ({
        rowNumber: r.rowNumber,
        content: r.memory!.content,
        importance: r.memory!.importance,
      }));

    const stats = {
      profileCount: profiles.length,
      memoryCount: memories.length,
      errorCount: errors.length,
    };

    this.logger.debug(
      `Preview: ${stats.profileCount} profiles, ${stats.memoryCount} memories, ${stats.errorCount} errors (from ${previewRows.length} rows)`,
    );

    return { profiles, memories, errors, stats };
  }
}

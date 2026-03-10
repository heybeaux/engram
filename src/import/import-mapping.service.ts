import { Injectable, Logger } from '@nestjs/common';
import { AttributeType, EntityType } from '@prisma/client';
import {
  CsvRow,
  MappingConfig,
  MappedRecord,
  MappedAttribute,
  MappedMemory,
  RowError,
} from './import.types';

export interface MappingResult {
  records: MappedRecord[];
  errors: RowError[];
}

const VALID_ENTITY_TYPES = new Set(Object.values(EntityType));
const DEFAULT_ENTITY_TYPE: EntityType = EntityType.PERSON;

/**
 * ImportMappingService
 *
 * Converts parsed CSV rows into MappedRecord objects using a MappingConfig.
 * Validates required fields and returns per-row errors for invalid rows.
 */
@Injectable()
export class ImportMappingService {
  private readonly logger = new Logger(ImportMappingService.name);

  /**
   * Apply mapping config to parsed CSV rows.
   * Returns valid MappedRecords and per-row RowErrors.
   */
  applyMapping(rows: CsvRow[], config: MappingConfig): MappingResult {
    const records: MappedRecord[] = [];
    const errors: RowError[] = [];

    rows.forEach((row, index) => {
      const rowNumber = index + 2; // 1-indexed, row 1 is the header
      const rowErrors: RowError[] = [];

      // ── Profile mapping ─────────────────────────────────────────────────────

      const name = this.resolveValue(row, config.profileMapping.name);
      if (!name || !name.trim()) {
        rowErrors.push({
          rowNumber,
          column: config.profileMapping.name,
          message: 'Profile name is required and cannot be empty',
        });
      }

      const rawType = config.profileMapping.type
        ? this.resolveValue(row, config.profileMapping.type)
        : undefined;
      const type = this.resolveEntityType(rawType, rowNumber, rowErrors, config.profileMapping.type);

      const description = config.profileMapping.description
        ? this.resolveValue(row, config.profileMapping.description) || undefined
        : undefined;

      // ── Attribute mapping ───────────────────────────────────────────────────

      const attributes: MappedAttribute[] = [];
      if (config.attributeMapping) {
        for (const attrConfig of config.attributeMapping) {
          const value = row[attrConfig.column] ?? '';
          if (!value.trim()) continue; // skip empty attribute values

          attributes.push({
            key: attrConfig.key,
            value: value.trim(),
            valueType: attrConfig.valueType ?? AttributeType.STRING,
            category: attrConfig.category,
          });
        }
      }

      // ── Memory mapping ──────────────────────────────────────────────────────

      let memory: MappedMemory | undefined;
      if (config.memoryMapping) {
        const content = row[config.memoryMapping.content] ?? '';
        if (content.trim()) {
          const rawImportance = config.memoryMapping.importance
            ? this.resolveValue(row, config.memoryMapping.importance)
            : undefined;

          const importance = rawImportance
            ? this.parseImportance(rawImportance, rowNumber, rowErrors, config.memoryMapping.importance)
            : undefined;

          memory = { content: content.trim(), importance };
        }
      }

      // ── Collect results ─────────────────────────────────────────────────────

      errors.push(...rowErrors);

      if (rowErrors.some((e) => e.rowNumber === rowNumber && e.message.includes('required'))) {
        // Skip rows with fatal errors (missing required name)
        this.logger.debug(`Row ${rowNumber} skipped due to validation errors`);
        return;
      }

      records.push({
        rowNumber,
        profile: { name: name!.trim(), type, description },
        attributes,
        memory,
      });
    });

    this.logger.debug(
      `Mapping complete: ${records.length} valid records, ${errors.length} errors`,
    );

    return { records, errors };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Resolve a value: if the key exists in the row, use that column's value;
   * otherwise treat the key itself as a static value.
   */
  private resolveValue(row: CsvRow, key: string): string {
    if (key in row) return row[key] ?? '';
    return key; // static fallback
  }

  /**
   * Parse and validate EntityType. Falls back to DEFAULT_ENTITY_TYPE on invalid.
   */
  private resolveEntityType(
    raw: string | undefined,
    rowNumber: number,
    errors: RowError[],
    column?: string,
  ): EntityType {
    if (!raw) return DEFAULT_ENTITY_TYPE;

    const upper = raw.toUpperCase() as EntityType;
    if (VALID_ENTITY_TYPES.has(upper)) return upper;

    errors.push({
      rowNumber,
      column,
      message: `Invalid entity type "${raw}". Valid values: ${[...VALID_ENTITY_TYPES].join(', ')}. Defaulting to ${DEFAULT_ENTITY_TYPE}.`,
    });
    return DEFAULT_ENTITY_TYPE;
  }

  /**
   * Parse and validate importance value (1–5). Returns undefined on invalid.
   */
  private parseImportance(
    raw: string,
    rowNumber: number,
    errors: RowError[],
    column?: string,
  ): number | undefined {
    const num = parseFloat(raw);
    if (isNaN(num) || num < 1 || num > 5) {
      errors.push({
        rowNumber,
        column,
        message: `Invalid importance value "${raw}". Must be a number between 1 and 5.`,
      });
      return undefined;
    }
    return Math.round(num);
  }
}

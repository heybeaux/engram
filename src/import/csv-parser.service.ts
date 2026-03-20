import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { MappingConfig, ParsedCsv, CsvRow } from './import.types';

/**
 * CsvParserService
 *
 * Parses a CSV buffer into rows. Uses a hand-rolled RFC 4180-compliant parser
 * so there is no dependency on csv-parse (which is not installed).
 *
 * Validates that all columns referenced in the mapping config are present.
 */
@Injectable()
export class CsvParserService {
  private readonly logger = new Logger(CsvParserService.name);

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Parse a CSV buffer into headers + rows.
   * Throws BadRequestException on structural errors.
   */
  parse(buffer: Buffer): ParsedCsv {
    const text = buffer.toString('utf8');
    const text2 = text.trim();
    if (!text2) {
      throw new BadRequestException('CSV file is empty');
    }

    const lines = this.splitLines(text2);

    const headers = this.parseRow(lines[0]);
    if (headers.length === 0) {
      throw new BadRequestException('CSV header row is empty');
    }

    const rows: CsvRow[] = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue; // skip blank lines

      const values = this.parseRow(line);
      const row: CsvRow = {};
      headers.forEach((header, idx) => {
        row[header] = values[idx] ?? '';
      });
      rows.push(row);
    }

    this.logger.debug(
      `Parsed CSV: ${headers.length} columns, ${rows.length} data rows`,
    );
    return { headers, rows };
  }

  /**
   * Validate that all columns referenced in the mapping config are present
   * in the CSV headers. Returns a list of missing columns.
   */
  validateHeaders(headers: string[], config: MappingConfig): string[] {
    const missing: string[] = [];
    const headerSet = new Set(headers);

    const { profileMapping, attributeMapping, memoryMapping } = config;

    // Profile mapping — name is always required; type/description are optional
    if (
      profileMapping.name &&
      !this.isStaticValue(profileMapping.name, headers)
    ) {
      if (!headerSet.has(profileMapping.name)) {
        missing.push(profileMapping.name);
      }
    }
    if (
      profileMapping.type &&
      !this.isStaticValue(profileMapping.type, headers)
    ) {
      if (!headerSet.has(profileMapping.type)) {
        missing.push(profileMapping.type);
      }
    }
    if (
      profileMapping.description &&
      !this.isStaticValue(profileMapping.description, headers)
    ) {
      if (!headerSet.has(profileMapping.description)) {
        missing.push(profileMapping.description);
      }
    }

    // Attribute mappings
    if (attributeMapping) {
      for (const attr of attributeMapping) {
        if (!headerSet.has(attr.column)) {
          missing.push(attr.column);
        }
      }
    }

    // Memory mapping
    if (memoryMapping) {
      if (!headerSet.has(memoryMapping.content)) {
        missing.push(memoryMapping.content);
      }
      if (
        memoryMapping.importance &&
        !this.isStaticValue(memoryMapping.importance, headers) &&
        !headerSet.has(memoryMapping.importance)
      ) {
        missing.push(memoryMapping.importance);
      }
    }

    return [...new Set(missing)]; // deduplicate
  }

  // ── Private Helpers ─────────────────────────────────────────────────────────

  /**
   * A value is treated as "static" (not a column reference) when it is not
   * present in the header list AND appears to be a literal value (e.g. an
   * entity type like "PERSON" or a number like "3").
   *
   * We only treat it as static when it matches a known EntityType or is a
   * numeric string so that we don't accidentally ignore a real missing column.
   */
  private isStaticValue(value: string, headers: string[]): boolean {
    if (headers.includes(value)) return false;
    const knownEntityTypes = [
      'PERSON',
      'ORGANIZATION',
      'PROJECT',
      'BRAND',
      'PRODUCT',
    ];
    if (knownEntityTypes.includes(value.toUpperCase())) return true;
    if (/^\d+(\.\d+)?$/.test(value)) return true;
    return false;
  }

  /** Split text into non-empty lines, handling \r\n and \n */
  private splitLines(text: string): string[] {
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  }

  /**
   * Parse a single CSV row following RFC 4180:
   * - Fields may be wrapped in double-quotes
   * - Double-quotes inside quoted fields are escaped as ""
   * - Commas inside quoted fields are allowed
   */
  private parseRow(line: string): string[] {
    const fields: string[] = [];
    let i = 0;

    while (i <= line.length) {
      if (i === line.length) {
        // Trailing comma: push empty field
        if (fields.length > 0 && line[line.length - 1] === ',') {
          fields.push('');
        }
        break;
      }

      if (line[i] === '"') {
        // Quoted field
        i++; // skip opening quote
        let field = '';
        while (i < line.length) {
          if (line[i] === '"') {
            if (line[i + 1] === '"') {
              // Escaped quote
              field += '"';
              i += 2;
            } else {
              // Closing quote
              i++;
              break;
            }
          } else {
            field += line[i];
            i++;
          }
        }
        fields.push(field);
        // Skip delimiter
        if (line[i] === ',') i++;
      } else {
        // Unquoted field
        const end = line.indexOf(',', i);
        if (end === -1) {
          fields.push(line.slice(i));
          break;
        } else {
          fields.push(line.slice(i, end));
          i = end + 1;
        }
      }
    }

    return fields;
  }
}

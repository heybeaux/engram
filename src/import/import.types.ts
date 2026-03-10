import { AttributeType, EntityType } from '@prisma/client';

// ── Mapping Config ────────────────────────────────────────────────────────────

export interface ProfileMappingConfig {
  /** CSV column name (or static value) that maps to profile name */
  name: string;
  /** CSV column name (or static string) for entity type */
  type?: string;
  /** CSV column name (or static string) for description */
  description?: string;
}

export interface AttributeMappingConfig {
  /** The attribute key (e.g. "email") */
  key: string;
  /** The CSV column name that holds the value */
  column: string;
  /** Attribute value type */
  valueType?: AttributeType;
  /** Optional attribute category */
  category?: string;
}

export interface MemoryMappingConfig {
  /** CSV column name that holds memory content */
  content: string;
  /** CSV column name or static number for importance (1–5) */
  importance?: string;
}

export interface MappingConfig {
  profileMapping: ProfileMappingConfig;
  attributeMapping?: AttributeMappingConfig[];
  memoryMapping?: MemoryMappingConfig;
}

// ── Parsed CSV ────────────────────────────────────────────────────────────────

export type CsvRow = Record<string, string>;

export interface ParsedCsv {
  headers: string[];
  rows: CsvRow[];
}

// ── Mapped Record ─────────────────────────────────────────────────────────────

export interface MappedAttribute {
  key: string;
  value: string;
  valueType: AttributeType;
  category?: string;
}

export interface MappedMemory {
  content: string;
  importance?: number;
}

export interface MappedRecord {
  rowNumber: number;
  profile: {
    name: string;
    type: EntityType;
    description?: string;
  };
  attributes: MappedAttribute[];
  memory?: MappedMemory;
}

// ── Row Errors ────────────────────────────────────────────────────────────────

export interface RowError {
  rowNumber: number;
  column?: string;
  message: string;
}

// ── Preview / Results ─────────────────────────────────────────────────────────

export interface PreviewProfile {
  rowNumber: number;
  name: string;
  type: string;
  description?: string;
  attributeCount: number;
  hasMemory: boolean;
}

export interface PreviewMemory {
  rowNumber: number;
  content: string;
  importance?: number;
}

export interface ImportStats {
  profileCount: number;
  memoryCount: number;
  errorCount: number;
}

export interface PreviewResult {
  profiles: PreviewProfile[];
  memories: PreviewMemory[];
  errors: RowError[];
  stats: ImportStats;
}

// ── Job Status ────────────────────────────────────────────────────────────────

export type JobStatus = 'PROCESSING' | 'COMPLETED' | 'FAILED';

export interface ImportJobState {
  jobId: string;
  userId: string;
  status: JobStatus;
  progress: number;
  stats: ImportStats;
  errors: RowError[];
  createdAt: Date;
  updatedAt: Date;
}

// ── BullMQ Job Data ───────────────────────────────────────────────────────────

export interface BulkImportJobData {
  jobId: string;
  userId: string;
  /** Base64-encoded CSV buffer */
  fileBase64: string;
  config: MappingConfig;
}

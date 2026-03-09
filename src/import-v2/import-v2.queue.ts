export const BULK_IMPORT_V2_QUEUE = 'bulk-import-v2';

export const BULK_IMPORT_V2_JOBS = {
  PROCESS_IMPORT: 'bulk-import:process',
} as const;

export interface BulkImportV2JobData {
  jobId: string;
  userId: string;
  agentId: string;
  /** Base64-encoded CSV buffer */
  fileBase64: string;
  config: {
    profileMapping: {
      name: string;
      type?: string;
      description?: string;
    };
    attributeMapping?: Array<{
      key: string;
      column: string;
      valueType?: string;
      category?: string;
    }>;
    memoryMapping?: {
      content?: string;
      importance?: string;
    };
  };
}

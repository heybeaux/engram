export const EMBEDDING_QUEUE = 'memory-embedding';
export const EMBEDDING_JOBS = {
  EMBED_MEMORY: 'embed-memory',
} as const;
export interface EmbedMemoryJobContext {
  timestamp?: Date | string;
  turnIndex?: number;
  conversationId?: string;
  userName?: string;
}

export interface EmbedMemoryJobData {
  memoryId: string;
  userId: string;
  raw: string;
  runDedup?: boolean;
  context?: EmbedMemoryJobContext;
}

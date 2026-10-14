import {
  IsString,
  IsEnum,
  IsOptional,
  IsArray,
  ValidateNested,
  IsNumber,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum MessageRole {
  USER = 'user',
  ASSISTANT = 'assistant',
  SYSTEM = 'system',
}

export class MessageTurnDto {
  @IsEnum(MessageRole)
  role: MessageRole;

  @IsString()
  content: string;

  @IsOptional()
  @IsString()
  timestamp?: string; // ISO timestamp
}

export class ObserveDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MessageTurnDto)
  turns: MessageTurnDto[];

  @IsOptional()
  @IsString()
  sessionId?: string;

  @IsOptional()
  @IsString()
  projectId?: string;

  @IsOptional()
  @IsNumber()
  minImportance?: number; // 0-1, filter out low importance extractions

  // v0.9: Pool-scoped memory write
  @IsOptional()
  @IsString()
  poolId?: string;

  // v0.9: Agent session key for attribution
  @IsOptional()
  @IsString()
  agentSessionKey?: string;

  // ENG-59: name of the assistant that produced ASSISTANT turns ("Rook")
  @IsOptional()
  @IsString()
  agentName?: string;
}

export interface ImportanceSignal {
  type: 'explicit' | 'correction' | 'preference' | 'repetition';
  trigger: string; // The phrase or pattern that triggered this
  content: string; // The content associated with this signal
  turnIndex: number;
  confidence: number; // 0-1
}

export interface ExtractedMemory {
  content: string;
  importance: number;
  signals: ImportanceSignal[];
  source: {
    turnIndex: number;
    role: MessageRole;
  };
}

export interface ObserveResult {
  memories: ExtractedMemory[];
  created: number;
  skipped: number; // Below importance threshold
  signals: ImportanceSignal[];
  processingMs: number;
}

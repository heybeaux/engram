import {
  IsArray,
  IsString,
  IsOptional,
  IsNumber,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { MessageRole, MessageTurnDto } from '../../auto/dto/observe.dto';

export class SummarizeDto {
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
  minImportance?: number;
}

export interface SummaryFact {
  content: string;
  category: 'fact' | 'decision' | 'preference' | 'action_item';
  confidence: number;
  sourceTurnIndices: number[];
  /** Role of the first cited source turn (set when OBSERVE_SPEAKER_AWARE). */
  sourceRole?: MessageRole;
}

export interface SummarizeResult {
  facts: SummaryFact[];
  created: number;
  totalTurns: number;
  processingMs: number;
}

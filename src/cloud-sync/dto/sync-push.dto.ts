import {
  IsArray,
  IsString,
  IsOptional,
  IsNumber,
  IsEnum,
  ValidateNested,
  ArrayMaxSize,
  IsISO8601,
  Validate,
} from 'class-validator';
import { ObservedAtNotFarFutureConstraint } from '../../memory/dto/create-memory.dto';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TemporalWarning } from '../../memory/memory.types';

export class SyncMemoryEntityDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty()
  @IsString()
  type: string;

  @ApiProperty()
  @IsString()
  normalizedName: string;
}

export class SyncMemoryExtractionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  who?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  what?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  when?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  whereCtx?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  why?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  how?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  topics?: string[];
}

export class SyncMemoryPayloadDto {
  @ApiProperty()
  @IsString()
  raw: string;

  @ApiProperty()
  @IsString()
  layer: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  memoryType?: string;

  @ApiProperty()
  @IsString()
  source: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  importanceHint?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  importanceScore?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  effectiveScore?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  priority?: number;

  @ApiProperty()
  @IsString()
  contentHash: string;

  @ApiProperty({ description: 'Source memory ID on the local instance' })
  @IsString()
  localId: string;

  @ApiProperty()
  @IsString()
  instanceId: string;

  @ApiPropertyOptional({ description: 'Agent name for attribution mapping' })
  @IsOptional()
  @IsString()
  agentName?: string;

  @ApiPropertyOptional({ description: 'Local agent ID for mapping' })
  @IsOptional()
  @IsString()
  localAgentId?: string;

  @ApiPropertyOptional({
    description: 'User external ID for attribution mapping',
  })
  @IsOptional()
  @IsString()
  userExternalId?: string;

  @ApiPropertyOptional({ description: 'Local user ID for mapping' })
  @IsOptional()
  @IsString()
  localUserId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  createdAt?: string;

  @ApiPropertyOptional({
    description:
      'When the event occurred (vs when recorded). ISO 8601. Reject if >1h in future.',
  })
  @IsOptional()
  @IsISO8601()
  @Validate(ObservedAtNotFarFutureConstraint)
  observedAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateNested()
  @Type(() => SyncMemoryExtractionDto)
  extraction?: SyncMemoryExtractionDto;

  @ApiPropertyOptional({ type: [SyncMemoryEntityDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SyncMemoryEntityDto)
  entities?: SyncMemoryEntityDto[];
}

export class SyncPushDto {
  @ApiProperty({ type: [SyncMemoryPayloadDto] })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => SyncMemoryPayloadDto)
  memories: SyncMemoryPayloadDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  syncProtocolVersion?: number;
}

export interface SyncPushResultItem {
  sourceMemoryId: string;
  cloudMemoryId?: string;
  status: 'created' | 'updated' | 'skipped' | 'failed';
  error?: string;
  /**
   * Temporal anchoring T6: per-item structured warnings.
   * Emits `HISTORICAL_WITHOUT_ANCHOR` for memories pushed with
   * `source = HISTORICAL` and no `observedAt`. Per-item (not top-level) here
   * because the sync response already has per-item rows.
   */
  warnings?: TemporalWarning[];
}

export interface SyncPushResponse {
  results: SyncPushResultItem[];
}

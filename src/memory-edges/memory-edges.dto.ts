import {
  IsString,
  IsOptional,
  IsNumber,
  IsArray,
  IsIn,
  IsDateString,
  IsObject,
  Min,
  Max,
  IsInt,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export const EDGE_TYPES = [
  'caused_by',
  'led_to',
  'contradicts',
  'supersedes',
  'related_to',
  'temporal_next',
  'implements',
  'learned_from',
  'failed_attempt',
] as const;

export type EdgeType = (typeof EDGE_TYPES)[number];

export class CreateMemoryEdgeDto {
  @ApiProperty()
  @IsString()
  sourceId: string;

  @ApiProperty()
  @IsString()
  targetId: string;

  @ApiProperty({ enum: EDGE_TYPES })
  @IsString()
  @IsIn(EDGE_TYPES)
  edgeType: string;

  @ApiPropertyOptional({ default: 0.5 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  weight?: number;

  @ApiPropertyOptional({ default: 0.5 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  confidence?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  temporalStart?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  temporalEnd?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  createdBy?: string;

  @ApiPropertyOptional({ default: {} })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

export class GetEdgesQueryDto {
  @ApiPropertyOptional({
    enum: ['outgoing', 'incoming', 'both'],
    default: 'both',
  })
  @IsOptional()
  @IsString()
  @IsIn(['outgoing', 'incoming', 'both'])
  direction?: 'outgoing' | 'incoming' | 'both';

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  edgeTypes?: string[];
}

export class FindRelatedDto {
  @ApiProperty()
  @IsString()
  nodeId: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  @Type(() => Number)
  depth?: number;

  @ApiPropertyOptional({ type: [String], enum: EDGE_TYPES })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  edgeTypes?: string[];
}

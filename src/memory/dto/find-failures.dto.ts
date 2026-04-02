import {
  IsString,
  IsOptional,
  IsNumber,
  IsArray,
  Min,
  Max,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class FindFailuresDto {
  @ApiProperty({
    description: 'Goal or task text to find related failures for',
    example: 'Deploy the new authentication service',
  })
  @IsString()
  @MinLength(1)
  goal: string;

  @ApiPropertyOptional({
    description: 'Filter by agent ID for multi-tenant isolation',
  })
  @IsOptional()
  @IsString()
  agentId?: string;

  @ApiPropertyOptional({
    description: 'Maximum number of results (default 10)',
    default: 10,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number = 10;

  @ApiPropertyOptional({
    description: 'Minimum similarity threshold (default 0.7)',
    default: 0.7,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  minSimilarity?: number = 0.7;

  @ApiPropertyOptional({
    description: 'Additional failure keywords to match beyond defaults',
    example: ['timeout', 'rejected'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  extraKeywords?: string[];
}

export class FailureMemoryDto {
  id: string;
  raw: string;
  layer: string;
  similarity: number;
  createdAt: Date;
  metadata?: Record<string, any>;
  tags?: string[];
}

export class FindFailuresResultDto {
  failures: FailureMemoryDto[];
  total: number;
  goal: string;
  latencyMs: number;
}

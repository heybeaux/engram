import {
  IsOptional,
  IsIn,
  IsDateString,
  IsString,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Request body for `POST /v1/timelines/arc/search`.
 *
 * At least one of `query` / `from` / `to` must be present — the service
 * rejects an otherwise-empty search with a `BadRequestException`.
 */
export class ArcSearchDto {
  @ApiPropertyOptional({
    description: 'Semantic query text; ranked against per-day summaryEmbedding',
  })
  @IsOptional()
  @IsString()
  query?: string;

  @ApiPropertyOptional({
    description: 'Calendar lower bound (inclusive), agentLocalDate',
  })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({
    description: 'Calendar upper bound (inclusive), agentLocalDate',
  })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({
    description: 'Max number of arcs to return',
    minimum: 1,
    maximum: 50,
    default: 10,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 10;

  @ApiPropertyOptional({
    description: 'Level of detail for the representative summary',
    enum: ['index', 'summary', 'standard'],
    default: 'summary',
  })
  @IsOptional()
  @IsIn(['index', 'summary', 'standard'])
  lod?: 'index' | 'summary' | 'standard' = 'summary';
}

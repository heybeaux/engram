import { IsOptional, IsIn, IsDateString, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class QueryTimelineDto {
  @ApiPropertyOptional({ description: 'Start date (inclusive)' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'End date (inclusive)' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ description: 'Filter to a single arc' })
  @IsOptional()
  @IsString()
  arcId?: string;

  @ApiPropertyOptional({
    description: 'Level of detail',
    enum: ['index', 'summary', 'standard'],
    default: 'summary',
  })
  @IsOptional()
  @IsIn(['index', 'summary', 'standard'])
  lod?: 'index' | 'summary' | 'standard';
}

export class CloseArcDto {
  @ApiPropertyOptional({ description: 'Start date of the arc (inclusive)' })
  @IsDateString()
  from!: string;

  @ApiPropertyOptional({ description: 'End date of the arc (inclusive)' })
  @IsDateString()
  to!: string;
}

export class TeamQueryDto {
  @ApiPropertyOptional({ description: 'Date to query' })
  @IsOptional()
  @IsDateString()
  date?: string;

  @ApiPropertyOptional({ description: 'Arc identifier' })
  @IsOptional()
  @IsString()
  arc?: string;
}

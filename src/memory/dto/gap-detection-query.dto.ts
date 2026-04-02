import { IsString, IsOptional, IsIn, IsDateString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class GapDetectionQueryDto {
  @ApiProperty({
    description: 'Topic to search for in memories',
    example: 'deployment',
  })
  @IsString()
  topic: string;

  @ApiProperty({
    description: 'Start of date range (ISO 8601)',
    example: '2026-03-01',
  })
  @IsDateString()
  start: string;

  @ApiProperty({
    description: 'End of date range (ISO 8601)',
    example: '2026-03-31',
  })
  @IsDateString()
  end: string;

  @ApiPropertyOptional({
    description: 'Search method: "keyword" for ILIKE, "semantic" for embedding similarity',
    default: 'keyword',
  })
  @IsOptional()
  @IsIn(['keyword', 'semantic'])
  method?: 'keyword' | 'semantic' = 'keyword';
}

export interface GapPeriod {
  date: string;
  memoryCount: number;
  isAbsoluteGap: boolean;
}

export interface GapDetectionResponse {
  topic: string;
  range: { start: string; end: string };
  totalMemories: number;
  averagePerDay: number;
  gaps: GapPeriod[];
  coverage: number;
}

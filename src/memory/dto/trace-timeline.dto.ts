import {
  IsString,
  IsOptional,
  IsIn,
  IsDateString,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class TraceTimelineDto {
  @ApiProperty({
    description: 'Topic to trace through memories',
    example: 'deployment',
  })
  @IsString()
  topic: string;

  @ApiProperty({
    description: 'Start of date range (ISO 8601)',
    example: '2026-03-01',
  })
  @IsDateString()
  startDate: string;

  @ApiProperty({
    description: 'End of date range (ISO 8601)',
    example: '2026-03-31',
  })
  @IsDateString()
  endDate: string;

  @ApiPropertyOptional({
    description:
      'Search method: "keyword" for ILIKE, "semantic" for embedding similarity',
    default: 'keyword',
  })
  @IsOptional()
  @IsIn(['keyword', 'semantic'])
  method?: 'keyword' | 'semantic' = 'keyword';

  @ApiPropertyOptional({
    description: 'Maximum number of memories to return',
    default: 100,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number = 100;
}

export interface TimelineEntry {
  date: string;
  memories: Array<{
    id: string;
    raw: string;
    memoryType: string;
    importanceScore: number;
    createdAt: Date;
  }>;
}

export interface TraceTimelineResponse {
  topic: string;
  range: { start: string; end: string };
  totalMemories: number;
  entries: TimelineEntry[];
  gaps: string[];
  coverage: number;
}

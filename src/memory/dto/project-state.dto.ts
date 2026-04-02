import {
  IsString,
  IsOptional,
  IsBoolean,
  IsNumber,
  Min,
  Max,
  IsNotEmpty,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ProjectStateDto {
  @ApiProperty({ description: 'Project name to synthesize state for' })
  @IsString()
  @IsNotEmpty({ message: 'projectName cannot be empty' })
  projectName: string;

  @ApiPropertyOptional({
    description:
      'Include non-PROJECT layer memories semantically related to the project',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  includeRelated?: boolean = true;

  @ApiPropertyOptional({
    description: 'Number of days to look back for memories',
    default: 30,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(365)
  lookbackDays?: number = 30;
}

export interface ProjectStateSummaryItem {
  id: string;
  raw: string;
  date?: string;
  status?: string;
  severity?: string;
  layer?: string;
}

export interface ProjectStateResponse {
  projectName: string;
  lastActivity: string | null;
  totalMemories: number;
  confidence: number;
  summary: {
    goals: Array<{ id: string; raw: string; status?: string }>;
    decisions: Array<{ id: string; raw: string; date: string }>;
    issues: Array<{ id: string; raw: string; severity?: string }>;
    outcomes: Array<{ id: string; raw: string; date: string }>;
    insights: Array<{ id: string; raw: string }>;
  };
  recentActivity: Array<{
    id: string;
    raw: string;
    date: string;
    layer: string;
  }>;
}

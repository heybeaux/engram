import {
  IsString,
  IsOptional,
  IsArray,
  IsNumber,
  IsDateString,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTimelineDto {
  @ApiProperty({
    description: 'Local date for the timeline entry (YYYY-MM-DD)',
  })
  @IsDateString()
  agentLocalDate: string;

  @ApiPropertyOptional({ description: 'IANA timezone', default: 'UTC' })
  @IsOptional()
  @IsString()
  timezone?: string;

  @ApiProperty({ description: 'Chapter title for this day' })
  @IsString()
  chapter: string;

  @ApiPropertyOptional({ description: 'Arc identifier' })
  @IsOptional()
  @IsString()
  arcId?: string;

  @ApiProperty({ description: '~30 token index-level summary' })
  @IsString()
  indexText: string;

  @ApiProperty({ description: '~200 token narrative summary' })
  @IsString()
  summaryText: string;

  @ApiProperty({ description: '~800 token full structured entry' })
  @IsString()
  standardText: string;

  @ApiPropertyOptional({
    description: 'Structured timeline events',
    type: 'array',
  })
  @IsOptional()
  @IsArray()
  events?: any[];

  @ApiPropertyOptional({
    description: 'Decisions made during this day',
    type: 'array',
  })
  @IsOptional()
  @IsArray()
  decisions?: any[];

  @ApiPropertyOptional({ description: 'Open thread IDs', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  openThreadIds?: string[];

  @ApiPropertyOptional({ description: 'People involved', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  people?: string[];

  @ApiPropertyOptional({ description: 'Emotional tone of the day' })
  @IsOptional()
  @IsString()
  mood?: string;

  @ApiPropertyOptional({ description: 'Day significance score', default: 0.5 })
  @IsOptional()
  @IsNumber()
  significance?: number;

  @ApiPropertyOptional({ description: 'Linked memory IDs', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  memoryIds?: string[];
}

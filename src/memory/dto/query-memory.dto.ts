import {
  IsString,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsArray,
  IsEnum,
  ValidateNested,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MemoryLayer, SubjectType } from '@prisma/client';
import { MemoryVisibilityEnum } from './create-memory.dto';
import { MultiQueryOptionsDto } from '../../multi-query/dto/multi-query.dto';
import { AnticipatoryOptionsDto } from '../../anticipatory/dto/anticipatory.dto';

export class QueryMemoryDto {
  @ApiProperty({
    description: 'Natural language search query',
    example: 'What are the user preferences?',
  })
  @IsString()
  @MaxLength(2000, { message: 'Query must not exceed 2000 characters' })
  query: string;

  @ApiPropertyOptional({
    description: 'Filter by memory layers',
    enum: ['SESSION', 'PROJECT', 'IDENTITY', 'TASK'],
    isArray: true,
  })
  @IsOptional()
  @IsArray()
  @ApiPropertyOptional({
    enum: ['IDENTITY', 'PROJECT', 'SESSION', 'TASK', 'INSIGHT'],
    isArray: true,
    type: String,
  })
  @IsEnum(MemoryLayer, { each: true })
  layers?: string[];

  @ApiPropertyOptional({
    description: 'Maximum number of results',
    default: 10,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(1000)
  limit?: number = 10;

  @IsOptional()
  @IsBoolean()
  includeChains?: boolean = false;

  @IsOptional()
  @IsString()
  projectId?: string;

  // Subject filtering: what kind of memories to include?
  @IsOptional()
  @IsBoolean()
  includeUserMemories?: boolean = true;

  @IsOptional()
  @IsBoolean()
  includeAgentMemories?: boolean = true;

  @IsOptional()
  @ApiPropertyOptional({ enum: ['USER', 'AGENT', 'ENTITY'], type: String })
  @IsEnum(SubjectType)
  subjectType?: string;

  @IsOptional()
  @IsString()
  agentId?: string;

  // Multi-query retrieval options
  @IsOptional()
  @ValidateNested()
  @Type(() => MultiQueryOptionsDto)
  multiQuery?: MultiQueryOptionsDto;

  // HEY-174: Visibility filter for cross-agent recall
  @IsOptional()
  @IsArray()
  @ApiPropertyOptional({
    enum: ['PRIVATE', 'TEAM', 'PUBLIC'],
    isArray: true,
    type: String,
  })
  @IsEnum(MemoryVisibilityEnum, { each: true })
  visibility?: string[];

  // v0.7: Agent session attribution
  @IsOptional()
  @IsString()
  agentSessionKey?: string;

  // v0.9: Explicit pool filtering
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  poolIds?: string[];

  // v1.6: Anticipatory Recall Engine options
  @ApiPropertyOptional({
    description:
      'Anticipatory recall options — surfaces adjacent memories and insights',
    type: AnticipatoryOptionsDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => AnticipatoryOptionsDto)
  anticipatory?: AnticipatoryOptionsDto;
}

export class LoadContextDto {
  @IsOptional()
  @IsString()
  projectId?: string;

  @IsOptional()
  @IsString()
  sessionId?: string;

  @IsOptional()
  @IsString()
  agentId?: string;

  @IsOptional()
  @IsNumber()
  maxTokens?: number = 4000;
}

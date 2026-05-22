import {
  IsString,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsArray,
  IsEnum,
  IsObject,
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

/**
 * ENG-42: Recall filter — applied BEFORE semantic ranking.
 */
export class RecallFilterDto {
  @ApiPropertyOptional({
    description:
      'Must-match tags (AND logic — memory must have ALL listed tags)',
    example: ['google-ads', 'campaign'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({
    description:
      'Metadata key-value filters (memory.metadata must contain all entries)',
    example: { client: 'acme', env: 'production' },
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

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

  // ENG-42: Pre-ranking metadata filter
  @ApiPropertyOptional({
    description: 'Pre-ranking filter applied before semantic scoring',
    type: RecallFilterDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => RecallFilterDto)
  filter?: RecallFilterDto;

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

  // ENG-48: Temporal and arc filtering
  @ApiPropertyOptional({
    description: 'Only recall memories created after this date (ISO 8601)',
    example: '2026-03-20',
  })
  @IsOptional()
  @IsString()
  after?: string;

  @ApiPropertyOptional({
    description: 'Only recall memories created before this date (ISO 8601)',
    example: '2026-03-24',
  })
  @IsOptional()
  @IsString()
  before?: string;

  @ApiPropertyOptional({
    description: 'Filter by arc tag (prep for Phase 3)',
    example: 'simulaas-product-development',
  })
  @IsOptional()
  @IsString()
  arc?: string;

  @ApiPropertyOptional({
    description: 'Filter by memory type',
    enum: ['memory', 'timeline'],
  })
  @IsOptional()
  @IsEnum(['memory', 'timeline'])
  type?: 'memory' | 'timeline';

  // v1.7: Agent-scoped recall filter (identity consolidation)
  // When set, restricts recalled memories to those created by this specific agent.
  // Useful when the caller wants only its own memories, not cross-agent shared memories.
  @ApiPropertyOptional({
    description:
      'Filter recalled memories by the agent that created them. ' +
      'When omitted all memories for the user are considered.',
    example: 'cld_agent_abc123',
  })
  @IsOptional()
  @IsString()
  filterAgentId?: string;

  // v1.7: Boost factor for memories created by the requesting agent (identity consolidation)
  // A value > 1.0 surfaces same-agent memories higher in results.
  // E.g. 1.5 = 50% score boost for memories attributed to the caller.
  @ApiPropertyOptional({
    description:
      'Score multiplier applied to memories created by the requesting agent. ' +
      'Default 1.0 (no boost). Values between 1.0 and 3.0 are recommended.',
    example: 1.5,
    minimum: 1.0,
    maximum: 5.0,
  })
  @IsOptional()
  @IsNumber()
  @Min(1.0)
  @Max(5.0)
  agentBoost?: number;

  // HEY-576: Chain-of-Note reading prompt
  @ApiPropertyOptional({
    description:
      'When true, the structured response includes a Chain-of-Note system prompt ' +
      'that instructs the reading model to annotate each memory before answering. ' +
      'Requires structured=true (or response_format=structured) to take effect.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  chainOfNote?: boolean;
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

  // HEY-576: Chain-of-Note flag for context endpoint
  @ApiPropertyOptional({
    description:
      'When true, the returned context string is replaced by a Chain-of-Note prompt ' +
      'template populated with the loaded memories. Use as the system prompt for the reading model.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  chainOfNote?: boolean;

  // HEY-576: natural-language question used by CoN template when chainOfNote=true
  @ApiPropertyOptional({
    description:
      'Question for the Chain-of-Note prompt (used with chainOfNote=true).',
  })
  @IsOptional()
  @IsString()
  query?: string;
}

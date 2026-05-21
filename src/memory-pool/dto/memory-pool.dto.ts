import {
  IsString,
  IsOptional,
  IsEnum,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
} from 'class-validator';
import { PoolVisibility, PoolPermission } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateMemoryPoolDto {
  @IsString()
  name: string;

  @IsString()
  userId: string;

  @ApiPropertyOptional({ enum: ['GLOBAL', 'SHARED', 'PRIVATE'], type: String })
  @IsEnum(PoolVisibility)
  @IsOptional()
  visibility?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  createdBy: string; // agent session key
}

export class GrantPoolAccessDto {
  @IsString()
  @IsOptional()
  agentSessionId?: string; // AgentSession.id

  @IsString()
  @IsOptional()
  agentId?: string; // Agent.id

  @ApiPropertyOptional({ enum: ['READ', 'WRITE', 'ADMIN'], type: String })
  @IsEnum(PoolPermission)
  @IsOptional()
  permission?: string;

  @IsString()
  grantedBy: string; // session key of grantor
}

export class AddMemoryToPoolDto {
  @IsString()
  memoryId: string;

  @IsString()
  addedBy: string;
}

export class BulkAddMemoriesToPoolDto {
  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  memoryIds: string[];

  @IsString()
  addedBy: string;
}

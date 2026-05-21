import { IsString, IsArray, IsOptional, ArrayMinSize } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateIdentityTeamDto {
  @ApiProperty({ description: 'Team name' })
  @IsString()
  name: string;

  @ApiProperty({ description: 'Agent IDs in this team', type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  agentIds: string[];

  @ApiPropertyOptional({ description: 'Team description' })
  @IsOptional()
  @IsString()
  description?: string;
}

export interface TeamCapability {
  name: string;
  score: number;
  contributors: string[];
}

export interface TeamProfile {
  id: string;
  name: string;
  description?: string;
  agentIds: string[];
  capabilities: TeamCapability[];
  collaborationScore: number;
  lastActive: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CollaborationPair {
  agentA: string;
  agentB: string;
  taskCount: number;
  successRate: number;
}

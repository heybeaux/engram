import {
  IsString,
  IsOptional,
  IsNumber,
  Min,
  Max,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class FindContradictionsDto {
  @ApiPropertyOptional({
    description: 'ID of the memory to find contradictions for',
  })
  @IsString()
  @IsOptional()
  @ValidateIf((o) => !o.text)
  memoryId?: string;

  @ApiPropertyOptional({
    description:
      'Text to find contradictions for (used if memoryId not provided)',
  })
  @IsString()
  @IsOptional()
  @ValidateIf((o) => !o.memoryId)
  text?: string;

  @ApiPropertyOptional({ description: 'Agent ID for multi-tenant isolation' })
  @IsString()
  @IsOptional()
  agentId?: string;

  @ApiPropertyOptional({
    description: 'Minimum similarity threshold (0-1)',
    default: 0.8,
  })
  @IsNumber()
  @Min(0)
  @Max(1)
  @IsOptional()
  threshold?: number;

  @ApiPropertyOptional({
    description: 'Maximum number of results',
    default: 10,
  })
  @IsNumber()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit?: number;
}

export interface ContradictionResult {
  id: string;
  raw: string;
  memoryType: string | null;
  importanceScore: number;
  similarity: number;
  createdAt: Date;
}

export interface FindContradictionsResult {
  sourceId: string | null;
  sourceText: string;
  contradictions: ContradictionResult[];
  total: number;
  latencyMs: number;
}

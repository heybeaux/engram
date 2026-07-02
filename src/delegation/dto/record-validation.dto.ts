import {
  IsArray,
  IsBoolean,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';

export class RecordValidationDto {
  @IsObject()
  stateContract: Record<string, any>;

  @IsObject()
  validationResult: Record<string, any>;

  @IsOptional()
  @IsString()
  taskId?: string;

  @IsOptional()
  @IsString()
  latticeContractId?: string;

  @IsOptional()
  @IsString()
  traceId?: string;

  @IsOptional()
  @IsBoolean()
  passed?: boolean;

  @IsOptional()
  @IsString()
  tier?: string;

  @IsOptional()
  @IsArray()
  tiersRun?: string[];

  @IsOptional()
  @IsNumber()
  durationMs?: number;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsNumber()
  confidence?: number;

  @IsOptional()
  @IsBoolean()
  providerFailure?: boolean;

  @IsOptional()
  @IsArray()
  evidence?: any[];
}

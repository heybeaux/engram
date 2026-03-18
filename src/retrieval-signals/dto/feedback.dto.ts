import {
  IsString,
  IsEnum,
  IsOptional,
  IsNumber,
  IsObject,
  Min,
  Max,
} from 'class-validator';

export enum FeedbackSignalType {
  EXPLICIT_HIT = 'EXPLICIT_HIT',
  EXPLICIT_MISS = 'EXPLICIT_MISS',
  EXPLICIT_IRRELEVANT = 'EXPLICIT_IRRELEVANT',
  EXPLICIT_PARTIAL = 'EXPLICIT_PARTIAL',
}

export class FeedbackDto {
  @IsString()
  queryId: string;

  @IsOptional()
  @IsString()
  memoryId?: string;

  @IsEnum(FeedbackSignalType)
  signal: FeedbackSignalType;

  @IsOptional()
  @IsNumber()
  @Min(-2)
  @Max(2)
  weight?: number;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

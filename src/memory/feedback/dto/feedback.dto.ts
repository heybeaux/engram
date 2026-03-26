import {
  IsString,
  IsArray,
  IsOptional,
  IsNumber,
  Min,
  Max,
} from 'class-validator';

export class TrajectoryFeedbackDto {
  @IsString()
  recallId: string;

  @IsArray()
  @IsString({ each: true })
  usedMemoryIds: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  unusedMemoryIds?: string[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  responseQuality?: number;
}

export class TrajectoryFeedbackResponseDto {
  updated: number;
  recallId: string;
}

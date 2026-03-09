import { IsArray, IsString, IsOptional, IsInt, Min, Max, ArrayMaxSize } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class BatchRecallDto {
  @ApiProperty({
    description: 'Entity names to recall (max 20)',
    example: ['MAP International', 'Operation Blessing'],
  })
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(20)
  entities: string[];

  @ApiPropertyOptional({
    description: 'Max memories per entity (default 10)',
    example: 10,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

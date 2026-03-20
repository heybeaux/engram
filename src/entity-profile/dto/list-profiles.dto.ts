import { IsOptional, IsEnum, IsString, IsInt, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { EntityType } from '@prisma/client';
import { Type } from 'class-transformer';

export class ListProfilesDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 25;

  @ApiPropertyOptional({ enum: EntityType })
  @IsOptional()
  @IsEnum(EntityType)
  type?: EntityType;

  @ApiPropertyOptional({ description: 'Search name, aliases, description' })
  @IsOptional()
  @IsString()
  search?: string;
}

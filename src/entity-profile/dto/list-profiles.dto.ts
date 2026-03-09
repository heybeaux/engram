import { IsOptional, IsEnum, IsString, IsInt, Min } from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { EntityType } from "@prisma/client";
import { Type } from "class-transformer";

export class ListProfilesDto {
  @ApiPropertyOptional({ enum: EntityType }) @IsOptional() @IsEnum(EntityType) type?: EntityType;
  @ApiPropertyOptional() @IsOptional() @IsString() search?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() userId?: string;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number = 1;
  @ApiPropertyOptional({ default: 20 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit?: number = 20;
}

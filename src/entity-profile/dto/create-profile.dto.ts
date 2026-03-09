import { IsString, IsOptional, IsEnum, IsArray, IsBoolean, IsUUID } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { EntityType, ProfileSource } from "@prisma/client";

export class CreateProfileDto {
  @ApiProperty() @IsString() name: string;
  @ApiProperty({ enum: EntityType }) @IsEnum(EntityType) type: EntityType;
  @ApiPropertyOptional() @IsOptional() @IsArray() aliases?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() avatar?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() entityId?: string;
  @ApiPropertyOptional() @IsOptional() @IsArray() tags?: string[];
  @ApiPropertyOptional({ enum: ProfileSource }) @IsOptional() @IsEnum(ProfileSource) source?: ProfileSource;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() verified?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsUUID() poolId?: string;
  @ApiProperty() @IsString() userId: string;
}

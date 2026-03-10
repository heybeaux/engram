import {
  IsString,
  IsOptional,
  IsEnum,
  IsArray,
  ValidateNested,
  IsBoolean,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EntityType, AttributeType } from '@prisma/client';
import { Type } from 'class-transformer';

export class InlineAttributeDto {
  @ApiProperty() @IsString() key: string;
  @ApiProperty() @IsString() value: string;
  @ApiPropertyOptional({ enum: AttributeType })
  @IsOptional()
  @IsEnum(AttributeType)
  valueType?: AttributeType;
  @ApiPropertyOptional() @IsOptional() @IsString() category?: string;
}

export class CreateProfileDto {
  @ApiProperty({ description: 'Display name for the entity' })
  @IsString()
  name: string;

  @ApiProperty({ enum: EntityType, description: 'Entity type' })
  @IsEnum(EntityType)
  type: EntityType;

  @ApiPropertyOptional({ description: 'Short description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: 'Alternative names', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  aliases?: string[];

  @ApiPropertyOptional({ description: 'Tags for categorization', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({
    description: 'Initial attributes to create with the profile',
    type: [InlineAttributeDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InlineAttributeDto)
  attributes?: InlineAttributeDto[];
}

import {
  IsString,
  IsOptional,
  IsArray,
  ValidateNested,
  IsEnum,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AttributeType } from '@prisma/client';

export class ProfileMappingDto {
  @ApiProperty({ description: 'CSV column name for profile name (required)' })
  @IsString()
  name: string;

  @ApiPropertyOptional({
    description: 'CSV column name or static EntityType value (e.g. PERSON)',
  })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiPropertyOptional({ description: 'CSV column name for description' })
  @IsOptional()
  @IsString()
  description?: string;
}

export class AttributeMappingItemDto {
  @ApiProperty({ description: 'Attribute key (e.g. "email")' })
  @IsString()
  key: string;

  @ApiProperty({ description: 'CSV column name' })
  @IsString()
  column: string;

  @ApiPropertyOptional({
    enum: AttributeType,
    description: 'Attribute value type',
  })
  @IsOptional()
  @IsEnum(AttributeType)
  valueType?: AttributeType;

  @ApiPropertyOptional({ description: 'Grouping category' })
  @IsOptional()
  @IsString()
  category?: string;
}

export class MemoryMappingDto {
  @ApiPropertyOptional({ description: 'CSV column for memory content' })
  @IsOptional()
  @IsString()
  content?: string;

  @ApiPropertyOptional({
    description: 'CSV column or static numeric value for importance (1–5)',
  })
  @IsOptional()
  @IsString()
  importance?: string;
}

export class MappingConfigDto {
  @ApiProperty({ type: ProfileMappingDto })
  @ValidateNested()
  @Type(() => ProfileMappingDto)
  profileMapping: ProfileMappingDto;

  @ApiPropertyOptional({ type: [AttributeMappingItemDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AttributeMappingItemDto)
  attributeMapping?: AttributeMappingItemDto[];

  @ApiPropertyOptional({ type: MemoryMappingDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => MemoryMappingDto)
  memoryMapping?: MemoryMappingDto;
}

import { IsString, IsOptional, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AttributeType } from '@prisma/client';

export class CreateAttributeDto {
  @ApiProperty({ description: 'Attribute key' })
  @IsString()
  key: string;

  @ApiProperty({ description: 'Attribute value' })
  @IsString()
  value: string;

  @ApiPropertyOptional({ enum: AttributeType, default: 'STRING' })
  @IsOptional()
  @IsEnum(AttributeType)
  valueType?: AttributeType;

  @ApiPropertyOptional({ description: 'Category grouping' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({ description: 'Source of the attribute' })
  @IsOptional()
  @IsString()
  source?: string;
}

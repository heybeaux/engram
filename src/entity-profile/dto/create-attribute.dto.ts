import { IsString, IsOptional, IsEnum, IsNumber, IsBoolean } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { AttributeType } from "@prisma/client";

export class CreateAttributeDto {
  @ApiProperty() @IsString() key: string;
  @ApiProperty() @IsString() value: string;
  @ApiPropertyOptional({ enum: AttributeType }) @IsOptional() @IsEnum(AttributeType) valueType?: AttributeType;
  @ApiPropertyOptional() @IsOptional() @IsString() category?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() source?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() confidence?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() verified?: boolean;
}

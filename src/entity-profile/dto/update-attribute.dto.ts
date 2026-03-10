import { IsString, IsOptional, IsBoolean } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateAttributeDto {
  @ApiPropertyOptional({ description: 'New value' })
  @IsOptional()
  @IsString()
  value?: string;

  @ApiPropertyOptional({ description: 'Mark attribute as verified' })
  @IsOptional()
  @IsBoolean()
  verified?: boolean;
}

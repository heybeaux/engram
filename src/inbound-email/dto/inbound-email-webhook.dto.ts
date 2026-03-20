import { IsString, IsArray, IsOptional, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class InboundEmailDataDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsOptional()
  @IsString()
  email_id?: string;

  @IsString()
  from: string;

  @IsArray()
  @IsString({ each: true })
  to: string[];

  @IsOptional()
  @IsString()
  subject?: string;

  @IsOptional()
  @IsString()
  text?: string;

  @IsOptional()
  @IsString()
  html?: string;

  @IsOptional()
  headers?: any[];
}

export class InboundEmailWebhookDto {
  @IsString()
  type: string;

  @ValidateNested()
  @Type(() => InboundEmailDataDto)
  data: InboundEmailDataDto;
}

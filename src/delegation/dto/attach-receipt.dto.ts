import { IsObject, IsOptional, IsString } from 'class-validator';

export class AttachReceiptDto {
  @IsObject()
  receipt: Record<string, any>;

  @IsOptional()
  @IsString()
  contractId?: string;

  @IsOptional()
  @IsString()
  artifactUri?: string;
}

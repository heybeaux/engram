import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class WorkspaceFileImportDto {
  @ApiProperty({ description: 'Relative OpenClaw workspace Markdown path' })
  @IsString()
  @IsNotEmpty()
  path: string;

  @ApiProperty({ description: 'Complete contents of the file' })
  @IsString()
  @IsNotEmpty()
  text: string;

  @ApiProperty({ description: 'File date in UTC (YYYY-MM-DD)' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  fileDate: string;

  @ApiProperty({ description: 'Inclusive as-of date in UTC (YYYY-MM-DD)' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  cutoff: string;
}

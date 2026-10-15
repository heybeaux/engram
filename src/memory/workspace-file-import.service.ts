import * as crypto from 'crypto';
import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { MemorySource } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspaceFileImportDto } from './dto/workspace-file-import.dto';
import { MemoryWriteService } from './memory-write.service';

type WorkspaceChunk = {
  raw: string;
  startLine: number;
  endLine: number;
  headingLine?: number;
  observedAt: string;
};

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
}

export function chunkWorkspaceFile(text: string, fileDate: string): WorkspaceChunk[] {
  if (!validDate(fileDate)) throw new BadRequestException('Invalid file date');
  const lines = text.split(/\r?\n/);
  const chunks: WorkspaceChunk[] = [];
  let heading = '';
  let headingLine: number | undefined;
  let headingDate = fileDate;
  let paragraph: string[] = [];
  let paragraphStart = 0;

  const flush = (endLine: number) => {
    if (paragraph.length) {
      const paragraphDate = paragraph[0].match(/^\s*(?:[-*]\s*)?(\d{4}-\d{2}-\d{2})\b/)?.[1];
      const observedDate = paragraphDate && validDate(paragraphDate) ? paragraphDate : headingDate;
      chunks.push({
        raw: heading ? `${heading}\n${paragraph.join('\n')}` : paragraph.join('\n'),
        startLine: paragraphStart,
        endLine,
        ...(headingLine ? { headingLine } : {}),
        observedAt: `${observedDate}T00:00:00.000Z`,
      });
      paragraph = [];
    }
  };

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (/^\s{0,3}#{1,6}\s+/.test(line)) {
      flush(index);
      heading = line.trim();
      headingLine = lineNumber;
      const date = heading.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1];
      if (date && validDate(date)) headingDate = date;
    } else if (line.trim() === '') {
      flush(index);
    } else {
      if (!paragraph.length) paragraphStart = lineNumber;
      paragraph.push(line);
    }
  });
  flush(lines.length);
  return chunks;
}

function validWorkspacePath(path: string): boolean {
  if (path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) return false;
  return /(?:^|\/)(?:workspace\/)?(?:MEMORY|DELEGATION)\.md$/.test(path) ||
    /(?:^|\/)workspace\/memory\/[^/]+\.md$/.test(path) ||
    /(?:^|\/)exports\/[^/]+\.md$/.test(path);
}

@Injectable()
export class WorkspaceFileImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly memoryWrite: MemoryWriteService,
  ) {}

  async importFile(userId: string, dto: WorkspaceFileImportDto) {
    if (process.env.ENABLE_WORKSPACE_FILE_IMPORT !== 'true') {
      throw new ForbiddenException('Workspace-file import is disabled');
    }
    if (!validWorkspacePath(dto.path) || !validDate(dto.fileDate) || !validDate(dto.cutoff)) {
      throw new BadRequestException('Invalid workspace path or date');
    }
    if (dto.cutoff > new Date().toISOString().slice(0, 10)) {
      throw new BadRequestException('Cutoff cannot be in the future');
    }

    const contentHash = crypto.createHash('sha256').update(dto.text).digest('hex');
    const chunks = chunkWorkspaceFile(dto.text, dto.fileDate);
    const eligible = dto.fileDate > dto.cutoff ? [] :
      chunks.filter((chunk) => chunk.observedAt.slice(0, 10) <= dto.cutoff);
    if (!eligible.length) return { created: 0, skipped: 0, afterCutoff: chunks.length };

    const prior = await this.prisma.memory.findMany({
      where: {
        userId,
        deletedAt: null,
        AND: [
          { metadata: { path: ['workspaceFile'], equals: dto.path } },
          { metadata: { path: ['workspaceContentHash'], equals: contentHash } },
        ],
      },
      select: { metadata: true },
    });
    const existing = new Set(prior.map((memory) =>
      (memory.metadata as Record<string, unknown> | null)?.workspaceChunkKey,
    ));
    const missing = eligible.filter((chunk) => !existing.has(`${chunk.startLine}-${chunk.endLine}`));
    let created = 0;
    for (let index = 0; index < missing.length; index += 1000) {
      const batch = missing.slice(index, index + 1000);
      const result = await this.memoryWrite.bulkCreate(userId, {
        memories: batch.map((chunk) => ({
          raw: chunk.raw,
          source: MemorySource.HISTORICAL,
          observedAt: chunk.observedAt,
          metadata: {
            workspaceFile: dto.path,
            workspaceContentHash: contentHash,
            workspaceChunkKey: `${chunk.startLine}-${chunk.endLine}`,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            ...(chunk.headingLine ? { headingLine: chunk.headingLine } : {}),
          },
        })),
      });
      created += result.created;
    }
    return {
      created,
      skipped: eligible.length - missing.length,
      afterCutoff: chunks.length - eligible.length,
    };
  }
}

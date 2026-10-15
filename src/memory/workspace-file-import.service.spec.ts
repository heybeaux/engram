import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { WorkspaceFileImportService, chunkWorkspaceFile } from './workspace-file-import.service';
import { WorkspaceFileImportDto } from './dto/workspace-file-import.dto';

describe('workspace-file import', () => {
  const originalFlag = process.env.ENABLE_WORKSPACE_FILE_IMPORT;
  const prisma = { memory: { findMany: jest.fn() } };
  const memoryWrite = { bulkCreate: jest.fn() };
  const service = new WorkspaceFileImportService(prisma as any, memoryWrite as any);
  const input: WorkspaceFileImportDto = {
    path: 'agents/rook/workspace/memory/2026-04-01.md',
    fileDate: '2026-04-01',
    cutoff: '2026-04-01',
    text: '# Work\nFirst fact.\n\nSecond fact.',
  };

  beforeEach(() => {
    process.env.ENABLE_WORKSPACE_FILE_IMPORT = 'true';
    jest.resetAllMocks();
    prisma.memory.findMany.mockResolvedValue([]);
    memoryWrite.bulkCreate.mockImplementation(async (_userId, dto) => ({
      created: dto.memories.length,
    }));
  });

  afterAll(() => {
    if (originalFlag === undefined) delete process.env.ENABLE_WORKSPACE_FILE_IMPORT;
    else process.env.ENABLE_WORKSPACE_FILE_IMPORT = originalFlag;
  });

  it('chunks on headings and paragraphs with original line ranges and dated heading context', () => {
    expect(chunkWorkspaceFile('# Work\nFirst fact.\n\nSecond fact.\n## 2026-04-02\nLater fact.', '2026-04-01')).toEqual([
      { raw: '# Work\nFirst fact.', startLine: 2, endLine: 2, headingLine: 1, observedAt: '2026-04-01T00:00:00.000Z' },
      { raw: '# Work\nSecond fact.', startLine: 4, endLine: 4, headingLine: 1, observedAt: '2026-04-01T00:00:00.000Z' },
      { raw: '## 2026-04-02\nLater fact.', startLine: 6, endLine: 6, headingLine: 5, observedAt: '2026-04-02T00:00:00.000Z' },
    ]);
  });

  it('recognizes dated paragraphs inside a file without a dated heading', () => {
    expect(chunkWorkspaceFile('# Log\n- 2026-04-03 New decision.', '2026-04-01')[0].observedAt)
      .toBe('2026-04-03T00:00:00.000Z');
  });

  it('writes dated historical chunks with path, content hash and line provenance', async () => {
    expect(await service.importFile('beaux', input)).toEqual({ created: 2, skipped: 0, afterCutoff: 0 });
    const memories = memoryWrite.bulkCreate.mock.calls[0][1].memories;
    expect(memories).toHaveLength(2);
    expect(memories[0]).toMatchObject({
      raw: '# Work\nFirst fact.',
      source: 'HISTORICAL',
      observedAt: '2026-04-01T00:00:00.000Z',
      metadata: { workspaceFile: input.path, workspaceChunkKey: '2-2', startLine: 2, endLine: 2, headingLine: 1 },
    });
    expect(memories[0].metadata.workspaceContentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not write duplicate path-and-content chunks on a repeat run', async () => {
    await service.importFile('beaux', input);
    const prior = memoryWrite.bulkCreate.mock.calls[0][1].memories.map((memory) => ({ metadata: memory.metadata }));
    prisma.memory.findMany.mockResolvedValue(prior);
    expect(await service.importFile('beaux', input)).toEqual({ created: 0, skipped: 2, afterCutoff: 0 });
    expect(memoryWrite.bulkCreate).toHaveBeenCalledTimes(1);
    expect(prisma.memory.findMany.mock.calls[1][0].where).toMatchObject({
      userId: 'beaux',
      AND: [
        { metadata: { path: ['workspaceFile'], equals: input.path } },
        { metadata: { path: ['workspaceContentHash'], equals: prior[0].metadata.workspaceContentHash } },
      ],
    });
  });

  it('skips later headings and a file dated after the cutoff, but can add skipped chunks with a later cutoff', async () => {
    const text = '# 2026-04-01\nEarlier.\n# 2026-04-03\nLater.';
    const dated = { ...input, text, cutoff: '2026-04-01' };
    expect(await service.importFile('beaux', dated)).toEqual({ created: 1, skipped: 0, afterCutoff: 1 });
    const prior = memoryWrite.bulkCreate.mock.calls[0][1].memories.map((memory) => ({ metadata: memory.metadata }));
    prisma.memory.findMany.mockResolvedValue(prior);
    expect(await service.importFile('beaux', { ...dated, cutoff: '2026-04-03' })).toEqual({ created: 1, skipped: 1, afterCutoff: 0 });
    expect(memoryWrite.bulkCreate.mock.calls[1][1].memories[0].raw).toContain('Later.');
    expect(await service.importFile('beaux', { ...dated, fileDate: '2026-04-04' })).toEqual({ created: 0, skipped: 0, afterCutoff: 2 });
  });

  it('rejects a disabled flag before reading or writing', async () => {
    delete process.env.ENABLE_WORKSPACE_FILE_IMPORT;
    await expect(service.importFile('beaux', input)).rejects.toThrow(ForbiddenException);
    expect(prisma.memory.findMany).not.toHaveBeenCalled();
    expect(memoryWrite.bulkCreate).not.toHaveBeenCalled();
  });

  it('rejects paths outside the workspace and invalid calendar dates', async () => {
    await expect(service.importFile('beaux', { ...input, path: '../MEMORY.md' })).rejects.toThrow(BadRequestException);
    await expect(service.importFile('beaux', { ...input, cutoff: '2026-02-30' })).rejects.toThrow(BadRequestException);
  });
});

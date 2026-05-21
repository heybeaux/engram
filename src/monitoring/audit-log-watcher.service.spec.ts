import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AuditLogWatcherService } from './audit-log-watcher.service';

/**
 * Helper — write text to the fixture file and return its current size.
 */
function writeLog(filePath: string, content: string): number {
  fs.writeFileSync(filePath, content, 'utf-8');
  return fs.statSync(filePath).size;
}

/**
 * Helper — append text to the fixture file and return its current size.
 */
function appendLog(filePath: string, content: string): number {
  fs.appendFileSync(filePath, content, 'utf-8');
  return fs.statSync(filePath).size;
}

describe('AuditLogWatcherService', () => {
  let tmpDir: string;
  let logPath: string;
  let svc: AuditLogWatcherService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engram-audit-'));
    logPath = path.join(tmpDir, 'audit.log');
    svc = new AuditLogWatcherService({
      filePath: logPath,
      pollIntervalMs: 9999,
    });
  });

  afterEach(() => {
    // Clean up the temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('initial state', () => {
    it('starts with offset 0 and no inode recorded', () => {
      expect((svc as any).lastOffset).toBe(0);
      expect((svc as any).lastInode).toBeNull();
    });
  });

  describe('poll — file not yet present', () => {
    it('does nothing when the log file does not exist', async () => {
      await svc.poll();

      expect((svc as any).lastOffset).toBe(0);
      expect((svc as any).lastInode).toBeNull();
    });
  });

  describe('poll — normal read', () => {
    it('reads all lines on first poll and advances offset', async () => {
      writeLog(logPath, 'entry1\nentry2\n');

      const collected: string[] = [];
      svc.onEntry((e) => collected.push(e.raw));

      await svc.poll();

      expect(collected).toEqual(['entry1', 'entry2']);
      expect((svc as any).lastOffset).toBe(fs.statSync(logPath).size);
    });

    it('reads only new lines appended since last poll', async () => {
      writeLog(logPath, 'entry1\n');
      await svc.poll(); // consume first line

      const collected: string[] = [];
      svc.onEntry((e) => collected.push(e.raw));

      appendLog(logPath, 'entry2\nentry3\n');
      await svc.poll();

      expect(collected).toEqual(['entry2', 'entry3']);
    });

    it('does not emit duplicate lines when nothing has changed', async () => {
      writeLog(logPath, 'entry1\n');
      await svc.poll();

      const collected: string[] = [];
      svc.onEntry((e) => collected.push(e.raw));

      // Second poll — no new content
      await svc.poll();

      expect(collected).toHaveLength(0);
    });

    it('skips blank lines', async () => {
      writeLog(logPath, 'entry1\n\n\nentry2\n');

      const collected: string[] = [];
      svc.onEntry((e) => collected.push(e.raw));

      await svc.poll();

      expect(collected).toEqual(['entry1', 'entry2']);
    });
  });

  describe('rotation detection — file shrinks (truncation)', () => {
    it('resets offset to 0 when current size is less than lastOffset', async () => {
      writeLog(logPath, 'line1\nline2\nline3\n');
      await svc.poll(); // offset now equals file size (e.g. 18)

      const collectedAfterRotation: string[] = [];
      svc.onEntry((e) => collectedAfterRotation.push(e.raw));

      // Simulate truncation: replace file with shorter content (same path, same inode potentially)
      writeLog(logPath, 'new1\n');

      await svc.poll();

      // Should have read "new1" from offset 0 after detecting shrinkage
      expect(collectedAfterRotation).toEqual(['new1']);
      expect((svc as any).lastOffset).toBe(fs.statSync(logPath).size);
    });

    it('emits all lines from the new file after a truncation rotation', async () => {
      // Use a long old content so the replacement (shorter) content triggers size shrink
      writeLog(logPath, 'old-line-A\nold-line-B\nold-line-C\nold-line-D\n');
      await svc.poll();

      const collected: string[] = [];
      svc.onEntry((e) => collected.push(e.raw));

      // Truncate and write shorter fresh content — new size < lastOffset → rotation
      writeLog(logPath, 'fresh\n');
      await svc.poll();

      expect(collected).toContain('fresh');
      expect(collected).not.toContain('old-line-A');
    });
  });

  describe('rotation detection — inode change (rename + recreate)', () => {
    it('resets offset to 0 when file inode changes', async () => {
      writeLog(logPath, 'original-line\n');
      await svc.poll();

      const originalInode = (svc as any).lastInode;
      const originalOffset = (svc as any).lastOffset;
      expect(originalOffset).toBeGreaterThan(0);

      const collected: string[] = [];
      svc.onEntry((e) => collected.push(e.raw));

      // Simulate logrotate: rename old file, create new one at same path
      const rotatedPath = path.join(tmpDir, 'audit.log.1');
      fs.renameSync(logPath, rotatedPath);
      writeLog(logPath, 'rotated-entry\n');

      await svc.poll();

      const newInode = (svc as any).lastInode;
      expect(newInode).not.toBe(originalInode);
      expect(collected).toEqual(['rotated-entry']);
      expect((svc as any).lastOffset).toBe(fs.statSync(logPath).size);
    });

    it('does not double-count lines if the new file is larger than the old one', async () => {
      // Old file: short content
      writeLog(logPath, 'old\n');
      await svc.poll();

      const collected: string[] = [];
      svc.onEntry((e) => collected.push(e.raw));

      // New file after rotation: longer than old file (would fool a size-only check)
      fs.renameSync(logPath, path.join(tmpDir, 'audit.log.1'));
      writeLog(logPath, 'new-line-A\nnew-line-B\nnew-line-C\n');

      await svc.poll();

      expect(collected).toEqual(['new-line-A', 'new-line-B', 'new-line-C']);
    });
  });

  describe('rotation detection — file disappears then reappears', () => {
    it('resets state when file is missing and reads fresh entries on reappearance', async () => {
      writeLog(logPath, 'before-removal\n');
      await svc.poll();

      // File is deleted (logrotate removes old log)
      fs.unlinkSync(logPath);
      await svc.poll(); // should log warning and reset

      expect((svc as any).lastOffset).toBe(0);
      expect((svc as any).lastInode).toBeNull();

      const collected: string[] = [];
      svc.onEntry((e) => collected.push(e.raw));

      // New file created
      writeLog(logPath, 'after-removal\n');
      await svc.poll();

      expect(collected).toEqual(['after-removal']);
    });
  });

  describe('handler error isolation', () => {
    it('continues processing lines even when a handler throws', async () => {
      writeLog(logPath, 'line1\nline2\n');

      const good: string[] = [];
      svc.onEntry(() => {
        throw new Error('handler failed');
      });
      svc.onEntry((e) => good.push(e.raw));

      await expect(svc.poll()).resolves.not.toThrow();
      expect(good).toEqual(['line1', 'line2']);
    });
  });

  describe('onModuleInit / onModuleDestroy', () => {
    it('starts and stops the polling interval', () => {
      svc.onModuleInit();
      expect((svc as any).pollTimer).not.toBeNull();

      svc.onModuleDestroy();
      expect((svc as any).pollTimer).toBeNull();
    });
  });
});

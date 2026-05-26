import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

export interface AuditLogEntry {
  raw: string;
  parsedAt: Date;
}

export interface AuditLogWatcherOptions {
  /** Absolute path to the audit.log file. Defaults to <cwd>/logs/audit.log */
  filePath?: string;
  /** Polling interval in milliseconds. Defaults to 1000ms */
  pollIntervalMs?: number;
}

/**
 * AuditLogWatcherService
 *
 * Tails an audit.log file and emits new entries since the last read position.
 * Correctly handles log rotation: when the current file size is smaller than
 * the last known byte offset (or the inode changes), rotation is detected and
 * the offset is reset to 0 so new entries are not missed.
 *
 * Rotation detection strategy:
 *  1. Compare current file inode to the stored inode — a mismatch means the
 *     file was replaced (renamed + recreated, the most common logrotate pattern).
 *  2. Also compare current file size to lastOffset — if the file shrank, the
 *     same file was truncated and we must restart from the beginning.
 *
 * Both checks are handled in a single stat call per poll cycle to minimise
 * filesystem overhead.
 */
@Injectable()
export class AuditLogWatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuditLogWatcherService.name);

  private readonly filePath: string;
  private readonly pollIntervalMs: number;

  /** Byte offset of the next unread position in the current file. */
  private lastOffset = 0;

  /**
   * Inode of the file at the last successful read.  null = file not yet seen.
   * Using inode comparison catches the rename+recreate rotation pattern even
   * when the new file happens to have a larger size than the old one.
   */
  private lastInode: number | null = null;

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  /** Callbacks registered by consumers that want to process new log lines. */
  private readonly handlers: Array<(entry: AuditLogEntry) => void> = [];

  constructor() {
    this.filePath = path.resolve(process.cwd(), 'logs', 'audit.log');
    this.pollIntervalMs = 1000;
  }

  onModuleInit(): void {
    this.logger.log(
      `AuditLogWatcher starting — watching ${this.filePath} every ${this.pollIntervalMs}ms`,
    );
    this.pollTimer = setInterval(() => {
      this.poll().catch((err) => {
        this.logger.error(
          `Poll error: ${(err as Error).message}`,
          (err as Error).stack,
        );
      });
    }, this.pollIntervalMs);
  }

  onModuleDestroy(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.logger.log('AuditLogWatcher stopped');
  }

  /**
   * Register a handler that receives each new log line as it is tailed.
   */
  onEntry(handler: (entry: AuditLogEntry) => void): void {
    this.handlers.push(handler);
  }

  /**
   * Main poll cycle — called on every interval tick.
   * Exported as public for direct use in tests.
   */
  async poll(): Promise<void> {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.filePath);
    } catch {
      // File does not exist yet — reset state and wait
      if (this.lastInode !== null) {
        this.logger.warn(
          'audit.log disappeared — resetting offset (file may have been rotated away)',
        );
        this.lastOffset = 0;
        this.lastInode = null;
      }
      return;
    }

    const currentInode = stat.ino;
    const currentSize = stat.size;

    // ── Rotation detection ──────────────────────────────────────────────────
    // Case 1: inode changed → file was replaced (rename + recreate)
    // Case 2: file shrank   → file was truncated
    const inodeChanged =
      this.lastInode !== null && currentInode !== this.lastInode;
    const fileShrunk = currentSize < this.lastOffset;

    if (inodeChanged || fileShrunk) {
      this.logger.warn(
        inodeChanged
          ? `audit.log inode changed (${this.lastInode} → ${currentInode}) — log rotation detected, resetting offset to 0`
          : `audit.log size (${currentSize}) < last offset (${this.lastOffset}) — truncation detected, resetting offset to 0`,
      );
      this.lastOffset = 0;
    }

    // Update stored inode to the current file
    this.lastInode = currentInode;

    // Nothing new to read
    if (currentSize === this.lastOffset) {
      return;
    }

    // ── Read new bytes since lastOffset ────────────────────────────────────
    await this.readNewLines(this.lastOffset, currentSize);
    this.lastOffset = currentSize;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private readNewLines(startOffset: number, endSize: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const readStream = fs.createReadStream(this.filePath, {
        start: startOffset,
        end: endSize - 1,
        encoding: 'utf-8',
      });

      const rl = readline.createInterface({
        input: readStream,
        crlfDelay: Infinity,
      });

      const now = new Date();

      rl.on('line', (line: string) => {
        const trimmed = line.trim();
        if (trimmed.length === 0) return;

        const entry: AuditLogEntry = { raw: trimmed, parsedAt: now };
        for (const handler of this.handlers) {
          try {
            handler(entry);
          } catch (err) {
            this.logger.warn(
              `Handler threw while processing audit log entry: ${(err as Error).message}`,
            );
          }
        }
      });

      rl.on('close', resolve);
      rl.on('error', reject);
      readStream.on('error', reject);
    });
  }
}

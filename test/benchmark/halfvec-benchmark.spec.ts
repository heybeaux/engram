/**
 * Tests for halfvec benchmark scripts — ENG-51
 *
 * Unit tests for the migration SQL, backfill logic, and benchmark report.
 * These don't require a live database — they validate the scripts' structure
 * and logic.
 */

import * as fs from 'fs';
import * as path from 'path';

describe('halfvec-benchmark', () => {
  // ── Migration SQL ─────────────────────────────────────────────

  describe('migration SQL', () => {
    const migrationPath = path.join(
      __dirname,
      '../../prisma/migrations/20260326_add_halfvec_shadow/migration.sql',
    );

    let sql: string;

    beforeAll(() => {
      sql = fs.readFileSync(migrationPath, 'utf-8');
    });

    it('should exist', () => {
      expect(fs.existsSync(migrationPath)).toBe(true);
    });

    it('should use IF NOT EXISTS for the column', () => {
      expect(sql).toContain('ADD COLUMN IF NOT EXISTS embedding_halfvec');
    });

    it('should create halfvec(768) column', () => {
      expect(sql).toContain('halfvec(768)');
    });

    it('should create HNSW index with IF NOT EXISTS', () => {
      expect(sql).toContain('CREATE INDEX IF NOT EXISTS');
      expect(sql).toContain('memory_embeddings_halfvec_idx');
    });

    it('should use halfvec_cosine_ops for the index', () => {
      expect(sql).toContain('halfvec_cosine_ops');
    });

    it('should check pgvector version >= 0.7.0', () => {
      expect(sql).toContain('0,7,0');
    });

    it('should be idempotent (no CREATE without IF NOT EXISTS)', () => {
      // Every CREATE should have IF NOT EXISTS
      const createStatements = sql.match(/CREATE\s+(INDEX|TABLE|POLICY)/gi);
      if (createStatements) {
        for (const stmt of createStatements) {
          // Find the full statement context
          const idx = sql.indexOf(stmt);
          const context = sql.slice(idx, idx + 80);
          expect(context).toContain('IF NOT EXISTS');
        }
      }
    });

    it('should target memory_embeddings table', () => {
      expect(sql).toContain('memory_embeddings');
    });
  });

  // ── Backfill Script ───────────────────────────────────────────

  describe('backfill script', () => {
    const scriptPath = path.join(
      __dirname,
      '../../scripts/backfill-halfvec.ts',
    );

    let source: string;

    beforeAll(() => {
      source = fs.readFileSync(scriptPath, 'utf-8');
    });

    it('should exist', () => {
      expect(fs.existsSync(scriptPath)).toBe(true);
    });

    it('should use batch processing', () => {
      expect(source).toContain('BATCH_SIZE');
      expect(source).toMatch(/LIMIT\s+\$\{BATCH_SIZE\}|LIMIT\s+\d+/);
    });

    it('should cast embedding to halfvec(768)', () => {
      expect(source).toContain('::halfvec(768)');
    });

    it('should only update rows without halfvec', () => {
      expect(source).toContain('embedding_halfvec IS NULL');
    });

    it('should check pgvector version', () => {
      expect(source).toContain("extname = 'vector'");
    });

    it('should check column exists before backfilling', () => {
      expect(source).toContain('information_schema.columns');
      expect(source).toContain('embedding_halfvec');
    });

    it('should log progress per batch', () => {
      expect(source).toContain('Batch');
    });
  });

  // ── Benchmark Script ──────────────────────────────────────────

  describe('benchmark script', () => {
    const scriptPath = path.join(
      __dirname,
      '../../scripts/benchmark-halfvec.ts',
    );

    let source: string;

    beforeAll(() => {
      source = fs.readFileSync(scriptPath, 'utf-8');
    });

    it('should exist', () => {
      expect(fs.existsSync(scriptPath)).toBe(true);
    });

    it('should have at least 15 Alice queries', () => {
      const queryMatches = source.match(/id:\s*'[^']+'/g);
      expect(queryMatches).toBeTruthy();
      expect(queryMatches!.length).toBeGreaterThanOrEqual(15);
    });

    it('should query both float32 and halfvec columns', () => {
      expect(source).toContain('me.embedding <=>');
      expect(source).toContain('me.embedding_halfvec <=>');
    });

    it('should cast query vectors correctly', () => {
      expect(source).toContain('::vector');
      expect(source).toContain('::halfvec');
    });

    it('should filter by user_id and deleted_at', () => {
      expect(source).toContain('m.user_id');
      expect(source).toContain('m.deleted_at IS NULL');
    });

    it('should include semantic, emotional, and temporal categories', () => {
      expect(source).toContain("category: 'semantic'");
      expect(source).toContain("category: 'emotional'");
      expect(source).toContain("category: 'temporal'");
    });

    it('should write report to reports/halfvec-benchmark/', () => {
      expect(source).toContain('reports');
      expect(source).toContain('halfvec-benchmark');
    });

    it('should measure latency for both query types', () => {
      expect(source).toContain('performance.now()');
      expect(source).toContain('latencyMs');
    });

    it('should compare top-K results by ID', () => {
      expect(source).toContain('topKMatch');
    });

    it('should estimate storage impact', () => {
      expect(source).toContain('pg_column_size');
    });

    it('should handle unsupported pgvector gracefully', () => {
      expect(source).toContain('writeUnsupportedReport');
    });

    it('should use the local embed service', () => {
      expect(source).toContain('localhost:8080');
      expect(source).toContain('bge-base-en-v1.5');
    });
  });

  // ── Report format ─────────────────────────────────────────────

  describe('report directory', () => {
    it('reports/halfvec-benchmark/ directory should exist', () => {
      const dir = path.join(__dirname, '../../reports/halfvec-benchmark');
      expect(fs.existsSync(dir)).toBe(true);
    });
  });
});

/**
 * SQL injection prevention tests for TimelineService.searchArcs (ENG-165).
 *
 * The arc-search semantic path issues a raw pgvector query. This suite proves:
 *   1. The query embedding vector is passed as a bound `$2::vector` parameter,
 *      never string-interpolated into the SQL text.
 *   2. The agentId (scoping value) is a bound parameter, never interpolated.
 *   3. Date-window bounds are bound parameters, never interpolated.
 *
 * Mirrors the rigor of the existing `*-injection.security.spec.ts` suites
 * (e.g. src/vector/providers/pgvector-injection.security.spec.ts).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { TimelineService } from './timeline.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from '../embedding/embedding.service';

describe('TimelineService.searchArcs — SQL injection prevention', () => {
  let service: TimelineService;
  let capturedSql: string;
  let capturedParams: any[];

  const QUERY_VEC = new Array(768).fill(0.25);

  beforeEach(async () => {
    capturedSql = '';
    capturedParams = [];

    const prisma = {
      $queryRawUnsafe: jest.fn((sql: string, ...params: any[]) => {
        capturedSql = sql;
        capturedParams = params;
        return Promise.resolve([]);
      }),
      timeline: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TimelineService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: EmbeddingService,
          useValue: { embed: jest.fn().mockResolvedValue([QUERY_VEC]) },
        },
        { provide: ConfigService, useValue: { get: jest.fn(() => undefined) } },
      ],
    }).compile();

    service = module.get<TimelineService>(TimelineService);
  });

  it('binds the query vector as a parameter, never interpolating it', async () => {
    await service.searchArcs('agent-1', { query: 'launch work' });

    // The raw vector values must not appear inline in the SQL string.
    expect(capturedSql).not.toContain('0.25,0.25');
    // The vector is referenced via a bound placeholder and bound as a literal.
    expect(capturedSql).toContain('$2::vector');
    expect(capturedParams).toContain(`[${QUERY_VEC.join(',')}]`);
  });

  it('binds a malicious agentId as a parameter, never interpolating it', async () => {
    const maliciousAgentId = "agent'; DROP TABLE timelines; --";

    await service.searchArcs(maliciousAgentId, { query: 'x' });

    expect(capturedSql).not.toContain(maliciousAgentId);
    expect(capturedSql).not.toContain('DROP TABLE');
    expect(capturedParams).toContain(maliciousAgentId);
  });

  it('binds date-window bounds as parameters, never interpolating them', async () => {
    await service.searchArcs('agent-1', {
      query: 'x',
      from: '2026-03-01',
      to: '2026-03-31',
    });

    // Only placeholders appear in the SQL; the parsed Dates are bound.
    expect(capturedSql).toContain('"agentLocalDate" >= $3');
    expect(capturedSql).toContain('"agentLocalDate" <= $4');
    expect(capturedParams[2]).toEqual(new Date('2026-03-01'));
    expect(capturedParams[3]).toEqual(new Date('2026-03-31'));
    expect(capturedSql).not.toContain('2026-03-01');
  });

  it('does not concatenate the query text into the SQL', async () => {
    const maliciousQuery = "'; DROP TABLE timelines; --";

    await service.searchArcs('agent-1', { query: maliciousQuery });

    // The query text is embedded (turned into a vector), never placed in SQL.
    expect(capturedSql).not.toContain('DROP TABLE');
    expect(capturedSql).not.toContain(maliciousQuery);
  });
});

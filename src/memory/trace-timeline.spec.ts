import { Test, TestingModule } from '@nestjs/testing';
import { MemoryQueryService } from './memory-query.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from './embedding.service';
import { TemporalParserService } from './temporal/temporal-parser.service';
import { RecallWeightService } from './recall-weight.service';
import { MemoryQueryRankingService } from './memory-query-ranking.service';
import { MemoryQueryContextService } from './memory-query-context.service';
import { TraceTimelineDto } from './dto/trace-timeline.dto';

describe('traceTimeline', () => {
  let service: MemoryQueryService;
  let mockPrisma: { $queryRawUnsafe: jest.Mock };

  beforeEach(async () => {
    mockPrisma = { $queryRawUnsafe: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoryQueryService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EmbeddingService, useValue: {} },
        { provide: TemporalParserService, useValue: {} },
        { provide: RecallWeightService, useValue: {} },
        { provide: MemoryQueryRankingService, useValue: {} },
        { provide: MemoryQueryContextService, useValue: {} },
      ],
    }).compile();

    service = module.get(MemoryQueryService);
    jest.clearAllMocks();
  });

  const baseDto: TraceTimelineDto = {
    topic: 'deployment',
    startDate: '2026-03-01',
    endDate: '2026-03-05',
    method: 'keyword',
    limit: 100,
  };

  it('should return memories in chronological order', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([
      { id: 'm1', raw: 'deployment started', memory_type: 'OBSERVATION', importance_score: 5, created_at: new Date('2026-03-01T10:00:00Z') },
      { id: 'm2', raw: 'deployment finished', memory_type: 'OBSERVATION', importance_score: 7, created_at: new Date('2026-03-03T14:00:00Z') },
      { id: 'm3', raw: 'deployment rollback', memory_type: 'OBSERVATION', importance_score: 9, created_at: new Date('2026-03-05T08:00:00Z') },
    ]);

    const result = await service.traceTimeline('agent-1', baseDto);

    expect(result.entries).toHaveLength(3);
    expect(result.entries[0].date).toBe('2026-03-01');
    expect(result.entries[1].date).toBe('2026-03-03');
    expect(result.entries[2].date).toBe('2026-03-05');
    expect(result.totalMemories).toBe(3);
  });

  it('should detect gaps (days with no memories)', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([
      { id: 'm1', raw: 'deployment started', memory_type: 'OBSERVATION', importance_score: 5, created_at: new Date('2026-03-01T10:00:00Z') },
      { id: 'm2', raw: 'deployment finished', memory_type: 'OBSERVATION', importance_score: 7, created_at: new Date('2026-03-05T14:00:00Z') },
    ]);

    const result = await service.traceTimeline('agent-1', baseDto);

    expect(result.gaps).toEqual(['2026-03-02', '2026-03-03', '2026-03-04']);
  });

  it('should calculate coverage percentage', async () => {
    // 5 days total, memories on 2 days → 40% coverage
    mockPrisma.$queryRawUnsafe.mockResolvedValue([
      { id: 'm1', raw: 'deployment v1', memory_type: 'OBSERVATION', importance_score: 5, created_at: new Date('2026-03-01T10:00:00Z') },
      { id: 'm2', raw: 'deployment v2', memory_type: 'OBSERVATION', importance_score: 7, created_at: new Date('2026-03-03T14:00:00Z') },
    ]);

    const result = await service.traceTimeline('agent-1', baseDto);

    expect(result.coverage).toBe(40);
  });

  it('should filter by agentId', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

    await service.traceTimeline('agent-42', baseDto);

    expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    const callArgs = mockPrisma.$queryRawUnsafe.mock.calls[0];
    // agentId is the second argument ($1)
    expect(callArgs[1]).toBe('agent-42');
  });

  it('should return empty results when no memories match', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([]);

    const result = await service.traceTimeline('agent-1', baseDto);

    expect(result.totalMemories).toBe(0);
    expect(result.entries).toHaveLength(0);
    expect(result.gaps).toHaveLength(5); // all 5 days are gaps
    expect(result.coverage).toBe(0);
    expect(result.topic).toBe('deployment');
    expect(result.range).toEqual({ start: '2026-03-01', end: '2026-03-05' });
  });
});

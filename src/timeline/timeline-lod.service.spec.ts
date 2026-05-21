import { Test, TestingModule } from '@nestjs/testing';
import { Memory } from '@prisma/client';
import { TimelineLodService, TimelineLodResult } from './timeline-lod.service';
import { LLMService } from '../llm/llm.service';

function createMockMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'mem_1',
    userId: 'user_1',
    raw: 'Test memory content',
    layer: 'SESSION' as any,
    source: 'EXPLICIT_STATEMENT' as any,
    importanceScore: 0.5,
    effectiveScore: 0.5,
    safetyCritical: false,
    createdAt: new Date('2026-03-22T10:00:00Z'),
    updatedAt: new Date('2026-03-22T10:00:00Z'),
    deletedAt: null,
    projectId: null,
    sessionId: null,
    memoryType: null,
    typeConfidence: null,
    priority: 3,
    promotedFrom: null,
    userPinned: false,
    userHidden: false,
    scoreComputedAt: null,
    subjectType: 'USER' as any,
    subjectId: null,
    agentId: null,
    importanceHint: null,
    confidence: 1.0,
    sessionPosition: null,
    embeddingId: null,
    embeddingModel: null,
    embeddingStatus: 'PENDING' as any,
    isDuplicateOf: null,
    retrievalCount: 0,
    lastRetrievedAt: null,
    usedCount: 0,
    lastUsedAt: null,
    searchable: true,
    consolidated: false,
    consolidatedAt: null,
    supersededById: null,
    supersededAt: null,
    consolidatedInto: null,
    archivedReason: null,
    clusterId: null,
    visibility: 'PRIVATE' as any,
    createdBySession: null,
    lastDreamCycleAt: null,
    lastDreamedAt: null,
    tier: null,
    patternSourceIds: [],
    cloudSyncedAt: null,
    contentHash: null,
    ingestedAt: new Date('2026-03-22T10:00:00Z'),
    metadata: null,
    durability: 'UNCLASSIFIED' as any,
    durabilityClassifiedAt: null,
    tags: [],
    ...overrides,
  } as Memory;
}

const FULL_LLM_RESPONSE = {
  chapter: 'SimulaaS ships',
  indexText:
    '2026-03-22: "SimulaaS ships" — engine Grade A, WASM live, waitlist pipeline, pricing locked. [SimulaaS arc]',
  summaryText:
    'A landmark day for the SimulaaS project. The engine achieved Grade A certification, WASM compilation went live, and the waitlist pipeline was fully configured. Pricing was locked in after weeks of deliberation. Team morale is high.',
  standardText:
    'The SimulaaS project reached a major milestone on 2026-03-22. The simulation engine passed Grade A certification after three rounds of testing. WASM compilation was deployed to production, enabling browser-based simulations. The waitlist pipeline was configured and tested end-to-end. After weeks of deliberation, the pricing model was finalized at $29/mo for indie and $199/mo for teams. The team celebrated with a virtual toast. Open threads include documentation updates and the onboarding flow redesign.',
  events: [
    {
      time: '09:15',
      description: 'Engine achieved Grade A certification',
      significance: 9,
      tags: ['engine', 'milestone'],
    },
    {
      time: '11:30',
      description: 'WASM compilation deployed to production',
      significance: 8,
      tags: ['wasm', 'deployment'],
    },
    {
      time: '14:00',
      description: 'Waitlist pipeline configured',
      significance: 6,
      tags: ['waitlist', 'pipeline'],
    },
    {
      time: '16:45',
      description: 'Pricing locked at $29/mo indie, $199/mo teams',
      significance: 7,
      tags: ['pricing', 'decision'],
    },
  ],
  decisions: [
    {
      description: 'Locked pricing at $29/mo indie, $199/mo teams',
      reasoning: 'Market research and competitor analysis supported this tier',
      decidedBy: 'Product team',
      reversible: true,
      relatedMemoryIds: ['mem_3', 'mem_5'],
    },
  ],
  people: ['Alex', 'Jordan', 'Product team'],
  mood: 'triumphant',
  significance: 9,
};

describe('TimelineLodService', () => {
  let service: TimelineLodService;
  let mockLlm: { json: jest.Mock };

  beforeEach(async () => {
    mockLlm = {
      json: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TimelineLodService,
        { provide: LLMService, useValue: mockLlm },
      ],
    }).compile();

    service = module.get<TimelineLodService>(TimelineLodService);
    jest.clearAllMocks();
  });

  describe('happy path', () => {
    it('should generate all LOD fields from 5 memories', async () => {
      const memories = [
        createMockMemory({
          id: 'mem_1',
          raw: 'Engine achieved Grade A certification',
          createdAt: new Date('2026-03-22T09:15:00Z'),
          tags: ['engine', 'milestone'],
          importanceScore: 0.9,
        }),
        createMockMemory({
          id: 'mem_2',
          raw: 'WASM compilation deployed to production',
          createdAt: new Date('2026-03-22T11:30:00Z'),
          tags: ['wasm', 'deployment'],
          importanceScore: 0.8,
        }),
        createMockMemory({
          id: 'mem_3',
          raw: 'Waitlist pipeline configured and tested',
          createdAt: new Date('2026-03-22T14:00:00Z'),
          tags: ['waitlist'],
          importanceScore: 0.6,
        }),
        createMockMemory({
          id: 'mem_4',
          raw: 'Pricing locked at $29/mo indie, $199/mo teams',
          createdAt: new Date('2026-03-22T16:45:00Z'),
          tags: ['pricing'],
          importanceScore: 0.7,
        }),
        createMockMemory({
          id: 'mem_5',
          raw: 'Team celebrated with virtual toast',
          createdAt: new Date('2026-03-22T17:30:00Z'),
          tags: ['team'],
          importanceScore: 0.3,
        }),
      ];

      mockLlm.json.mockResolvedValue(FULL_LLM_RESPONSE);

      const result = await service.generateLod(memories, '2026-03-22');

      expect(result.indexText).toContain('SimulaaS ships');
      expect(result.summaryText).toContain('landmark day');
      expect(result.standardText).toContain('Grade A certification');
      expect(result.events).toHaveLength(4);
      expect(result.decisions).toHaveLength(1);
      expect(result.chapter).toBe('SimulaaS ships');
      expect(result.significance).toBe(9);
      expect(result.people).toContain('Alex');
      expect(result.mood).toBe('triumphant');
    });

    it('should call LLM with correct system and user messages', async () => {
      const memories = [
        createMockMemory({
          raw: 'Deployed v2 to staging',
          createdAt: new Date('2026-03-22T14:30:00Z'),
          tags: ['deploy', 'staging'],
          importanceScore: 0.7,
        }),
      ];

      mockLlm.json.mockResolvedValue(FULL_LLM_RESPONSE);

      await service.generateLod(memories, '2026-03-22');

      expect(mockLlm.json).toHaveBeenCalledTimes(1);
      const [messages, schema, options] = mockLlm.json.mock.calls[0];
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe('system');
      expect(messages[0].content).toContain('memory archivist');
      expect(messages[1].role).toBe('user');
      expect(messages[1].content).toContain('2026-03-22');
      expect(messages[1].content).toContain('Deployed v2 to staging');
      expect(options.temperature).toBe(0.3);
    });

    it('should format memory timestamps as HH:MM', async () => {
      const memories = [
        createMockMemory({
          raw: 'Morning standup',
          createdAt: new Date('2026-03-22T09:05:00Z'),
        }),
      ];

      mockLlm.json.mockResolvedValue(FULL_LLM_RESPONSE);
      await service.generateLod(memories, '2026-03-22');

      const userContent = mockLlm.json.mock.calls[0][0][1].content;
      expect(userContent).toContain('[09:05]');
    });

    it('should include tags in the formatted prompt', async () => {
      const memories = [
        createMockMemory({
          raw: 'Refactored auth module',
          tags: ['refactor', 'auth'],
        }),
      ];

      mockLlm.json.mockResolvedValue(FULL_LLM_RESPONSE);
      await service.generateLod(memories, '2026-03-22');

      const userContent = mockLlm.json.mock.calls[0][0][1].content;
      expect(userContent).toContain('(tags: refactor, auth)');
    });

    it('should omit tags section when memory has no tags', async () => {
      const memories = [createMockMemory({ raw: 'Quick note', tags: [] })];

      mockLlm.json.mockResolvedValue(FULL_LLM_RESPONSE);
      await service.generateLod(memories, '2026-03-22');

      const userContent = mockLlm.json.mock.calls[0][0][1].content;
      expect(userContent).not.toContain('(tags:');
    });
  });

  describe('empty input', () => {
    it('should return minimal timeline with low significance for empty memories', async () => {
      const result = await service.generateLod([], '2026-03-22');

      expect(result.significance).toBe(1);
      expect(result.chapter).toBe('Quiet day');
      expect(result.mood).toBe('neutral');
      expect(result.events).toEqual([]);
      expect(result.decisions).toEqual([]);
      expect(result.people).toEqual([]);
      expect(result.indexText).toContain('2026-03-22');
      expect(result.indexText).toContain('Quiet day');
      expect(mockLlm.json).not.toHaveBeenCalled();
    });
  });

  describe('single memory', () => {
    it('should generate valid LOD from a single memory', async () => {
      const singleResponse = {
        chapter: 'Quick fix',
        indexText: '2026-03-22: "Quick fix" — patched auth bug. [maintenance]',
        summaryText: 'A single bug fix was deployed to patch the auth module.',
        standardText:
          'The day consisted of a single focused task: fixing the auth module bug that had been affecting login flows.',
        events: [
          {
            time: '10:00',
            description: 'Fixed auth bug',
            significance: 5,
            tags: ['bugfix'],
          },
        ],
        decisions: [],
        people: [],
        mood: 'focused',
        significance: 4,
      };

      mockLlm.json.mockResolvedValue(singleResponse);

      const memories = [
        createMockMemory({ raw: 'Fixed auth module login bug' }),
      ];

      const result = await service.generateLod(memories, '2026-03-22');

      expect(result.indexText).toContain('Quick fix');
      expect(result.events).toHaveLength(1);
      expect(result.significance).toBe(4);
      expect(result.mood).toBe('focused');
    });
  });

  describe('LLM error handling', () => {
    it('should throw with descriptive message on LLM failure', async () => {
      mockLlm.json.mockRejectedValue(new Error('Rate limit exceeded'));

      const memories = [createMockMemory()];

      await expect(service.generateLod(memories, '2026-03-22')).rejects.toThrow(
        'Timeline LOD generation failed for 2026-03-22: Rate limit exceeded',
      );
    });

    it('should handle non-Error exceptions from LLM', async () => {
      mockLlm.json.mockRejectedValue('unexpected string error');

      const memories = [createMockMemory()];

      await expect(service.generateLod(memories, '2026-03-22')).rejects.toThrow(
        'Timeline LOD generation failed for 2026-03-22: Unknown LLM error',
      );
    });
  });

  describe('response parsing robustness', () => {
    it('should handle missing optional fields with defaults', async () => {
      mockLlm.json.mockResolvedValue({
        chapter: 'Partial',
        indexText: '2026-03-22: "Partial" — some data.',
        summaryText: 'Partial summary.',
        standardText: 'Partial standard.',
        // events, decisions, people, mood all missing
        significance: 5,
      });

      const memories = [createMockMemory()];
      const result = await service.generateLod(memories, '2026-03-22');

      expect(result.events).toEqual([]);
      expect(result.decisions).toEqual([]);
      expect(result.people).toEqual([]);
      expect(result.mood).toBe('neutral');
      expect(result.significance).toBe(5);
    });

    it('should clamp significance to 1-10 range', async () => {
      mockLlm.json.mockResolvedValue({
        ...FULL_LLM_RESPONSE,
        significance: 15,
      });

      const memories = [createMockMemory()];
      const result = await service.generateLod(memories, '2026-03-22');

      expect(result.significance).toBe(10);
    });

    it('should clamp significance minimum to 1', async () => {
      mockLlm.json.mockResolvedValue({
        ...FULL_LLM_RESPONSE,
        significance: -3,
      });

      const memories = [createMockMemory()];
      const result = await service.generateLod(memories, '2026-03-22');

      expect(result.significance).toBe(1);
    });

    it('should default significance to 1 when non-numeric', async () => {
      mockLlm.json.mockResolvedValue({
        ...FULL_LLM_RESPONSE,
        significance: 'high',
      });

      const memories = [createMockMemory()];
      const result = await service.generateLod(memories, '2026-03-22');

      expect(result.significance).toBe(1);
    });

    it('should fallback indexText when LLM returns empty string', async () => {
      mockLlm.json.mockResolvedValue({
        ...FULL_LLM_RESPONSE,
        indexText: '',
      });

      const memories = [createMockMemory()];
      const result = await service.generateLod(memories, '2026-03-22');

      expect(result.indexText).toContain('2026-03-22');
      expect(result.indexText).toContain('Quiet day');
    });
  });
});

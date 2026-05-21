import { DreamCycleIdentityStage } from './dream-cycle-identity.stage';

describe('HEY-176: Dream Cycle Identity Consolidation Stage', () => {
  let stage: DreamCycleIdentityStage;
  let mockPrisma: any;
  let mockLlm: any;
  let mockConfig: any;

  beforeEach(() => {
    mockPrisma = {
      memory: {
        findMany: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      identitySnapshot: {
        findFirst: jest.fn(),
        create: jest.fn(),
      },
    };
    mockLlm = {
      chat: jest.fn(),
    };
    mockConfig = {
      get: jest.fn().mockReturnValue(undefined),
    };
    stage = new DreamCycleIdentityStage(mockPrisma, mockLlm, mockConfig);
  });

  describe('run', () => {
    it('should return empty result when LLM budget is 0', async () => {
      const result = await stage.run('user-1', false, 0);
      expect(result.snapshotId).toBeNull();
      expect(result.llmCalls).toBe(0);
    });

    it('should return empty result when insufficient memories', async () => {
      mockPrisma.memory.findMany.mockResolvedValue([
        { id: '1', raw: 'test', layer: 'IDENTITY' },
      ]);

      const result = await stage.run('user-1', false, 5);
      expect(result.snapshotId).toBeNull();
      expect(result.llmCalls).toBe(0);
    });

    it('should extract identity and create snapshot', async () => {
      const memories = Array.from({ length: 10 }, (_, i) => ({
        id: `mem-${i}`,
        raw: `Identity memory ${i}`,
        layer: 'IDENTITY',
        memoryType: i < 3 ? 'PREFERENCE' : 'FACT',
        subjectType: 'USER',
        agentId: null,
        source: 'EXPLICIT_STATEMENT',
        effectiveScore: 0.8,
        createdAt: new Date(),
        metadata: null,
      }));

      mockPrisma.memory.findMany.mockResolvedValue(memories);
      mockPrisma.identitySnapshot.findFirst.mockResolvedValue(null);
      mockPrisma.identitySnapshot.create.mockResolvedValue({
        id: 'snapshot-1',
      });

      const identityData = {
        capabilities: [
          { name: 'TypeScript', confidence: 0.9, lastSeen: '2025-01-15' },
        ],
        preferences: { style: 'concise' },
        trustScores: { accuracy: 0.85 },
        behavioralTraits: [
          { trait: 'detail-oriented', strength: 0.7, evidence: 'consistent' },
        ],
      };

      mockLlm.chat.mockResolvedValue({
        content: JSON.stringify(identityData),
      });

      const result = await stage.run('user-1', false, 5, 'report-1');

      expect(result.snapshotId).toBe('snapshot-1');
      expect(result.capabilitiesExtracted).toBe(1);
      expect(result.preferencesExtracted).toBe(1);
      expect(result.behavioralTraits).toBe(1);
      expect(result.llmCalls).toBe(1);

      expect(mockPrisma.identitySnapshot.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user-1',
          dreamReportId: 'report-1',
          capabilities: identityData.capabilities,
          preferences: identityData.preferences,
        }),
      });

      // Should mark memories as processed
      expect(mockPrisma.memory.updateMany).toHaveBeenCalled();
    });

    it('should include userId in updateMany when marking memories as processed', async () => {
      const memories = Array.from({ length: 10 }, (_, i) => ({
        id: `mem-${i}`,
        raw: `Identity memory ${i}`,
        layer: 'IDENTITY',
        memoryType: i < 3 ? 'PREFERENCE' : 'FACT',
        subjectType: 'USER',
        agentId: null,
        source: 'EXPLICIT_STATEMENT',
        effectiveScore: 0.8,
        createdAt: new Date(),
        metadata: null,
      }));

      mockPrisma.memory.findMany.mockResolvedValue(memories);
      mockPrisma.identitySnapshot.findFirst.mockResolvedValue(null);
      mockPrisma.identitySnapshot.create.mockResolvedValue({
        id: 'snapshot-1',
      });

      mockLlm.chat.mockResolvedValue({
        content: JSON.stringify({
          capabilities: [
            { name: 'TypeScript', confidence: 0.9, lastSeen: '2025-01-15' },
          ],
          preferences: { style: 'concise' },
          trustScores: { accuracy: 0.85 },
          behavioralTraits: [],
        }),
      });

      await stage.run('user-1', false, 5, 'report-1');

      // updateMany must scope by userId to prevent cross-account leakage
      expect(mockPrisma.memory.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: 'user-1' }),
        }),
      );
    });

    it('should not create snapshot in dry run mode', async () => {
      const memories = Array.from({ length: 10 }, (_, i) => ({
        id: `mem-${i}`,
        raw: `Identity memory ${i}`,
        layer: 'IDENTITY',
        memoryType: null,
        subjectType: 'USER',
        agentId: null,
        source: 'EXPLICIT_STATEMENT',
        effectiveScore: 0.8,
        createdAt: new Date(),
        metadata: null,
      }));

      mockPrisma.memory.findMany.mockResolvedValue(memories);
      mockPrisma.identitySnapshot.findFirst.mockResolvedValue(null);

      mockLlm.chat.mockResolvedValue({
        content: JSON.stringify({
          capabilities: [
            { name: 'test', confidence: 0.5, lastSeen: '2025-01-01' },
          ],
          preferences: {},
          trustScores: {},
          behavioralTraits: [],
        }),
      });

      const result = await stage.run('user-1', true, 5);

      expect(result.snapshotId).toBeNull();
      expect(result.capabilitiesExtracted).toBe(1);
      expect(result.llmCalls).toBe(1);
      expect(mockPrisma.identitySnapshot.create).not.toHaveBeenCalled();
    });

    it('should pass previous snapshot to LLM for delta updates', async () => {
      const memories = Array.from({ length: 10 }, (_, i) => ({
        id: `mem-${i}`,
        raw: `Memory ${i}`,
        layer: 'IDENTITY',
        memoryType: null,
        subjectType: 'USER',
        agentId: null,
        source: 'EXPLICIT_STATEMENT',
        effectiveScore: 0.8,
        createdAt: new Date(),
        metadata: null,
      }));

      const previousSnapshot = {
        id: 'prev-snapshot',
        capabilities: [
          { name: 'Python', confidence: 0.7, lastSeen: '2024-12-01' },
        ],
        preferences: { language: 'Python' },
        behavioralTraits: [],
        createdAt: new Date('2025-01-01'),
      };

      mockPrisma.memory.findMany.mockResolvedValue(memories);
      mockPrisma.identitySnapshot.findFirst.mockResolvedValue(previousSnapshot);
      mockPrisma.identitySnapshot.create.mockResolvedValue({
        id: 'new-snapshot',
      });

      mockLlm.chat.mockResolvedValue({
        content: JSON.stringify({
          capabilities: [
            { name: 'Python', confidence: 0.8, lastSeen: '2025-01-15' },
            { name: 'TypeScript', confidence: 0.6, lastSeen: '2025-01-15' },
          ],
          preferences: { language: 'Python' },
          trustScores: {},
          behavioralTraits: [],
        }),
      });

      const result = await stage.run('user-1', false, 5);
      expect(result.capabilitiesExtracted).toBe(2);

      // Verify LLM was called with previous snapshot context
      const llmCall = mockLlm.chat.mock.calls[0];
      const userMessage = llmCall[0][1].content;
      expect(userMessage).toContain('PREVIOUS IDENTITY SNAPSHOT');
    });

    it('should handle LLM returning markdown-wrapped JSON', async () => {
      const memories = Array.from({ length: 10 }, (_, i) => ({
        id: `mem-${i}`,
        raw: `Memory ${i}`,
        layer: 'IDENTITY',
        memoryType: null,
        subjectType: 'USER',
        agentId: null,
        source: 'EXPLICIT_STATEMENT',
        effectiveScore: 0.8,
        createdAt: new Date(),
        metadata: null,
      }));

      mockPrisma.memory.findMany.mockResolvedValue(memories);
      mockPrisma.identitySnapshot.findFirst.mockResolvedValue(null);
      mockPrisma.identitySnapshot.create.mockResolvedValue({ id: 'snap-1' });

      mockLlm.chat.mockResolvedValue({
        content:
          '```json\n{"capabilities":[],"preferences":{},"trustScores":{},"behavioralTraits":[]}\n```',
      });

      const result = await stage.run('user-1', false, 5);
      expect(result.snapshotId).toBe('snap-1');
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import {
  DreamCycleDriftStage,
  DriftStageResult,
} from './dream-cycle-drift.stage';
import { ServicePrismaService } from '../../prisma/service-prisma.service';
import { DriftDetectionService } from '../../ensemble/drift-detection.service';
import { EnsembleService } from '../../ensemble/ensemble.service';

const mockPrisma = {
  memory: { findMany: jest.fn() },
  driftSnapshot: { create: jest.fn() },
};

const mockDriftDetection = {
  measureBatchDrift: jest.fn(),
  summarizeDrift: jest.fn(),
  getThresholds: jest.fn(),
};

const mockEnsemble = {
  getConfig: jest.fn(),
  embedAll: jest.fn(),
};

const sampleMemories = [
  { id: 'mem-1', raw: 'User logged in successfully' },
  { id: 'mem-2', raw: 'User created a new project' },
  { id: 'mem-3', raw: 'User updated their profile' },
];

const sampleEmbedding = Array.from({ length: 1536 }, (_, i) => i * 0.001);

function setupHappyPath(model = 'openai', avgDrift = 0.01, maxDrift = 0.05) {
  mockEnsemble.getConfig.mockReturnValue({ models: [model] });
  mockEnsemble.embedAll.mockResolvedValue({
    embeddings: [{ model, embedding: sampleEmbedding }],
  });
  mockDriftDetection.measureBatchDrift.mockResolvedValue(
    sampleMemories.map((m) => ({ memoryId: m.id, cosineDrift: avgDrift })),
  );
  mockDriftDetection.summarizeDrift.mockReturnValue({
    avgCosineDrift: avgDrift,
    maxCosineDrift: maxDrift,
    p95CosineDrift: avgDrift,
  });
  mockDriftDetection.getThresholds.mockReturnValue({
    drift: 0.05,
    alert: 0.1,
  });
  mockPrisma.driftSnapshot.create.mockResolvedValue({ id: 'snap-1' });
}

describe('DreamCycleDriftStage', () => {
  let stage: DreamCycleDriftStage;

  beforeEach(async () => {
    jest.clearAllMocks();
  });

  // Helper: build module with optional services
  async function buildModule(withDeps = true): Promise<void> {
    const providers: any[] = [
      DreamCycleDriftStage,
      { provide: ServicePrismaService, useValue: mockPrisma },
    ];

    if (withDeps) {
      providers.push(
        { provide: DriftDetectionService, useValue: mockDriftDetection },
        { provide: EnsembleService, useValue: mockEnsemble },
      );
    }

    const module: TestingModule = await Test.createTestingModule({
      providers,
    }).compile();

    stage = module.get<DreamCycleDriftStage>(DreamCycleDriftStage);
  }

  // ─── Early exit conditions ──────────────────────────────────────────────────

  describe('early exit conditions', () => {
    it('should return zero results when memories array is empty', async () => {
      await buildModule(true);
      mockPrisma.memory.findMany.mockResolvedValueOnce([]);

      const result = await stage.run('user-123', false);

      expect(result).toEqual({
        modelsAnalyzed: 0,
        snapshotsPersisted: 0,
        alerts: [],
      });
      expect(mockEnsemble.getConfig).not.toHaveBeenCalled();
    });

    it('should return zero results when driftDetectionService is not injected', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          DreamCycleDriftStage,
          { provide: ServicePrismaService, useValue: mockPrisma },
          { provide: EnsembleService, useValue: mockEnsemble },
          // DriftDetectionService NOT provided → @Optional() → undefined
        ],
      }).compile();
      stage = module.get<DreamCycleDriftStage>(DreamCycleDriftStage);

      mockPrisma.memory.findMany.mockResolvedValueOnce(sampleMemories);

      const result = await stage.run('user-123', false);

      expect(result).toEqual({
        modelsAnalyzed: 0,
        snapshotsPersisted: 0,
        alerts: [],
      });
    });

    it('should return zero results when ensembleService is not injected', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          DreamCycleDriftStage,
          { provide: ServicePrismaService, useValue: mockPrisma },
          { provide: DriftDetectionService, useValue: mockDriftDetection },
          // EnsembleService NOT provided → @Optional() → undefined
        ],
      }).compile();
      stage = module.get<DreamCycleDriftStage>(DreamCycleDriftStage);

      mockPrisma.memory.findMany.mockResolvedValueOnce(sampleMemories);

      const result = await stage.run('user-123', false);

      expect(result).toEqual({
        modelsAnalyzed: 0,
        snapshotsPersisted: 0,
        alerts: [],
      });
    });
  });

  // ─── Happy paths ────────────────────────────────────────────────────────────

  describe('happy paths', () => {
    beforeEach(() => buildModule(true));

    it('should analyze a single model and persist snapshot (dryRun=false)', async () => {
      mockPrisma.memory.findMany.mockResolvedValueOnce(sampleMemories);
      setupHappyPath('openai', 0.01, 0.02);

      const result: DriftStageResult = await stage.run('user-123', false);

      expect(result.modelsAnalyzed).toBe(1);
      expect(result.snapshotsPersisted).toBe(1);
      expect(result.alerts).toHaveLength(0);
      expect(mockPrisma.driftSnapshot.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.driftSnapshot.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            modelId: 'openai',
            alertLevel: 'normal',
          }),
        }),
      );
    });

    it('should skip snapshot creation in dryRun mode', async () => {
      mockPrisma.memory.findMany.mockResolvedValueOnce(sampleMemories);
      setupHappyPath('openai', 0.01);

      const result = await stage.run('user-123', true);

      expect(result.snapshotsPersisted).toBe(0);
      expect(mockPrisma.driftSnapshot.create).not.toHaveBeenCalled();
    });

    it('should analyze multiple models', async () => {
      mockPrisma.memory.findMany.mockResolvedValueOnce(sampleMemories);

      const models = ['openai', 'cohere'];
      mockEnsemble.getConfig.mockReturnValue({ models });
      mockEnsemble.embedAll.mockResolvedValue({
        embeddings: models.map((m) => ({
          model: m,
          embedding: sampleEmbedding,
        })),
      });
      mockDriftDetection.measureBatchDrift.mockResolvedValue(
        sampleMemories.map((m) => ({ memoryId: m.id, cosineDrift: 0.01 })),
      );
      mockDriftDetection.summarizeDrift.mockReturnValue({
        avgCosineDrift: 0.01,
        maxCosineDrift: 0.02,
      });
      mockDriftDetection.getThresholds.mockReturnValue({
        drift: 0.05,
        alert: 0.1,
      });
      mockPrisma.driftSnapshot.create.mockResolvedValue({ id: 'snap-x' });

      const result = await stage.run('user-123', false);

      expect(result.modelsAnalyzed).toBe(2);
      expect(result.snapshotsPersisted).toBe(2);
    });

    it('should query only non-deleted memories, limited to 50', async () => {
      mockPrisma.memory.findMany.mockResolvedValueOnce([]);

      await stage.run('user-123', false);

      expect(mockPrisma.memory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user-123', deletedAt: null },
          take: 50,
          orderBy: { updatedAt: 'desc' },
        }),
      );
    });

    it('should call embedAll for each memory in each model', async () => {
      mockPrisma.memory.findMany.mockResolvedValueOnce(sampleMemories);
      setupHappyPath('openai');

      await stage.run('user-123', false);

      expect(mockEnsemble.embedAll).toHaveBeenCalledTimes(
        sampleMemories.length,
      );
      expect(mockEnsemble.embedAll).toHaveBeenCalledWith(sampleMemories[0].raw);
    });
  });

  // ─── Alert threshold detection ───────────────────────────────────────────────

  describe('alert threshold detection', () => {
    beforeEach(() => buildModule(true));

    it('should generate a warning alert when drift exceeds warning threshold', async () => {
      mockPrisma.memory.findMany.mockResolvedValueOnce(sampleMemories);
      setupHappyPath('openai', 0.07, 0.09); // above drift(0.05), below alert(0.1)

      const result = await stage.run('user-123', false);

      expect(result.alerts).toHaveLength(1);
      expect(result.alerts[0]).toContain('Warning drift');
      expect(result.alerts[0]).toContain('openai');
      expect(result.alerts[0]).toContain('0.0700');
    });

    it('should generate a critical alert when drift exceeds alert threshold', async () => {
      mockPrisma.memory.findMany.mockResolvedValueOnce(sampleMemories);
      setupHappyPath('openai', 0.15, 0.2); // above alert(0.1)

      const result = await stage.run('user-123', false);

      expect(result.alerts).toHaveLength(1);
      expect(result.alerts[0]).toContain('Critical drift');
      expect(result.alerts[0]).toContain('openai');
    });

    it('should persist snapshot with "critical" alertLevel for critical drift', async () => {
      mockPrisma.memory.findMany.mockResolvedValueOnce(sampleMemories);
      setupHappyPath('openai', 0.15);

      await stage.run('user-123', false);

      expect(mockPrisma.driftSnapshot.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ alertLevel: 'critical' }),
        }),
      );
    });

    it('should persist snapshot with "warning" alertLevel for warning drift', async () => {
      mockPrisma.memory.findMany.mockResolvedValueOnce(sampleMemories);
      setupHappyPath('openai', 0.07);

      await stage.run('user-123', false);

      expect(mockPrisma.driftSnapshot.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ alertLevel: 'warning' }),
        }),
      );
    });

    it('should persist snapshot with "normal" alertLevel for low drift', async () => {
      mockPrisma.memory.findMany.mockResolvedValueOnce(sampleMemories);
      setupHappyPath('openai', 0.01);

      await stage.run('user-123', false);

      expect(mockPrisma.driftSnapshot.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ alertLevel: 'normal' }),
        }),
      );
    });

    it('should not generate an alert at exactly the warning threshold', async () => {
      mockPrisma.memory.findMany.mockResolvedValueOnce(sampleMemories);
      setupHappyPath('openai', 0.05); // exactly at drift threshold, not above

      const result = await stage.run('user-123', false);

      expect(result.alerts).toHaveLength(0);
    });
  });

  // ─── Error handling ──────────────────────────────────────────────────────────

  describe('error handling', () => {
    beforeEach(() => buildModule(true));

    it('should use empty embedding [] when embedAll throws for a memory', async () => {
      mockPrisma.memory.findMany.mockResolvedValueOnce(sampleMemories);

      mockEnsemble.getConfig.mockReturnValue({ models: ['openai'] });
      // First two succeed, third throws
      mockEnsemble.embedAll
        .mockResolvedValueOnce({
          embeddings: [{ model: 'openai', embedding: sampleEmbedding }],
        })
        .mockResolvedValueOnce({
          embeddings: [{ model: 'openai', embedding: sampleEmbedding }],
        })
        .mockRejectedValueOnce(new Error('OpenAI timeout'));

      mockDriftDetection.measureBatchDrift.mockResolvedValue(
        sampleMemories.map((m) => ({ memoryId: m.id, cosineDrift: 0.01 })),
      );
      mockDriftDetection.summarizeDrift.mockReturnValue({
        avgCosineDrift: 0.01,
        maxCosineDrift: 0.02,
      });
      mockDriftDetection.getThresholds.mockReturnValue({
        drift: 0.05,
        alert: 0.1,
      });
      mockPrisma.driftSnapshot.create.mockResolvedValue({});

      // Should not throw, handles error gracefully with empty embedding
      const result = await stage.run('user-123', false);
      expect(result.modelsAnalyzed).toBe(1);

      // Third memory embedding should be [] in the batch call
      const batchCall = mockDriftDetection.measureBatchDrift.mock.calls[0];
      const embeddings = batchCall[1];
      expect(embeddings[2]).toEqual([]);
    });

    it('should use empty embedding when model not found in embedAll result', async () => {
      mockPrisma.memory.findMany.mockResolvedValueOnce([sampleMemories[0]]);

      mockEnsemble.getConfig.mockReturnValue({ models: ['cohere'] });
      mockEnsemble.embedAll.mockResolvedValueOnce({
        embeddings: [{ model: 'openai', embedding: sampleEmbedding }], // wrong model
      });

      mockDriftDetection.measureBatchDrift.mockResolvedValue([
        { memoryId: 'mem-1', cosineDrift: 0.01 },
      ]);
      mockDriftDetection.summarizeDrift.mockReturnValue({
        avgCosineDrift: 0.01,
        maxCosineDrift: 0.01,
      });
      mockDriftDetection.getThresholds.mockReturnValue({
        drift: 0.05,
        alert: 0.1,
      });
      mockPrisma.driftSnapshot.create.mockResolvedValue({});

      const result = await stage.run('user-123', false);
      expect(result.modelsAnalyzed).toBe(1);

      // Embedding for the model should be [] since no matching model found
      const batchCall = mockDriftDetection.measureBatchDrift.mock.calls[0];
      expect(batchCall[1][0]).toEqual([]);
    });

    it('should accumulate alerts across multiple models', async () => {
      mockPrisma.memory.findMany.mockResolvedValueOnce(sampleMemories);

      const models = ['openai', 'cohere'];
      mockEnsemble.getConfig.mockReturnValue({ models });
      mockEnsemble.embedAll.mockResolvedValue({
        embeddings: models.map((m) => ({
          model: m,
          embedding: sampleEmbedding,
        })),
      });
      mockDriftDetection.measureBatchDrift.mockResolvedValue(
        sampleMemories.map((m) => ({ memoryId: m.id, cosineDrift: 0.15 })),
      );
      mockDriftDetection.summarizeDrift.mockReturnValue({
        avgCosineDrift: 0.15,
        maxCosineDrift: 0.2,
      });
      mockDriftDetection.getThresholds.mockReturnValue({
        drift: 0.05,
        alert: 0.1,
      });
      mockPrisma.driftSnapshot.create.mockResolvedValue({});

      const result = await stage.run('user-123', false);

      // Both models exceeded alert threshold → 2 alerts
      expect(result.alerts).toHaveLength(2);
      expect(result.alerts[0]).toContain('openai');
      expect(result.alerts[1]).toContain('cohere');
    });
  });
});

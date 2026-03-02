import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RecallWeightService } from './recall-weight.service';
import { Memory } from '@prisma/client';

const DAY_MS = 24 * 60 * 60 * 1000;

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'test-id',
    userId: 'user-1',
    raw: 'test',
    layer: 'SESSION',
    subjectType: 'USER',
    userPinned: false,
    userHidden: false,
    retrievalCount: 0,
    lastRetrievedAt: null,
    createdAt: new Date(Date.now() - 30 * DAY_MS),
    updatedAt: new Date(),
    deletedAt: null,
    importanceScore: 0.5,
    effectiveScore: null,
    confidence: 0.8,
    priority: 5,
    safetyCritical: false,
    supersededById: null,
    projectId: null,
    agentId: null,
    visibility: 'PRIVATE',
    usedCount: 0,
    lastUsedAt: null,
    ...overrides,
  } as Memory;
}

describe('RecallWeightService', () => {
  let service: RecallWeightService;

  const createService = async (envValue = 'true') => {
    const module = await Test.createTestingModule({
      providers: [
        RecallWeightService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, defaultValue: string) =>
              key === 'RECALL_TIER_WEIGHT_ENABLED' ? envValue : defaultValue,
          },
        },
      ],
    }).compile();
    return module.get(RecallWeightService);
  };

  beforeEach(async () => {
    service = await createService();
  });

  it('returns 1.0 for pinned memories', () => {
    const mem = makeMemory({ userPinned: true, lastRetrievedAt: null });
    expect(service.recallWeight(mem)).toBe(1.0);
  });

  it('returns 1.0 for HOT tier (accessed within 7 days)', () => {
    const mem = makeMemory({
      lastRetrievedAt: new Date(Date.now() - 2 * DAY_MS),
    });
    expect(service.recallWeight(mem)).toBe(1.0);
  });

  it('returns 0.9 for WARM tier (accessed within 30 days)', () => {
    const mem = makeMemory({
      lastRetrievedAt: new Date(Date.now() - 15 * DAY_MS),
    });
    expect(service.recallWeight(mem)).toBe(0.9);
  });

  it('returns 0.75 for COOLING tier (accessed within 90 days)', () => {
    const mem = makeMemory({
      lastRetrievedAt: new Date(Date.now() - 60 * DAY_MS),
    });
    expect(service.recallWeight(mem)).toBe(0.75);
  });

  it('returns 0.8 for frequently accessed memories (> 0.1 retrievals/day)', () => {
    // 30 days old, 5 retrievals = 5/30 ≈ 0.167 > 0.1
    const mem = makeMemory({
      lastRetrievedAt: new Date(Date.now() - 120 * DAY_MS),
      createdAt: new Date(Date.now() - 30 * DAY_MS),
      retrievalCount: 5,
    });
    expect(service.recallWeight(mem)).toBe(0.8);
  });

  it('returns 0.6 for COLD memories', () => {
    const mem = makeMemory({
      lastRetrievedAt: new Date(Date.now() - 120 * DAY_MS),
      createdAt: new Date(Date.now() - 365 * DAY_MS),
      retrievalCount: 1,
    });
    expect(service.recallWeight(mem)).toBe(0.6);
  });

  it('returns 0.6 when lastRetrievedAt is null and not pinned', () => {
    const mem = makeMemory({
      lastRetrievedAt: null,
      createdAt: new Date(Date.now() - 365 * DAY_MS),
      retrievalCount: 0,
    });
    expect(service.recallWeight(mem)).toBe(0.6);
  });

  it('pinned overrides all other tiers', () => {
    const mem = makeMemory({
      userPinned: true,
      lastRetrievedAt: new Date(Date.now() - 200 * DAY_MS),
      retrievalCount: 0,
    });
    expect(service.recallWeight(mem)).toBe(1.0);
  });

  it('returns 1.0 for boundary: exactly 7 days', () => {
    const mem = makeMemory({
      lastRetrievedAt: new Date(Date.now() - 7 * DAY_MS),
    });
    expect(service.recallWeight(mem)).toBe(1.0);
  });

  it('returns 0.9 for boundary: exactly 30 days', () => {
    const mem = makeMemory({
      lastRetrievedAt: new Date(Date.now() - 30 * DAY_MS),
    });
    expect(service.recallWeight(mem)).toBe(0.9);
  });

  describe('env toggle', () => {
    it('returns 1.0 for all memories when disabled', async () => {
      const disabled = await createService('false');
      const cold = makeMemory({
        lastRetrievedAt: new Date(Date.now() - 200 * DAY_MS),
        retrievalCount: 0,
      });
      expect(disabled.recallWeight(cold)).toBe(1.0);
    });

    it('applies weights when enabled', async () => {
      const enabled = await createService('true');
      const cold = makeMemory({
        lastRetrievedAt: new Date(Date.now() - 200 * DAY_MS),
        createdAt: new Date(Date.now() - 365 * DAY_MS),
        retrievalCount: 0,
      });
      expect(enabled.recallWeight(cold)).toBe(0.6);
    });
  });

  it('handles very new memory (age < 1 day) without division issues', () => {
    const mem = makeMemory({
      lastRetrievedAt: new Date(Date.now() - 120 * DAY_MS),
      createdAt: new Date(), // just created
      retrievalCount: 0,
    });
    // ageInDays clamped to 1, 0/1 = 0 <= 0.1 → COLD
    expect(service.recallWeight(mem)).toBe(0.6);
  });
});

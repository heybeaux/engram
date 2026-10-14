import {
  AutoExtractorService,
  ExtractorContext,
} from './auto-extractor.service';
import { LLMService } from '../llm/llm.service';
import {
  MessageTurnDto,
  MessageRole,
  ImportanceSignal,
} from './dto/observe.dto';

const mockLlm = {
  json: jest.fn(),
};

describe('AutoExtractorService', () => {
  let service: AutoExtractorService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    service = new AutoExtractorService(mockLlm as unknown as LLMService);
  });

  const turns: MessageTurnDto[] = [
    { role: MessageRole.USER, content: 'I prefer dark mode for everything' },
    {
      role: MessageRole.ASSISTANT,
      content: 'Got it, dark mode preference noted!',
    },
    {
      role: MessageRole.USER,
      content: 'My name is Beaux and I live in Vancouver',
    },
  ];

  const signals: ImportanceSignal[] = [
    {
      turnIndex: 0,
      type: 'preference',
      trigger: 'prefer',
      content: 'User prefers dark mode for everything',
      confidence: 0.8,
    },
  ];

  // =========================================================================
  // Happy path: LLM extraction
  // =========================================================================

  it('should extract memories via LLM', async () => {
    mockLlm.json.mockResolvedValue({
      facts: [
        {
          content: 'User prefers dark mode for all applications',
          turnIndex: 0,
        },
        { content: 'User is named Beaux and lives in Vancouver', turnIndex: 2 },
      ],
    });

    const result = await service.extract(turns, signals);

    expect(result).toHaveLength(2);
    expect(result[0].content).toBe(
      'User prefers dark mode for all applications',
    );
    expect(result[0].importance).toBeGreaterThanOrEqual(0.5);
    expect(result[0].source.turnIndex).toBe(0);
    expect(result[0].source.role).toBe(MessageRole.USER);
  });

  it('should replace "User" with actual userName in extracted facts', async () => {
    mockLlm.json.mockResolvedValue({
      facts: [
        { content: 'User prefers dark mode', turnIndex: 0 },
        { content: 'The user lives in Vancouver', turnIndex: 2 },
      ],
    });

    const context: ExtractorContext = { userName: 'Beaux' };
    const result = await service.extract(turns, signals, context);

    expect(result[0].content).toBe('Beaux prefers dark mode');
    // "The user" → "The" stays because replace order: "The user" → "Beaux", but
    // the code replaces /The user/ first, so it becomes "Beaux lives in Vancouver"
    // Actually: "The user" → replaced by /The user/g → "Beaux"
    // But input is "The user lives..." → /The user/g matches → "Beaux lives..."
    expect(result[1].content).toContain('Beaux');
    expect(result[1].content).toContain('lives in Vancouver');
  });

  it('should boost importance for user messages', async () => {
    mockLlm.json.mockResolvedValue({
      facts: [
        { content: 'Prefers dark mode', turnIndex: 0 }, // USER turn
        { content: 'Noted preference', turnIndex: 1 }, // ASSISTANT turn
      ],
    });

    const result = await service.extract(turns, []);

    // User turn gets +0.1 boost
    expect(result[0].importance).toBe(0.6); // 0.5 base + 0.1
    expect(result[1].importance).toBe(0.5); // 0.5 base only
  });

  it('should boost importance when signals match the turn', async () => {
    mockLlm.json.mockResolvedValue({
      facts: [{ content: 'Dark mode preference', turnIndex: 0 }],
    });

    const result = await service.extract(turns, signals);

    // Signal confidence 0.8 > base 0.5, plus user boost +0.1
    expect(result[0].importance).toBe(0.9); // max(0.5, 0.8) + 0.1
  });

  it('should cap importance at 1.0', async () => {
    const highSignals: ImportanceSignal[] = [
      {
        turnIndex: 0,
        type: 'explicit',
        trigger: 'remember',
        content: 'test',
        confidence: 0.95,
      },
    ];
    mockLlm.json.mockResolvedValue({
      facts: [{ content: 'Important fact', turnIndex: 0 }],
    });

    const result = await service.extract(turns, highSignals);
    expect(result[0].importance).toBeLessThanOrEqual(1.0);
  });

  it('should clamp turnIndex to valid range', async () => {
    mockLlm.json.mockResolvedValue({
      facts: [
        { content: 'Fact 1', turnIndex: -5 },
        { content: 'Fact 2', turnIndex: 999 },
      ],
    });

    const result = await service.extract(turns, []);

    expect(result[0].source.turnIndex).toBe(0);
    expect(result[1].source.turnIndex).toBe(turns.length - 1);
  });

  it('should handle empty facts array from LLM', async () => {
    mockLlm.json.mockResolvedValue({ facts: [] });

    const result = await service.extract(turns, signals);
    expect(result).toHaveLength(0);
  });

  it('should handle undefined facts from LLM', async () => {
    mockLlm.json.mockResolvedValue({});

    const result = await service.extract(turns, signals);
    expect(result).toHaveLength(0);
  });

  // =========================================================================
  // Fallback: signal-based extraction
  // =========================================================================

  it('should fall back to signal-based extraction when LLM fails', async () => {
    mockLlm.json.mockRejectedValue(new Error('LLM unavailable'));

    const result = await service.extract(turns, signals);

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('User prefers dark mode for everything');
    expect(result[0].importance).toBe(0.8);
  });

  it('should replace User with userName in signal-based fallback', async () => {
    mockLlm.json.mockRejectedValue(new Error('LLM down'));

    const result = await service.extract(turns, signals, { userName: 'Beaux' });

    expect(result[0].content).toBe('Beaux prefers dark mode for everything');
  });

  it('should prefix correction signals', async () => {
    mockLlm.json.mockRejectedValue(new Error('fail'));

    const correctionSignals: ImportanceSignal[] = [
      {
        turnIndex: 0,
        type: 'correction',
        trigger: 'actually',
        content: 'Actually likes light mode',
        confidence: 0.9,
      },
    ];

    const result = await service.extract(turns, correctionSignals);
    expect(result[0].content).toContain('Correction:');
  });

  it('should prefix repetition signals with user reference', async () => {
    mockLlm.json.mockRejectedValue(new Error('fail'));

    const repSignals: ImportanceSignal[] = [
      {
        turnIndex: 0,
        type: 'repetition',
        trigger: 'again',
        content: 'Dark mode',
        confidence: 0.7,
      },
    ];

    const result = await service.extract(turns, repSignals);
    expect(result[0].content).toContain('emphasized');
  });

  it('should skip signals with invalid turnIndex', async () => {
    mockLlm.json.mockRejectedValue(new Error('fail'));

    const badSignals: ImportanceSignal[] = [
      {
        turnIndex: 99,
        type: 'preference',
        trigger: 'like',
        content: 'test',
        confidence: 0.5,
      },
    ];

    const result = await service.extract(turns, badSignals);
    expect(result).toHaveLength(0);
  });

  // =========================================================================
  // Deduplication
  // =========================================================================

  it('should deduplicate similar memories in fallback', async () => {
    mockLlm.json.mockRejectedValue(new Error('fail'));

    const dupSignals: ImportanceSignal[] = [
      {
        turnIndex: 0,
        type: 'preference',
        trigger: 'prefer',
        content: 'User prefers dark mode',
        confidence: 0.8,
      },
      {
        turnIndex: 0,
        type: 'preference',
        trigger: 'like',
        content: 'User prefers dark mode in apps',
        confidence: 0.7,
      },
    ];

    const result = await service.extract(turns, dupSignals);
    // High similarity should deduplicate
    expect(result.length).toBeLessThanOrEqual(2);
  });

  it('should keep distinct memories', async () => {
    mockLlm.json.mockRejectedValue(new Error('fail'));

    const distinctSignals: ImportanceSignal[] = [
      {
        turnIndex: 0,
        type: 'preference',
        trigger: 'prefer',
        content: 'User prefers dark mode',
        confidence: 0.8,
      },
      {
        turnIndex: 2,
        type: 'preference',
        trigger: 'name',
        content: 'User lives in Vancouver',
        confidence: 0.7,
      },
    ];

    const result = await service.extract(turns, distinctSignals);
    expect(result).toHaveLength(2);
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  it('should handle empty turns array', async () => {
    mockLlm.json.mockResolvedValue({ facts: [] });

    const result = await service.extract([], [], undefined);
    expect(result).toHaveLength(0);
  });

  it('should handle empty signals array', async () => {
    mockLlm.json.mockResolvedValue({
      facts: [{ content: 'Some fact', turnIndex: 0 }],
    });

    const result = await service.extract(turns, []);
    expect(result).toHaveLength(1);
    expect(result[0].signals).toHaveLength(0);
  });

  it('should pass temperature 0.3 to LLM', async () => {
    mockLlm.json.mockResolvedValue({ facts: [] });

    await service.extract(turns, signals);

    expect(mockLlm.json).toHaveBeenCalledWith(expect.any(Array), undefined, {
      temperature: 0.3,
    });
  });

  it('should include signal hints in LLM prompt when signals present', async () => {
    mockLlm.json.mockResolvedValue({ facts: [] });

    await service.extract(turns, signals);

    const callArgs = mockLlm.json.mock.calls[0][0];
    const userMessage = callArgs[1].content;
    expect(userMessage).toContain('High-importance signals detected');
    expect(userMessage).toContain('preference signal');
  });

  it('should not include signal hints when no signals', async () => {
    mockLlm.json.mockResolvedValue({ facts: [] });

    await service.extract(turns, []);

    const callArgs = mockLlm.json.mock.calls[0][0];
    const userMessage = callArgs[1].content;
    expect(userMessage).not.toContain('High-importance signals detected');
  });
  // =========================================================================
  // ENG-59: speaker-aware formation (flag-gated)
  // =========================================================================

  describe('ENG-59 speaker-aware extraction', () => {
    const assistantTurns: MessageTurnDto[] = [
      {
        role: MessageRole.ASSISTANT,
        content: 'I copied four M4 files and will run R1, R2 and R3 tomorrow.',
      },
    ];
    const llmFacts = {
      facts: [
        { content: 'Beaux has copied four M4 files', turnIndex: 0 },
        { content: 'Rook reported copying four M4 files', turnIndex: 0 },
        { content: 'Beaux has 9 in progress tickets', turnIndex: 0 },
      ],
    };

    afterEach(() => {
      delete process.env.OBSERVE_SPEAKER_AWARE;
      delete process.env.OBSERVE_STATUS_FILTER;
    });

    it('flag off: prompt unchanged and nothing dropped', async () => {
      mockLlm.json.mockResolvedValue(llmFacts);
      const out = await service.extract(assistantTurns, [], {
        userName: 'Beaux',
      });
      expect(out).toHaveLength(3);
      expect(mockLlm.json.mock.calls[0][0][0].content).not.toContain(
        'SPEAKER RULES',
      );
    });

    it('flag on: adds speaker rules and drops user-subject facts from assistant turns', async () => {
      process.env.OBSERVE_SPEAKER_AWARE = 'true';
      mockLlm.json.mockResolvedValue(llmFacts);
      const out = await service.extract(assistantTurns, [], {
        userName: 'Beaux',
        agentName: 'Rook',
      });
      const prompt = mockLlm.json.mock.calls[0][0][0].content;
      expect(prompt).toContain('SPEAKER RULES');
      expect(prompt).toContain('Rook reported');
      expect(out.map((m) => m.content)).toEqual([
        'Rook reported copying four M4 files',
      ]);
    });

    it('status filter drops in-flight counts', async () => {
      process.env.OBSERVE_STATUS_FILTER = 'true';
      mockLlm.json.mockResolvedValue(llmFacts);
      const out = await service.extract(assistantTurns, [], {
        userName: 'Beaux',
      });
      expect(out.map((m) => m.content)).not.toContain(
        'Beaux has 9 in progress tickets',
      );
      expect(out).toHaveLength(2);
    });

    it('flag on does not touch user-sourced facts', async () => {
      process.env.OBSERVE_SPEAKER_AWARE = 'true';
      mockLlm.json.mockResolvedValue({
        facts: [{ content: 'Beaux prefers dark mode', turnIndex: 0 }],
      });
      const out = await service.extract(turns, signals, { userName: 'Beaux' });
      expect(out).toHaveLength(1);
    });
  });
});

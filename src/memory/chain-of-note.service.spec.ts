import { ChainOfNoteService } from './chain-of-note.service';
import { CHAIN_OF_NOTE_TEMPLATE } from './chain-of-note.prompt';
import type { StructuredMemoryItem } from './dto/structured-recall.dto';

const makeMemory = (id: string, fact: string): StructuredMemoryItem => ({
  id,
  fact,
  source_session: null,
  confidence: 0.9,
  timestamp: '2026-01-01T00:00:00.000Z',
  memory_type: null,
});

describe('ChainOfNoteService', () => {
  let service: ChainOfNoteService;

  beforeEach(() => {
    service = new ChainOfNoteService();
  });

  describe('buildPrompt', () => {
    it('delegates to CHAIN_OF_NOTE_TEMPLATE', () => {
      const memories = [makeMemory('m-1', 'The user prefers dark mode.')];
      const result = service.buildPrompt(
        memories,
        'What does the user prefer?',
      );
      expect(result).toBe(
        CHAIN_OF_NOTE_TEMPLATE(memories, 'What does the user prefer?'),
      );
    });

    it('returns a prompt containing the question', () => {
      const memories = [makeMemory('m-1', 'fact')];
      const prompt = service.buildPrompt(
        memories,
        'Does the user like coffee?',
      );
      expect(prompt).toContain('Does the user like coffee?');
    });

    it('returns a prompt containing memory ids', () => {
      const memories = [makeMemory('abc-123', 'some fact')];
      const prompt = service.buildPrompt(memories, 'question');
      expect(prompt).toContain('abc-123');
    });

    it('includes [MEMORY <id>] annotation instruction', () => {
      const prompt = service.buildPrompt([], 'q');
      expect(prompt).toContain('[MEMORY <id>]');
    });
  });
});

describe('CHAIN_OF_NOTE_TEMPLATE', () => {
  it('handles zero memories — still returns a valid prompt', () => {
    const prompt = CHAIN_OF_NOTE_TEMPLATE([], 'What happened?');
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain('What happened?');
    expect(prompt).toContain('Memories:');
  });

  it('handles one memory — embeds fact in JSON', () => {
    const memories = [makeMemory('m-1', 'The sky is blue.')];
    const prompt = CHAIN_OF_NOTE_TEMPLATE(memories, 'What color is the sky?');
    expect(prompt).toContain('"id": "m-1"');
    expect(prompt).toContain('"fact": "The sky is blue."');
    expect(prompt).toContain('What color is the sky?');
  });

  it('handles N memories — all are embedded', () => {
    const memories = Array.from({ length: 5 }, (_, i) =>
      makeMemory(`m-${i}`, `fact ${i}`),
    );
    const prompt = CHAIN_OF_NOTE_TEMPLATE(memories, 'q');
    for (let i = 0; i < 5; i++) {
      expect(prompt).toContain(`"id": "m-${i}"`);
    }
  });

  it('caps at 50 memories (HEY-578: recall widened to 50)', () => {
    const memories = Array.from({ length: 55 }, (_, i) =>
      makeMemory(`m-${i}`, `fact ${i}`),
    );
    const prompt = CHAIN_OF_NOTE_TEMPLATE(memories, 'q');
    // All first 50 should appear; beyond 50 should not
    expect(prompt).toContain('"id": "m-49"');
    expect(prompt).not.toContain('"id": "m-50"');
  });

  it('snapshot — prompt shape is stable', () => {
    const memories = [
      makeMemory('snap-1', 'Beaux prefers TypeScript over JavaScript.'),
    ];
    const prompt = CHAIN_OF_NOTE_TEMPLATE(
      memories,
      'What language does Beaux prefer?',
    );
    expect(prompt).toMatchSnapshot();
  });
});

import { MessageRole, MessageTurnDto } from './dto/observe.dto';
import {
  buildFormationPromptAddendum,
  guardFact,
  isStatusChatter,
} from './formation-guard';

const A = (content: string): MessageTurnDto => ({
  role: MessageRole.ASSISTANT,
  content,
});
const U = (content: string): MessageTurnDto => ({
  role: MessageRole.USER,
  content,
});

describe('formation-guard (ENG-59)', () => {
  const FLAGS = [
    'OBSERVE_SPEAKER_AWARE',
    'OBSERVE_ASSISTANT_FACTS',
    'OBSERVE_STATUS_FILTER',
  ];
  beforeEach(() => FLAGS.forEach((f) => delete process.env[f]));
  afterAll(() => FLAGS.forEach((f) => delete process.env[f]));

  describe('flags off (default)', () => {
    it('adds nothing to the prompt and keeps every fact', () => {
      expect(buildFormationPromptAddendum('Beaux', 'Rook')).toBe('');
      const turns = [A('I copied four M4 files')];
      expect(
        guardFact(
          { content: 'Beaux has copied four M4 files', turnIndices: [0] },
          turns,
          'Beaux',
        ).keep,
      ).toBe(true);
      expect(
        guardFact(
          { content: 'Beaux has 9 in progress tickets', turnIndices: [0] },
          turns,
          'Beaux',
        ).keep,
      ).toBe(true);
    });
  });

  describe('OBSERVE_SPEAKER_AWARE=true', () => {
    beforeEach(() => {
      process.env.OBSERVE_SPEAKER_AWARE = 'true';
    });

    it('prompt names the agent and the user and covers corrections/hedges', () => {
      const p = buildFormationPromptAddendum('Beaux', 'Rook');
      expect(p).toContain('Rook reported');
      expect(p).toContain('Beaux');
      expect(p).toMatch(/negate/);
      expect(p).toMatch(/hedge/i);
    });

    it('defaults the agent label when no agentName is given', () => {
      expect(buildFormationPromptAddendum('Beaux')).toContain(
        'The assistant reported',
      );
    });

    it('drops user-subject facts that come only from assistant turns', () => {
      const turns = [A('I copied four M4 files into the workspace')];
      const r = guardFact(
        { content: 'Beaux has copied four M4 files', turnIndices: [0] },
        turns,
        'Beaux',
      );
      expect(r).toEqual({ keep: false, reason: 'user_subject_from_assistant' });
    });

    it('catches possessive subjects like "Beaux\'s team ..."', () => {
      const turns = [A('The team hired two engineers')];
      expect(
        guardFact(
          { content: "Beaux's team hired two engineers", turnIndices: [0] },
          turns,
          'Beaux',
        ).keep,
      ).toBe(false);
    });

    it('keeps agent-attributed facts from assistant turns', () => {
      const turns = [A('I copied four M4 files')];
      expect(
        guardFact(
          { content: 'Rook reported copying four M4 files', turnIndices: [0] },
          turns,
          'Beaux',
        ).keep,
      ).toBe(true);
    });

    it('keeps user-subject facts sourced from a user turn', () => {
      const turns = [U('I prefer dark mode'), A('Noted')];
      expect(
        guardFact(
          { content: 'Beaux prefers dark mode', turnIndices: [0] },
          turns,
          'Beaux',
        ).keep,
      ).toBe(true);
    });

    it('keeps an assistant echo of something the user said earlier in the batch', () => {
      const turns = [
        U('I live in Vancouver'),
        A('Got it, you live in Vancouver'),
      ];
      expect(
        guardFact(
          { content: 'Beaux lives in Vancouver', turnIndices: [1] },
          turns,
          'Beaux',
        ).keep,
      ).toBe(true);
    });

    it('treats missing provenance as the whole batch', () => {
      const allAssistant = [A('one'), A('two')];
      expect(
        guardFact(
          { content: 'Beaux did X', turnIndices: [] },
          allAssistant,
          'Beaux',
        ).keep,
      ).toBe(false);
      const mixed = [U('hi'), A('two')];
      expect(
        guardFact({ content: 'Beaux did X', turnIndices: [] }, mixed, 'Beaux')
          .keep,
      ).toBe(true);
    });

    it('matches "User" subject when no userName is known', () => {
      const turns = [A('plan: run R1')];
      expect(
        guardFact({ content: 'User plans to run R1', turnIndices: [0] }, turns)
          .keep,
      ).toBe(false);
    });

    it('OBSERVE_ASSISTANT_FACTS=drop drops every assistant-only fact', () => {
      process.env.OBSERVE_ASSISTANT_FACTS = 'drop';
      const turns = [A('I copied four M4 files')];
      expect(
        guardFact(
          { content: 'Rook reported copying files', turnIndices: [0] },
          turns,
          'Beaux',
        ),
      ).toEqual({ keep: false, reason: 'assistant_only' });
    });

    it('OBSERVE_ASSISTANT_FACTS=drop is inert without SPEAKER_AWARE', () => {
      delete process.env.OBSERVE_SPEAKER_AWARE;
      process.env.OBSERVE_ASSISTANT_FACTS = 'drop';
      expect(
        guardFact(
          { content: 'Rook reported X', turnIndices: [0] },
          [A('x')],
          'Beaux',
        ).keep,
      ).toBe(true);
    });
  });

  describe('OBSERVE_STATUS_FILTER=true', () => {
    beforeEach(() => {
      process.env.OBSERVE_STATUS_FILTER = 'true';
    });

    it.each([
      "Beaux's team has closed 2 tickets and has 21 tickets in total: 4 done, 9 in progress, 5 to do, and 3 blocked.",
      'Beaux has 41 tickets in progress: 22 done, 11 in progress, 3 in review.',
      "Beaux's team has 19 PRs currently blocked in WhaleHawk Paperclip.",
      'Beaux is currently working on the M7 proposal.',
      'The migration is running right now on staging.',
    ])('flags status chatter: %s', (c) => {
      expect(isStatusChatter(c)).toBe(true);
    });

    it.each([
      'Beaux prefers dark mode for all applications',
      'Beaux lives in Vancouver and works at Acme Corp',
      'Beaux decided to use pgvector instead of Pinecone because of cost',
      'The team has 3 engineers',
      "Beaux's wife is named Jess",
    ])('keeps durable fact: %s', (c) => {
      expect(isStatusChatter(c)).toBe(false);
    });

    it('guardFact drops status chatter even without speaker-aware', () => {
      expect(
        guardFact(
          { content: 'Beaux has 9 in progress tickets', turnIndices: [0] },
          [U('x')],
          'Beaux',
        ),
      ).toEqual({ keep: false, reason: 'status_chatter' });
    });

    it('adds the status rule to the prompt', () => {
      expect(buildFormationPromptAddendum('Beaux')).toContain('STATUS CHATTER');
    });
  });
});

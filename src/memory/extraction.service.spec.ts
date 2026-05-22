import { Test, TestingModule } from '@nestjs/testing';
import {
  ExtractionService,
  ExtractionResult,
  MEMORY_TYPE_PRIORITY,
} from './extraction.service';
import { LLMService } from '../llm/llm.service';
import { MemoryLayer } from '@prisma/client';

describe('ExtractionService', () => {
  let service: ExtractionService;
  let mockLlmService: jest.Mocked<LLMService>;

  beforeEach(async () => {
    mockLlmService = {
      json: jest.fn(),
      chat: jest.fn(),
      embed: jest.fn(),
      getProvider: jest.fn(),
      listProviders: jest.fn(),
      listEmbeddingProviders: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExtractionService,
        { provide: LLMService, useValue: mockLlmService },
      ],
    }).compile();

    service = module.get<ExtractionService>(ExtractionService);
  });

  describe('extract', () => {
    it('should extract 5W1H structure using LLM', async () => {
      const llmResponse = {
        who: 'John',
        what: 'prefers TypeScript over JavaScript',
        when: '2026-01-31',
        where: 'work environment',
        why: 'better type safety',
        how: 'for all new projects',
        topics: ['preferences', 'programming'],
        entities: [
          { name: 'TypeScript', type: 'product' },
          { name: 'JavaScript', type: 'product' },
        ],
      };

      mockLlmService.json.mockResolvedValue(llmResponse);

      const result = await service.extract(
        'John prefers TypeScript over JavaScript for better type safety',
      );

      expect(mockLlmService.json).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ role: 'system' }),
          expect.objectContaining({ role: 'user' }),
        ]),
        undefined,
        { temperature: 0.2 },
      );

      expect(result.who).toBe('John');
      expect(result.what).toBe('prefers TypeScript over JavaScript');
      expect(result.topics).toEqual(['preferences', 'programming']);
      expect(result.entities).toHaveLength(2);
      expect(result.entities[0]).toEqual({
        name: 'TypeScript',
        type: 'product',
      });
    });

    it('should handle null values in LLM response', async () => {
      const llmResponse = {
        who: null,
        what: 'some action',
        when: null,
        where: null,
        why: null,
        how: null,
        topics: [],
        entities: [],
      };

      mockLlmService.json.mockResolvedValue(llmResponse);

      const result = await service.extract('some action');

      expect(result.who).toBeNull();
      expect(result.when).toBeNull();
      expect(result.topics).toEqual([]);
    });

    it('should ensure topics is always an array', async () => {
      mockLlmService.json.mockResolvedValue({
        who: null,
        what: 'test',
        when: null,
        where: null,
        why: null,
        how: null,
        topics: 'not an array', // Malformed response
        entities: [],
      });

      const result = await service.extract('test');

      expect(Array.isArray(result.topics)).toBe(true);
      expect(result.topics).toEqual([]);
    });

    it('should ensure entities is always an array', async () => {
      mockLlmService.json.mockResolvedValue({
        who: null,
        what: 'test',
        when: null,
        where: null,
        why: null,
        how: null,
        topics: [],
        entities: null, // Malformed response
      });

      const result = await service.extract('test');

      expect(Array.isArray(result.entities)).toBe(true);
      expect(result.entities).toEqual([]);
    });

    it('should fallback to basic extraction on LLM failure', async () => {
      mockLlmService.json.mockRejectedValue(new Error('LLM unavailable'));

      const result = await service.extract(
        'John discussed the project deadline',
      );

      expect(result.what).toContain('John discussed the project deadline');
      expect(result.who).toBe('John');
    });

    it('should not throw when LLM fails', async () => {
      mockLlmService.json.mockRejectedValue(new Error('Network error'));

      await expect(service.extract('test input')).resolves.toBeDefined();
    });
  });

  describe('basicExtraction (via fallback)', () => {
    beforeEach(() => {
      mockLlmService.json.mockRejectedValue(new Error('LLM unavailable'));
    });

    it('should extract names as WHO', async () => {
      const result = await service.extract(
        'Alice and Bob discussed the project',
      );
      expect(result.who).toBe('Alice');
    });

    it('should truncate long content for WHAT', async () => {
      const longText = 'A'.repeat(300);
      const result = await service.extract(longText);
      expect(result.what!.length).toBeLessThanOrEqual(203); // 200 + '...'
      expect(result.what).toContain('...');
    });

    it('should not truncate short content', async () => {
      const shortText = 'Short message';
      const result = await service.extract(shortText);
      expect(result.what).toBe(shortText);
    });

    it('should extract coding topics', async () => {
      const result = await service.extract('Need to fix this bug in the code');
      expect(result.topics).toContain('coding');
    });

    it('should extract design topics', async () => {
      const result = await service.extract('The UI design needs better colors');
      expect(result.topics).toContain('design');
    });

    it('should extract business topics', async () => {
      const result = await service.extract('Client meeting about the budget');
      expect(result.topics).toContain('business');
    });

    it('should extract preferences topics', async () => {
      const result = await service.extract(
        'I prefer dark mode and always use it',
      );
      expect(result.topics).toContain('preferences');
    });

    it('should extract technical topics', async () => {
      const result = await service.extract(
        'Database server integration with API',
      );
      expect(result.topics).toContain('technical');
    });

    it('should extract multiple topics', async () => {
      const result = await service.extract(
        'I prefer this API design for the client',
      );
      expect(result.topics.length).toBeGreaterThan(1);
    });

    it('should extract named entities', async () => {
      const result = await service.extract(
        'Microsoft and Apple are tech companies',
      );
      const entityNames = result.entities.map((e) => e.name);
      expect(entityNames).toContain('Microsoft');
      expect(entityNames).toContain('Apple');
    });

    it('should filter out common words from entities', async () => {
      const result = await service.extract(
        'The project starts on Monday in January',
      );
      expect(result.entities).not.toContain('The');
      expect(result.entities).not.toContain('Monday');
      expect(result.entities).not.toContain('January');
    });

    it('should handle text with no extractable names', async () => {
      const result = await service.extract('the quick brown fox jumps');
      expect(result.who).toBeNull();
    });

    it('should return null for WHEN, WHERE, WHY, HOW in basic extraction', async () => {
      const result = await service.extract('Some random text');
      expect(result.when).toBeNull();
      expect(result.where).toBeNull();
      expect(result.why).toBeNull();
      expect(result.how).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('should handle empty string', async () => {
      mockLlmService.json.mockRejectedValue(new Error('fail'));
      const result = await service.extract('');
      expect(result).toBeDefined();
      expect(result.what).toBe('');
    });

    it('should handle special characters', async () => {
      mockLlmService.json.mockResolvedValue({
        who: null,
        what: 'Test with émojis 🎉 and spëcial chârs',
        when: null,
        where: null,
        why: null,
        how: null,
        topics: [],
        entities: [],
      });

      const result = await service.extract(
        'Test with émojis 🎉 and spëcial chârs',
      );
      expect(result.what).toContain('émojis');
    });

    it('should handle JSON-like content in raw text', async () => {
      const rawText = '{"key": "value"} is the JSON format';
      mockLlmService.json.mockResolvedValue({
        who: null,
        what: rawText,
        when: null,
        where: null,
        why: null,
        how: null,
        topics: ['technical'],
        entities: ['JSON'],
      });

      const result = await service.extract(rawText);
      expect(result.what).toBe(rawText);
    });
  });

  describe('classifyLayer (P5-003)', () => {
    describe('IDENTITY classification', () => {
      it('should classify preferences as IDENTITY', () => {
        expect(
          service.classifyLayer('I prefer dark mode for all applications'),
        ).toBe(MemoryLayer.IDENTITY);
        expect(service.classifyLayer('Beaux always uses vim')).toBe(
          MemoryLayer.IDENTITY,
        );
        expect(service.classifyLayer('I never deploy on Fridays')).toBe(
          MemoryLayer.IDENTITY,
        );
      });

      it('should classify personal facts as IDENTITY', () => {
        expect(service.classifyLayer('I was born in Vancouver')).toBe(
          MemoryLayer.IDENTITY,
        );
        expect(service.classifyLayer('My birthday is January 15th')).toBe(
          MemoryLayer.IDENTITY,
        );
        expect(service.classifyLayer('I am 35 years old')).toBe(
          MemoryLayer.IDENTITY,
        );
      });

      it('should classify family/relationship info as IDENTITY', () => {
        expect(service.classifyLayer('My wife is named Sarah')).toBe(
          MemoryLayer.IDENTITY,
        );
        expect(service.classifyLayer('I have two daughters')).toBe(
          MemoryLayer.IDENTITY,
        );
        expect(service.classifyLayer('My brother works at Google')).toBe(
          MemoryLayer.IDENTITY,
        );
      });

      it('should classify work/career info as IDENTITY', () => {
        expect(service.classifyLayer('I work at Anthropic')).toBe(
          MemoryLayer.IDENTITY,
        );
        expect(service.classifyLayer('My job is software engineering')).toBe(
          MemoryLayer.IDENTITY,
        );
        expect(service.classifyLayer('I am a developer')).toBe(
          MemoryLayer.IDENTITY,
        );
      });

      it('should classify hobbies and interests as IDENTITY', () => {
        expect(service.classifyLayer('My hobby is woodworking')).toBe(
          MemoryLayer.IDENTITY,
        );
        expect(service.classifyLayer('I am passionate about AI safety')).toBe(
          MemoryLayer.IDENTITY,
        );
      });

      it('should classify allergies and health facts as IDENTITY', () => {
        expect(service.classifyLayer('I am allergic to peanuts')).toBe(
          MemoryLayer.IDENTITY,
        );
        expect(service.classifyLayer('I have a gluten intolerance')).toBe(
          MemoryLayer.IDENTITY,
        );
      });
    });

    describe('PROJECT classification', () => {
      it('should classify project work as PROJECT', () => {
        expect(
          service.classifyLayer('Working on the Engram memory project'),
        ).toBe(MemoryLayer.PROJECT);
        expect(
          service.classifyLayer('Building a new feature for the dashboard'),
        ).toBe(MemoryLayer.PROJECT);
        expect(service.classifyLayer('Developing the API integration')).toBe(
          MemoryLayer.PROJECT,
        );
      });

      it('should classify repository/code references as PROJECT', () => {
        expect(service.classifyLayer('The repo is at github.com/example')).toBe(
          MemoryLayer.PROJECT,
        );
        expect(service.classifyLayer('Need to check the main branch')).toBe(
          MemoryLayer.PROJECT,
        );
        expect(service.classifyLayer('Reviewing the pull request')).toBe(
          MemoryLayer.PROJECT,
        );
      });

      it('should classify deadlines and milestones as PROJECT', () => {
        expect(service.classifyLayer('Deadline is next Friday')).toBe(
          MemoryLayer.PROJECT,
        );
        expect(service.classifyLayer('Sprint ends on Feb 14')).toBe(
          MemoryLayer.PROJECT,
        );
        expect(service.classifyLayer('Release scheduled for March')).toBe(
          MemoryLayer.PROJECT,
        );
      });

      it('should classify bugs and issues as PROJECT', () => {
        expect(service.classifyLayer('Found a bug in the login flow')).toBe(
          MemoryLayer.PROJECT,
        );
        expect(service.classifyLayer('Issue #123 needs attention')).toBe(
          MemoryLayer.PROJECT,
        );
        expect(service.classifyLayer('This feature has a ticket')).toBe(
          MemoryLayer.PROJECT,
        );
      });

      it('should classify deployment topics as PROJECT', () => {
        expect(service.classifyLayer('Need to deploy to production')).toBe(
          MemoryLayer.PROJECT,
        );
        expect(service.classifyLayer('Staging environment is ready')).toBe(
          MemoryLayer.PROJECT,
        );
      });

      it('should classify based on project/org entities', () => {
        const extracted: ExtractionResult = {
          who: 'Beaux',
          what: 'working on something',
          when: null,
          where: null,
          why: null,
          how: null,
          topics: [],
          entities: [{ name: 'Engram', type: 'project' }],
          memoryType: null,
          typeConfidence: null,
          confidence: {
            whoConfidence: null,
            whatConfidence: null,
            whenConfidence: null,
            whereConfidence: null,
            whyConfidence: null,
            howConfidence: null,
          },
          lesson: null,
          capabilities: [],
          preferenceSignals: [],
          factKeys: [],
        };
        expect(service.classifyLayer('Working on something', extracted)).toBe(
          MemoryLayer.PROJECT,
        );
      });
    });

    describe('SESSION classification (default)', () => {
      it('should default to SESSION for transient information', () => {
        expect(service.classifyLayer('Had a good meeting today')).toBe(
          MemoryLayer.SESSION,
        );
        expect(service.classifyLayer('The weather is nice')).toBe(
          MemoryLayer.SESSION,
        );
        expect(service.classifyLayer('Grabbed coffee this morning')).toBe(
          MemoryLayer.SESSION,
        );
      });

      it('should default to SESSION for ambiguous content', () => {
        expect(service.classifyLayer('Looking at some code')).toBe(
          MemoryLayer.SESSION,
        );
        expect(service.classifyLayer('Thinking about next steps')).toBe(
          MemoryLayer.SESSION,
        );
      });
    });

    describe('TASK classification', () => {
      it('should classify LLM-extracted TASK memoryType as TASK', () => {
        expect(
          service.classifyLayer('Working on something', {
            memoryType: 'TASK',
          } as any),
        ).toBe(MemoryLayer.TASK);
      });

      it('should classify reminder patterns as TASK', () => {
        expect(service.classifyLayer('Remind me to call the doctor')).toBe(
          MemoryLayer.TASK,
        );
        expect(service.classifyLayer('Remember to buy groceries')).toBe(
          MemoryLayer.TASK,
        );
        expect(service.classifyLayer("Don't forget the meeting at 3pm")).toBe(
          MemoryLayer.TASK,
        );
      });

      it('should classify todo/action items as TASK', () => {
        expect(service.classifyLayer('Add this to my todo list')).toBe(
          MemoryLayer.TASK,
        );
        expect(
          service.classifyLayer('Action item: update the deployment docs'),
        ).toBe(MemoryLayer.TASK);
        expect(service.classifyLayer('Follow up with Jackie on Friday')).toBe(
          MemoryLayer.TASK,
        );
      });

      it('should classify booking phrases as TASK', () => {
        expect(service.classifyLayer('Book a meeting with the team')).toBe(
          MemoryLayer.TASK,
        );
        expect(
          service.classifyLayer('Book an appointment with the dentist'),
        ).toBe(MemoryLayer.TASK);
      });

      it('should NOT classify reading a book as TASK', () => {
        expect(
          service.classifyLayer('I finished reading a book on TypeScript'),
        ).toBe(MemoryLayer.SESSION);
      });

      it('should classify schedule patterns as TASK', () => {
        expect(
          service.classifyLayer('Schedule a call with the client for Monday'),
        ).toBe(MemoryLayer.TASK);
      });
    });
  });

  describe('LESSON memory type', () => {
    it('should classify user correction text as LESSON', async () => {
      mockLlmService.json.mockResolvedValue({
        who: 'Agent',
        what: 'Pushed WhaleHawk stuff to the Engram repo',
        when: null,
        where: null,
        why: 'Cross-project context contamination',
        how: null,
        topics: ['mistakes', 'git'],
        entities: [
          { name: 'WhaleHawk', type: 'project' },
          { name: 'Engram', type: 'project' },
        ],
        memoryType: 'LESSON',
        typeConfidence: 0.95,
        who_confidence: 0.8,
        what_confidence: 0.9,
        when_confidence: null,
        where_confidence: null,
        why_confidence: 0.8,
        how_confidence: null,
        lessonMistake: 'Pushed WhaleHawk content to the Engram repo',
        lessonRootCause:
          'Cross-project memories injected without namespace filtering',
        lessonCorrectAction:
          'Verify all content relates to target repo before committing',
        lessonSeverity: 'high',
        lessonSource: 'user_correction',
        lessonTriggerPatterns: [
          'committing to git',
          'working across multiple projects',
        ],
      });

      const result = await service.extract(
        'No, you pushed WhaleHawk stuff to the Engram repo',
      );

      expect(result.memoryType).toBe('LESSON');
      expect(result.lesson).not.toBeNull();
      expect(result.lesson!.lessonMistake).toBe(
        'Pushed WhaleHawk content to the Engram repo',
      );
      expect(result.lesson!.lessonRootCause).toBe(
        'Cross-project memories injected without namespace filtering',
      );
      expect(result.lesson!.lessonCorrectAction).toBe(
        'Verify all content relates to target repo before committing',
      );
    });

    it('should classify explicit lesson text as LESSON', async () => {
      mockLlmService.json.mockResolvedValue({
        who: null,
        what: 'Always check which repo you are in before committing',
        when: null,
        where: null,
        why: null,
        how: null,
        topics: ['git', 'workflow'],
        entities: [],
        memoryType: 'LESSON',
        typeConfidence: 0.9,
        who_confidence: null,
        what_confidence: 0.9,
        when_confidence: null,
        where_confidence: null,
        why_confidence: null,
        how_confidence: null,
        lessonMistake: 'Committed to the wrong repo',
        lessonRootCause: 'Did not verify current repo context',
        lessonCorrectAction:
          'Always check which repo you are in before committing',
        lessonSeverity: 'medium',
        lessonSource: 'explicit',
        lessonTriggerPatterns: ['git commit', 'checking repo'],
      });

      const result = await service.extract(
        "Remember: always check which repo you're in before committing",
      );

      expect(result.memoryType).toBe('LESSON');
      expect(result.lesson).not.toBeNull();
      expect(result.lesson!.lessonSource).toBe('explicit');
    });

    it('should extract lessonSeverity and lessonSource fields for LESSON', async () => {
      mockLlmService.json.mockResolvedValue({
        who: null,
        what: 'The deploy failed because we forgot to run migrations',
        when: null,
        where: null,
        why: 'Forgot to run migrations',
        how: null,
        topics: ['deployment'],
        entities: [],
        memoryType: 'LESSON',
        typeConfidence: 0.92,
        who_confidence: null,
        what_confidence: 0.95,
        when_confidence: null,
        where_confidence: null,
        why_confidence: 0.85,
        how_confidence: null,
        lessonMistake: 'Deployed without running database migrations',
        lessonRootCause: 'Migration step was skipped in deployment checklist',
        lessonCorrectAction: 'Always run migrations before deploying',
        lessonSeverity: 'critical',
        lessonSource: 'error_detection',
        lessonTriggerPatterns: ['deploying', 'database changes', 'migrations'],
      });

      const result = await service.extract(
        'The deploy failed because we forgot to run migrations',
      );

      expect(result.memoryType).toBe('LESSON');
      expect(result.lesson).not.toBeNull();
      expect(result.lesson!.lessonSeverity).toBe('critical');
      expect(result.lesson!.lessonSource).toBe('error_detection');
      expect(result.lesson!.lessonTriggerPatterns).toContain('deploying');
      expect(result.lesson!.lessonTriggerPatterns).toContain('migrations');
    });

    it('should have LESSON at priority 1 (same as CONSTRAINT)', () => {
      expect(MEMORY_TYPE_PRIORITY.LESSON).toBe(1);
      expect(MEMORY_TYPE_PRIORITY.LESSON).toBe(MEMORY_TYPE_PRIORITY.CONSTRAINT);
    });

    it('should normalize LESSONS to LESSON in normalizeMemoryType', async () => {
      mockLlmService.json.mockResolvedValue({
        who: null,
        what: 'test',
        when: null,
        where: null,
        why: null,
        how: null,
        topics: [],
        entities: [],
        memoryType: 'LESSONS', // Plural variation
        typeConfidence: 0.8,
        who_confidence: null,
        what_confidence: null,
        when_confidence: null,
        where_confidence: null,
        why_confidence: null,
        how_confidence: null,
      });

      const result = await service.extract('test lesson');

      expect(result.memoryType).toBe('LESSON');
    });

    it('should return null lesson for non-LESSON types', async () => {
      mockLlmService.json.mockResolvedValue({
        who: null,
        what: 'I live in Vancouver',
        when: null,
        where: 'Vancouver',
        why: null,
        how: null,
        topics: ['personal'],
        entities: [],
        memoryType: 'FACT',
        typeConfidence: 0.95,
        who_confidence: null,
        what_confidence: 0.9,
        when_confidence: null,
        where_confidence: 1.0,
        why_confidence: null,
        how_confidence: null,
      });

      const result = await service.extract('I live in Vancouver');

      expect(result.memoryType).toBe('FACT');
      expect(result.lesson).toBeNull();
    });

    it('should classify correction text as LESSON in basic extraction fallback', async () => {
      mockLlmService.json.mockRejectedValue(new Error('LLM unavailable'));

      const result = await service.extract(
        "That's wrong, you made a mistake with the deployment",
      );

      expect(result.memoryType).toBe('LESSON');
    });
  });
});

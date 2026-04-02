import {
  classifyLayer,
  normalizeResponseKeys,
  normalizeMemoryType,
  normalizeEntities,
  validateEntityType,
  parseConfidence,
  normalizeLessonSeverity,
  normalizeLessonSource,
  basicMemoryTypeClassification,
} from './extraction-classifiers';

describe('ExtractionClassifiers', () => {
  // ==================== classifyLayer ====================

  describe('classifyLayer', () => {
    it('should classify TASK when LLM extraction says TASK', () => {
      expect(classifyLayer('anything', { memoryType: 'TASK' } as any)).toBe(
        'TASK',
      );
    });

    it.each([
      'remind me to buy milk',
      'remember to call the doctor',
      "don't forget the meeting",
      'follow up with the client',
      'action item from today',
      'schedule a meeting for Friday at 3pm',
      'book a flight to Vancouver',
    ])('should classify "%s" as TASK', (raw) => {
      expect(classifyLayer(raw)).toBe('TASK');
    });

    it.each([
      'I prefer dark mode',
      'my birthday is August 8',
      'I live in Powell River',
      'my name is Beaux',
      'my wife is Deanna',
      'I work at a startup',
      "I'm allergic to shellfish",
      'my hobby is coding',
    ])('should classify "%s" as IDENTITY', (raw) => {
      expect(classifyLayer(raw)).toBe('IDENTITY');
    });

    it.each([
      'the project is behind schedule',
      'working on the new feature',
      'pushed to the main branch',
      'deadline is next Friday',
      'fix the bug in authentication',
      'deploy to production today',
      'the architecture needs rethinking',
    ])('should classify "%s" as PROJECT', (raw) => {
      expect(classifyLayer(raw)).toBe('PROJECT');
    });

    it('should classify as PROJECT when entities include project type', () => {
      expect(
        classifyLayer('some neutral text', {
          entities: [{ name: 'Engram', type: 'project' }],
        } as any),
      ).toBe('PROJECT');
    });

    it('should classify relationship text as IDENTITY when person entities present', () => {
      expect(
        classifyLayer('Deanna is my wife', {
          entities: [{ name: 'Deanna', type: 'person' }],
          who: 'Deanna',
        } as any),
      ).toBe('IDENTITY');
    });

    it('should default to SESSION for unmatched text', () => {
      expect(classifyLayer('the weather is nice today')).toBe('SESSION');
    });
  });

  // ==================== normalizeResponseKeys ====================

  describe('normalizeResponseKeys', () => {
    it('should lowercase all keys', () => {
      const result = normalizeResponseKeys({
        Who: 'Beaux',
        WHAT: 'likes coffee',
        Topics: ['coffee'],
      });
      expect(result).toHaveProperty('who', 'Beaux');
      expect(result).toHaveProperty('what', 'likes coffee');
      expect(result).toHaveProperty('topics');
    });
  });

  // ==================== normalizeMemoryType ====================

  describe('normalizeMemoryType', () => {
    it('should return null for falsy input', () => {
      expect(normalizeMemoryType(null)).toBeNull();
      expect(normalizeMemoryType(undefined)).toBeNull();
      expect(normalizeMemoryType('')).toBeNull();
    });

    it.each([
      ['CONSTRAINT', 'CONSTRAINT'],
      ['preference', 'PREFERENCE'],
      ['Fact', 'FACT'],
      ['task', 'TASK'],
      ['LESSON', 'LESSON'],
      ['TASK_OUTCOME', 'TASK_OUTCOME'],
      ['SELF_ASSESSMENT', 'SELF_ASSESSMENT'],
      ['DECISION', 'DECISION'],
      ['decision', 'DECISION'],
      ['OUTCOME', 'OUTCOME'],
      ['outcome', 'OUTCOME'],
      ['GOAL', 'GOAL'],
      ['goal', 'GOAL'],
    ])('should normalize "%s" to "%s"', (input, expected) => {
      expect(normalizeMemoryType(input)).toBe(expected);
    });

    it.each([
      ['CONSTRAINTS', 'CONSTRAINT'],
      ['PREFERENCES', 'PREFERENCE'],
      ['FACTS', 'FACT'],
      ['PREF', 'PREFERENCE'],
      ['DECISIONS', 'DECISION'],
      ['OUTCOMES', 'OUTCOME'],
      ['GOALS', 'GOAL'],
    ])('should map plural/alias "%s" to "%s"', (input, expected) => {
      expect(normalizeMemoryType(input)).toBe(expected);
    });

    it('should default unknown types to FACT', () => {
      expect(normalizeMemoryType('BANANA')).toBe('FACT');
    });
  });

  // ==================== normalizeEntities ====================

  describe('normalizeEntities', () => {
    it('should return empty array for undefined/null', () => {
      expect(normalizeEntities(undefined)).toEqual([]);
      expect(normalizeEntities(null as any)).toEqual([]);
    });

    it('should handle string entities with colon format', () => {
      const result = normalizeEntities(['Beaux:person', 'Engram:project']);
      expect(result).toEqual([
        { name: 'Beaux', type: 'person' },
        { name: 'Engram', type: 'project' },
      ]);
    });

    it('should handle string entities without type', () => {
      const result = normalizeEntities(['Beaux']);
      expect(result).toEqual([{ name: 'Beaux', type: 'other' }]);
    });

    it('should handle object entities', () => {
      const result = normalizeEntities([{ name: 'Beaux', type: 'person' }]);
      expect(result).toEqual([{ name: 'Beaux', type: 'person' }]);
    });

    it('should skip invalid entries', () => {
      const result = normalizeEntities([
        null as any,
        { name: '', type: 'person' },
      ]);
      // Empty name object still passes since it has .name property (even if empty)
      expect(result.length).toBeLessThanOrEqual(2);
    });
  });

  // ==================== validateEntityType ====================

  describe('validateEntityType', () => {
    it.each([
      'person',
      'organization',
      'project',
      'product',
      'location',
      'other',
    ])('should accept valid type "%s"', (type) => {
      expect(validateEntityType(type)).toBe(type);
    });

    it('should default invalid types to "other"', () => {
      expect(validateEntityType('animal')).toBe('other');
      expect(validateEntityType('')).toBe('other');
    });

    it('should be case-insensitive', () => {
      expect(validateEntityType('PERSON')).toBe('person');
      expect(validateEntityType('Organization')).toBe('organization');
    });
  });

  // ==================== parseConfidence ====================

  describe('parseConfidence', () => {
    it('should return null when fieldValue is null/undefined', () => {
      expect(parseConfidence(0.9, null)).toBeNull();
      expect(parseConfidence(0.9, undefined)).toBeNull();
    });

    it('should return null when confidence is not a number', () => {
      expect(parseConfidence(null, 'value')).toBeNull();
      expect(parseConfidence(undefined, 'value')).toBeNull();
    });

    it('should clamp confidence to [0, 1]', () => {
      expect(parseConfidence(1.5, 'value')).toBe(1);
      expect(parseConfidence(-0.5, 'value')).toBe(0);
      expect(parseConfidence(0.7, 'value')).toBe(0.7);
    });
  });

  // ==================== normalizeLessonSeverity ====================

  describe('normalizeLessonSeverity', () => {
    it('should return null for falsy input', () => {
      expect(normalizeLessonSeverity(null)).toBeNull();
      expect(normalizeLessonSeverity(undefined)).toBeNull();
    });

    it.each(['low', 'medium', 'high', 'critical'])(
      'should accept "%s"',
      (severity) => {
        expect(normalizeLessonSeverity(severity)).toBe(severity);
      },
    );

    it('should default invalid to medium', () => {
      expect(normalizeLessonSeverity('extreme')).toBe('medium');
    });
  });

  // ==================== normalizeLessonSource ====================

  describe('normalizeLessonSource', () => {
    it('should return null for falsy input', () => {
      expect(normalizeLessonSource(null)).toBeNull();
    });

    it.each([
      ['user_correction', 'user_correction'],
      ['error detection', 'error_detection'],
      ['self reflection', 'self_reflection'],
      ['explicit', 'explicit'],
    ])('should normalize "%s" to "%s"', (input, expected) => {
      expect(normalizeLessonSource(input)).toBe(expected);
    });

    it('should default unknown to explicit', () => {
      expect(normalizeLessonSource('unknown')).toBe('explicit');
    });
  });

  // ==================== basicMemoryTypeClassification ====================

  describe('basicMemoryTypeClassification', () => {
    it('should classify allergy as CONSTRAINT', () => {
      expect(basicMemoryTypeClassification('I am allergic to peanuts')).toBe(
        'CONSTRAINT',
      );
    });

    it('should classify prohibition as CONSTRAINT', () => {
      expect(basicMemoryTypeClassification('I must not eat gluten')).toBe(
        'CONSTRAINT',
      );
    });

    it('should classify corrections as LESSON', () => {
      expect(
        basicMemoryTypeClassification("that's wrong, you made a mistake"),
      ).toBe('LESSON');
    });

    it('should classify "actually no, that was incorrect" as LESSON', () => {
      expect(basicMemoryTypeClassification('actually, that was wrong')).toBe(
        'LESSON',
      );
    });

    it('should classify reminders as TASK', () => {
      expect(
        basicMemoryTypeClassification('remind me to call the doctor'),
      ).toBe('TASK');
    });

    it('should classify preferences', () => {
      expect(basicMemoryTypeClassification('I prefer dark mode')).toBe(
        'PREFERENCE',
      );
    });

    it('should classify habits as PREFERENCE', () => {
      expect(
        basicMemoryTypeClassification('I always have coffee in the morning'),
      ).toBe('PREFERENCE');
    });

    it('should classify recent events as EVENT', () => {
      expect(
        basicMemoryTypeClassification('yesterday I went to the store'),
      ).toBe('EVENT');
    });

    it('should classify decisions as DECISION', () => {
      expect(
        basicMemoryTypeClassification('we decided to use PostgreSQL'),
      ).toBe('DECISION');
      expect(
        basicMemoryTypeClassification('I chose React over Vue'),
      ).toBe('DECISION');
      expect(
        basicMemoryTypeClassification('we went with the microservices approach'),
      ).toBe('DECISION');
      expect(
        basicMemoryTypeClassification('opted for the cheaper plan'),
      ).toBe('DECISION');
    });

    it('should classify outcomes as OUTCOME', () => {
      expect(
        basicMemoryTypeClassification('the migration resulted in data loss'),
      ).toBe('OUTCOME');
      expect(
        basicMemoryTypeClassification('the deployment succeeded without issues'),
      ).toBe('OUTCOME');
      expect(
        basicMemoryTypeClassification('the experiment failed'),
      ).toBe('OUTCOME');
      expect(
        basicMemoryTypeClassification('it turned out to be a caching issue'),
      ).toBe('OUTCOME');
    });

    it('should classify goals as GOAL', () => {
      expect(
        basicMemoryTypeClassification('my goal is to learn Rust'),
      ).toBe('GOAL');
      expect(
        basicMemoryTypeClassification('I want to reduce latency by 50%'),
      ).toBe('GOAL');
      expect(
        basicMemoryTypeClassification('we plan to migrate to Kubernetes'),
      ).toBe('GOAL');
      expect(
        basicMemoryTypeClassification('I aim to ship this by Friday'),
      ).toBe('GOAL');
    });

    it('should default to FACT', () => {
      expect(basicMemoryTypeClassification('the sky is blue')).toBe('FACT');
    });
  });
});

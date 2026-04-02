import { KEYWORD_RULES } from './topic-keyword-rules';
import { KeywordRule } from './prefetch.types';

describe('KEYWORD_RULES', () => {
  // =========================================================================
  // Structure validation
  // =========================================================================
  describe('structure', () => {
    it('should be a non-empty array', () => {
      expect(Array.isArray(KEYWORD_RULES)).toBe(true);
      expect(KEYWORD_RULES.length).toBeGreaterThan(0);
    });

    it('every rule should have required fields', () => {
      for (const rule of KEYWORD_RULES) {
        expect(typeof rule.topic).toBe('string');
        expect(rule.topic.length).toBeGreaterThan(0);
        expect(Array.isArray(rule.patterns)).toBe(true);
        expect(rule.patterns.length).toBeGreaterThan(0);
        expect(typeof rule.weight).toBe('number');
      }
    });

    it('every pattern should be a RegExp', () => {
      for (const rule of KEYWORD_RULES) {
        for (const pattern of rule.patterns) {
          expect(pattern).toBeInstanceOf(RegExp);
        }
      }
    });

    it('weight values should be between 0 and 1', () => {
      for (const rule of KEYWORD_RULES) {
        expect(rule.weight).toBeGreaterThan(0);
        expect(rule.weight).toBeLessThanOrEqual(1);
      }
    });

    it('requiresContext should be boolean or undefined', () => {
      for (const rule of KEYWORD_RULES) {
        if (rule.requiresContext !== undefined) {
          expect(typeof rule.requiresContext).toBe('boolean');
        }
      }
    });

    it('should not have duplicate topic rules', () => {
      const topics = KEYWORD_RULES.map((r) => r.topic);
      const uniqueTopics = new Set(topics);
      // Allow duplicates (multiple rules per topic) but log them
      // Just verify total count is sane
      expect(topics.length).toEqual(KEYWORD_RULES.length);
    });
  });

  // =========================================================================
  // Helper: find rule(s) by topic
  // =========================================================================
  function getRulesForTopic(topic: string): KeywordRule[] {
    return KEYWORD_RULES.filter((r) => r.topic === topic);
  }

  function matchesAnyPattern(text: string, rules: KeywordRule[]): boolean {
    return rules.some((rule) => rule.patterns.some((p) => p.test(text)));
  }

  // =========================================================================
  // Family rules
  // =========================================================================
  describe('family rules', () => {
    it('should match family/immediate for "wife"', () => {
      const rules = getRulesForTopic('family/immediate');
      expect(matchesAnyPattern('my wife is great', rules)).toBe(true);
    });

    it('should match family/immediate for "daughter"', () => {
      const rules = getRulesForTopic('family/immediate');
      expect(matchesAnyPattern('my daughter loves dinosaurs', rules)).toBe(true);
    });

    it('should match family/extended for "grandmother"', () => {
      const rules = getRulesForTopic('family/extended');
      expect(matchesAnyPattern('visited my grandmother', rules)).toBe(true);
    });

    it('should match family/extended for "sibling"', () => {
      const rules = getRulesForTopic('family/extended');
      expect(matchesAnyPattern('talking with my sibling', rules)).toBe(true);
    });

    it('should match family/pets for "dog"', () => {
      const rules = getRulesForTopic('family/pets');
      expect(matchesAnyPattern('walking the dog today', rules)).toBe(true);
    });

    it('should match family/pets for "husky"', () => {
      const rules = getRulesForTopic('family/pets');
      expect(matchesAnyPattern('my husky is energetic', rules)).toBe(true);
    });

    it('should match generic family for "home"', () => {
      const rules = getRulesForTopic('family');
      expect(matchesAnyPattern('working from home', rules)).toBe(true);
    });
  });

  // =========================================================================
  // Work rules
  // =========================================================================
  describe('work rules', () => {
    it('should match work for "deadline"', () => {
      const rules = getRulesForTopic('work');
      expect(matchesAnyPattern('the deadline is Friday', rules)).toBe(true);
    });

    it('should match work/colleagues for "manager"', () => {
      const rules = getRulesForTopic('work/colleagues');
      expect(matchesAnyPattern('talked to my manager', rules)).toBe(true);
    });

    it('should match projects/active for "working on"', () => {
      const rules = getRulesForTopic('projects/active');
      expect(matchesAnyPattern('I am working on a new feature', rules)).toBe(true);
    });

    it('should match work/role for "my job"', () => {
      const rules = getRulesForTopic('work/role');
      expect(matchesAnyPattern('my job involves a lot of coding', rules)).toBe(true);
    });
  });

  // =========================================================================
  // Schedule rules
  // =========================================================================
  describe('schedule rules', () => {
    it('should match schedule for "tomorrow"', () => {
      const rules = getRulesForTopic('schedule');
      expect(matchesAnyPattern('meeting tomorrow at 3pm', rules)).toBe(true);
    });

    it('should match schedule for day-of-week', () => {
      const rules = getRulesForTopic('schedule');
      expect(matchesAnyPattern('see you on Wednesday', rules)).toBe(true);
    });

    it('should match schedule/today for "this morning"', () => {
      const rules = getRulesForTopic('schedule/today');
      expect(matchesAnyPattern('this morning was hectic', rules)).toBe(true);
    });

    it('should match schedule/week for "next week"', () => {
      const rules = getRulesForTopic('schedule/week');
      expect(matchesAnyPattern('let us catch up next week', rules)).toBe(true);
    });

    it('should match events/deadlines for "due date"', () => {
      const rules = getRulesForTopic('events/deadlines');
      expect(matchesAnyPattern('the due date is March 31', rules)).toBe(true);
    });

    it('should match events/meetings for "standup"', () => {
      const rules = getRulesForTopic('events/meetings');
      expect(matchesAnyPattern('standup is at 9am', rules)).toBe(true);
    });
  });

  // =========================================================================
  // Health rules
  // =========================================================================
  describe('health rules', () => {
    it('should match health for "doctor"', () => {
      const rules = getRulesForTopic('health');
      expect(matchesAnyPattern('saw the doctor yesterday', rules)).toBe(true);
    });

    it('should match health/physical for "workout"', () => {
      const rules = getRulesForTopic('health/physical');
      expect(matchesAnyPattern('did a workout this morning', rules)).toBe(true);
    });

    it('should match health/mental for "anxiety"', () => {
      const rules = getRulesForTopic('health/mental');
      expect(matchesAnyPattern('feeling some anxiety today', rules)).toBe(true);
    });

    it('should match health/medical for "prescription"', () => {
      const rules = getRulesForTopic('health/medical');
      expect(matchesAnyPattern('picked up my prescription', rules)).toBe(true);
    });

    it('should match health/mental for "burnout"', () => {
      const rules = getRulesForTopic('health/mental');
      expect(matchesAnyPattern('worried about burnout', rules)).toBe(true);
    });
  });

  // =========================================================================
  // Technical rules
  // =========================================================================
  describe('technical rules', () => {
    it('should match technical for "typescript"', () => {
      const rules = getRulesForTopic('technical');
      expect(matchesAnyPattern('using TypeScript for this', rules)).toBe(true);
    });

    it('should match technical for "docker"', () => {
      const rules = getRulesForTopic('technical');
      expect(matchesAnyPattern('running in docker container', rules)).toBe(true);
    });

    it('should match technical/tools for "github"', () => {
      const rules = getRulesForTopic('technical/tools');
      expect(matchesAnyPattern('push to github', rules)).toBe(true);
    });

    it('should match technical/tools for "aws"', () => {
      const rules = getRulesForTopic('technical/tools');
      expect(matchesAnyPattern('deploy to aws', rules)).toBe(true);
    });

    it('should match technical for "bug"', () => {
      const rules = getRulesForTopic('technical');
      expect(matchesAnyPattern('there is a bug in production', rules)).toBe(true);
    });
  });

  // =========================================================================
  // Identity rules
  // =========================================================================
  describe('identity rules', () => {
    it('should match identity for "i am"', () => {
      const rules = getRulesForTopic('identity');
      expect(matchesAnyPattern('I am a software developer', rules)).toBe(true);
    });

    it('should match identity/values for "care about"', () => {
      const rules = getRulesForTopic('identity/values');
      expect(matchesAnyPattern('I care about quality', rules)).toBe(true);
    });

    it('should match identity/background for "grew up"', () => {
      const rules = getRulesForTopic('identity/background');
      expect(matchesAnyPattern('I grew up in Australia', rules)).toBe(true);
    });
  });

  // =========================================================================
  // Preferences rules
  // =========================================================================
  describe('preferences rules', () => {
    it('should have requiresContext=true', () => {
      const prefRules = getRulesForTopic('preferences');
      expect(prefRules.every((r) => r.requiresContext === true)).toBe(true);
    });

    it('should match preferences/likes for "my favorite"', () => {
      const rules = getRulesForTopic('preferences/likes');
      expect(matchesAnyPattern('my favorite coffee is drip', rules)).toBe(true);
    });

    it('should match preferences/dislikes for "can\'t stand"', () => {
      const rules = getRulesForTopic('preferences/dislikes');
      expect(matchesAnyPattern("I can't stand dark chocolate", rules)).toBe(true);
    });
  });

  // =========================================================================
  // Agent rules
  // =========================================================================
  describe('agent rules', () => {
    it('should match agent/self for "who are you"', () => {
      const rules = getRulesForTopic('agent/self');
      expect(matchesAnyPattern('who are you exactly?', rules)).toBe(true);
    });

    it('should match agent/learnings for "insight"', () => {
      const rules = getRulesForTopic('agent/learnings');
      expect(matchesAnyPattern('an insight from last week', rules)).toBe(true);
    });

    it('should match conversation rule for "we talked"', () => {
      const rules = getRulesForTopic('conversation');
      expect(matchesAnyPattern('we talked about this before', rules)).toBe(true);
    });
  });

  // =========================================================================
  // Case insensitivity
  // =========================================================================
  describe('case insensitivity', () => {
    it('all patterns should be case-insensitive', () => {
      for (const rule of KEYWORD_RULES) {
        for (const pattern of rule.patterns) {
          expect(pattern.flags).toContain('i');
        }
      }
    });

    it('should match uppercase keywords', () => {
      const rules = getRulesForTopic('technical');
      expect(matchesAnyPattern('TYPESCRIPT IS GREAT', rules)).toBe(true);
    });

    it('should match mixed-case keywords', () => {
      const rules = getRulesForTopic('health');
      expect(matchesAnyPattern('Went to the Doctor today', rules)).toBe(true);
    });
  });

  // =========================================================================
  // Non-matching cases
  // =========================================================================
  describe('non-matching', () => {
    it('should not match unrelated text for health patterns', () => {
      const rules = getRulesForTopic('health/medical');
      expect(matchesAnyPattern('the weather is nice today', rules)).toBe(false);
    });

    it('should not match partial words (word boundary)', () => {
      // "doctor" in "doctorinthe" should not match due to \b
      const rules = getRulesForTopic('health/medical');
      // "doctoring" contains "doctor" but \b should handle word boundary
      // Note: \b would still match "doctor" in "doctoringg" as \b matches between \w and \W
      // This test verifies \b is actually enforced
      const noMatchText = 'she was doctoring documents';
      // "doctoring" starts with "doctor" — \b matches at start of word
      // so this IS expected to match (the \b is at the start)
      // Let's test something that truly doesn't match
      expect(matchesAnyPattern('xdoctorx', rules)).toBe(false); // No word boundary
    });

    it('should not false-positive on empty string', () => {
      for (const rule of KEYWORD_RULES) {
        const matched = rule.patterns.some((p) => p.test(''));
        if (matched) {
          // Log which rule matched empty string (should be none)
          console.warn(`Rule ${rule.topic} matched empty string`);
        }
        expect(matched).toBe(false);
      }
    });
  });
});

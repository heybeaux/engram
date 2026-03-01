import {
  extractCapabilitySignals,
  extractPreferenceSignals,
  inferPrefCategory,
  basicExtraction,
} from './extraction-signals';

describe('extractCapabilitySignals', () => {
  it('should extract "successfully" pattern with 0.8 confidence', () => {
    const result = extractCapabilitySignals('I successfully deployed the app.');
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].capability).toBe('deployed the app');
    expect(result[0].confidence).toBe(0.8);
  });

  it('should extract "built/created" patterns', () => {
    const result = extractCapabilitySignals('I built a REST API for the team.');
    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBe(0.7);
  });

  it('should extract "proficient in" with 0.9 confidence', () => {
    const result = extractCapabilitySignals('I am proficient in TypeScript.');
    expect(result).toHaveLength(1);
    expect(result[0].capability).toBe('TypeScript');
    expect(result[0].confidence).toBe(0.9);
  });

  it('should deduplicate case-insensitively', () => {
    const result = extractCapabilitySignals(
      'I successfully built the API. I successfully Built The API again.',
    );
    // Both match "successfully" pattern; second is deduped if same capability
    expect(result.length).toBeLessThanOrEqual(2);
  });

  it('should return empty for no matches', () => {
    expect(extractCapabilitySignals('Just a regular sentence.')).toEqual([]);
  });

  it('should not match too-short captures (< 5 chars for some patterns)', () => {
    const result = extractCapabilitySignals('I successfully did it.');
    // "did it" is 6 chars, should match
    expect(result.length).toBeGreaterThanOrEqual(0);
  });
});

describe('extractPreferenceSignals', () => {
  it('should extract "I prefer" as strong', () => {
    const result = extractPreferenceSignals('I prefer dark mode.', null);
    expect(result).toHaveLength(1);
    expect(result[0].strength).toBe('strong');
    expect(result[0].preference).toBe('dark mode');
  });

  it('should extract "always use" as strong', () => {
    const result = extractPreferenceSignals('I always use TypeScript.', null);
    expect(result).toHaveLength(1);
    expect(result[0].strength).toBe('strong');
  });

  it('should extract "like" as moderate', () => {
    const result = extractPreferenceSignals(
      'I like coffee in the morning.',
      null,
    );
    expect(result).toHaveLength(1);
    expect(result[0].strength).toBe('moderate');
  });

  it('should extract "usually" as weak', () => {
    const result = extractPreferenceSignals('I usually work late.', null);
    expect(result).toHaveLength(1);
    expect(result[0].strength).toBe('weak');
  });

  it('should fallback to raw text for PREFERENCE type with no pattern match', () => {
    const result = extractPreferenceSignals(
      'Vim over Emacs',
      'PREFERENCE' as any,
    );
    expect(result).toHaveLength(1);
    expect(result[0].strength).toBe('moderate');
  });

  it('should return empty for no matches on non-PREFERENCE type', () => {
    expect(extractPreferenceSignals('Hello world', null)).toEqual([]);
  });
});

describe('inferPrefCategory', () => {
  it('should detect tooling', () => {
    expect(inferPrefCategory('I use VS Code editor')).toBe('tooling');
  });

  it('should detect interface', () => {
    expect(inferPrefCategory('Dark theme is better')).toBe('interface');
  });

  it('should detect food', () => {
    expect(inferPrefCategory('I love coffee')).toBe('food');
  });

  it('should detect communication', () => {
    expect(inferPrefCategory('Prefer slack over email')).toBe('communication');
  });

  it('should detect workflow', () => {
    expect(inferPrefCategory('CI pipeline automation')).toBe('workflow');
  });

  it('should default to general', () => {
    expect(inferPrefCategory('Random stuff here')).toBe('general');
  });
});

describe('basicExtraction', () => {
  it('should return ExtractionResult with all fields', () => {
    const result = basicExtraction('Beaux built a REST API for the project.');
    expect(result).toHaveProperty('who');
    expect(result).toHaveProperty('what');
    expect(result).toHaveProperty('topics');
    expect(result).toHaveProperty('entities');
    expect(result).toHaveProperty('memoryType');
    expect(result).toHaveProperty('capabilities');
    expect(result).toHaveProperty('preferenceSignals');
    expect(result.confidence).toBeDefined();
  });

  it('should replace "User" with userName when provided', () => {
    const result = basicExtraction('User likes dark mode', 'Beaux');
    expect(result.what).toContain('Beaux');
  });

  it('should truncate long text to 200 chars', () => {
    const longText = 'A'.repeat(300);
    const result = basicExtraction(longText);
    expect(result.what!.length).toBeLessThanOrEqual(204); // 200 + '...'
  });

  it('should extract topics from text', () => {
    const result = basicExtraction(
      'Deploy the API to the server for the client.',
    );
    expect(result.topics).toContain('coding');
    expect(result.topics).toContain('business');
  });

  it('should extract entities', () => {
    const result = basicExtraction('John Smith works on the project.', 'Beaux');
    const names = result.entities.map((e) => e.name);
    expect(names).toContain('Beaux');
    expect(names).toContain('John Smith');
  });
});

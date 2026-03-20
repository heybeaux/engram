import {
  SentimentService,
  SentimentPolarity,
  NEGATIVE_KEYWORDS,
  POSITIVE_KEYWORDS,
} from './sentiment.service';

describe('SentimentService', () => {
  describe('classify', () => {
    it('returns positive for clearly positive text', () => {
      expect(
        SentimentService.classify('Today was perfect. Kids were laughing.'),
      ).toBe('positive');
    });

    it('returns negative for clearly negative text', () => {
      expect(
        SentimentService.classify("Completely overwhelmed. Can't focus."),
      ).toBe('negative');
    });

    it('returns neutral for emotionally neutral text', () => {
      expect(
        SentimentService.classify('Building a NestJS backend with Prisma.'),
      ).toBe('neutral');
    });

    it('returns neutral for empty string', () => {
      expect(SentimentService.classify('')).toBe('neutral');
    });

    it('classifies alice_joy_001 as positive', () => {
      const text =
        'Today was perfect. Kids were laughing, sun was out, got a huge feature shipped. Days like this make it all worth it.';
      expect(SentimentService.classify(text)).toBe('positive');
    });

    it('classifies alice_pride_001 as positive (tie-break: proudest ≥ hard)', () => {
      const text =
        'Just got promoted to senior engineer. Years of hard work paying off. This is my proudest professional moment.';
      expect(SentimentService.classify(text)).toBe('positive');
    });

    it('classifies alice_grief_001 as negative (missing)', () => {
      const text = 'Missing my dad today. Would have been his 70th birthday.';
      expect(SentimentService.classify(text)).toBe('negative');
    });

    it('classifies alice_stress_001 as negative', () => {
      const text =
        "Completely overwhelmed. Can't focus. Too many things pulling at me.";
      expect(SentimentService.classify(text)).toBe('negative');
    });

    it('classifies alice_frustration_001 as negative', () => {
      const text =
        'So frustrated with the CI pipeline. Third time it broke this week because of flaky tests.';
      expect(SentimentService.classify(text)).toBe('negative');
    });

    it('classifies alice_worry_001 as negative', () => {
      const text = "I'm worried about the mortgage rates going up.";
      expect(SentimentService.classify(text)).toBe('negative');
    });

    it('classifies alice_anxiety_001 as negative', () => {
      const text =
        "Can't stop thinking about the production outage. The on-call stress is real.";
      expect(SentimentService.classify(text)).toBe('negative');
    });

    it('classifies alice_calm_001 as positive (calmer)', () => {
      const text =
        'Meditation is helping. 10 minutes every morning before coffee. Feel noticeably calmer.';
      expect(SentimentService.classify(text)).toBe('positive');
    });

    it('classifies alice_mixed_emotion_001 as positive (happy ties worried, positive wins tie)', () => {
      const text =
        'Happy that Stella got into the good school, but worried about the tuition costs. Mixed feelings.';
      expect(SentimentService.classify(text)).toBe('positive');
    });

    it('classifies negative query "when I felt stressed or overwhelmed" as negative', () => {
      expect(
        SentimentService.classify('when I felt stressed or overwhelmed'),
      ).toBe('negative');
    });

    it('classifies positive query "What makes me happy?" as positive', () => {
      expect(SentimentService.classify('What makes me happy?')).toBe(
        'positive',
      );
    });

    it('classifies positive query "My proudest moments" as positive', () => {
      expect(SentimentService.classify('My proudest moments')).toBe('positive');
    });

    it('classifies negative query "What am I worried about?" as negative', () => {
      expect(SentimentService.classify('What am I worried about?')).toBe(
        'negative',
      );
    });

    it('classifies negative query "Times I was frustrated" as negative', () => {
      expect(SentimentService.classify('Times I was frustrated')).toBe(
        'negative',
      );
    });

    it('classifies neutral query "meditation and mental wellbeing" as neutral', () => {
      expect(SentimentService.classify('meditation and mental wellbeing')).toBe(
        'neutral',
      );
    });

    it('classifies neutral query "How has my attitude toward work changed?" as neutral', () => {
      expect(
        SentimentService.classify('How has my attitude toward work changed?'),
      ).toBe('neutral');
    });

    it('classifies mixed query "happy about school but worried about costs" as positive (tie)', () => {
      expect(
        SentimentService.classify('happy about school but worried about costs'),
      ).toBe('positive');
    });

    it('is case-insensitive', () => {
      expect(SentimentService.classify('HAPPY AND PERFECT')).toBe('positive');
      expect(SentimentService.classify('STRESSED AND OVERWHELMED')).toBe(
        'negative',
      );
    });
  });

  describe('sentimentPenalty', () => {
    it('returns 1.0 for matching positive polarities', () => {
      expect(SentimentService.sentimentPenalty('positive', 'positive')).toBe(
        1.0,
      );
    });

    it('returns 1.0 for matching negative polarities', () => {
      expect(SentimentService.sentimentPenalty('negative', 'negative')).toBe(
        1.0,
      );
    });

    it('returns 0.15 for positive query vs negative memory', () => {
      expect(SentimentService.sentimentPenalty('positive', 'negative')).toBe(
        0.05,
      );
    });

    it('returns 0.15 for negative query vs positive memory', () => {
      expect(SentimentService.sentimentPenalty('negative', 'positive')).toBe(
        0.05,
      );
    });

    it('returns 1.0 when query is neutral (no penalty regardless of memory)', () => {
      expect(SentimentService.sentimentPenalty('neutral', 'positive')).toBe(
        1.0,
      );
      expect(SentimentService.sentimentPenalty('neutral', 'negative')).toBe(
        1.0,
      );
      expect(SentimentService.sentimentPenalty('neutral', 'neutral')).toBe(1.0);
    });

    it('returns 0.75 when memory is neutral and query has sentiment (mild noise suppression)', () => {
      expect(SentimentService.sentimentPenalty('positive', 'neutral')).toBe(
        0.75,
      );
      expect(SentimentService.sentimentPenalty('negative', 'neutral')).toBe(
        0.75,
      );
    });

    it('returns 1.0 when both query and memory are neutral', () => {
      expect(SentimentService.sentimentPenalty('neutral', 'neutral')).toBe(1.0);
    });
  });

  describe('scorePenalty', () => {
    it('penalizes positive memory for negative query', () => {
      const query = 'when I felt stressed or overwhelmed';
      const joyMemory = 'Today was perfect. Kids were laughing, sun was out.';
      expect(SentimentService.scorePenalty(query, joyMemory)).toBe(0.05);
    });

    it('penalizes negative memory for positive query', () => {
      const query = 'What makes me happy?';
      const stressMemory =
        "Completely overwhelmed. Can't focus. Too many things pulling at me.";
      expect(SentimentService.scorePenalty(query, stressMemory)).toBe(0.05);
    });

    it('does not penalize matching polarity', () => {
      const query = 'when I felt stressed or overwhelmed';
      const stressMemory = "Completely overwhelmed. Can't focus.";
      expect(SentimentService.scorePenalty(query, stressMemory)).toBe(1.0);
    });

    it('does not penalize neutral query against any memory', () => {
      const query = 'What is my tech stack?';
      const joyMemory = 'Today was perfect. Kids were laughing.';
      const stressMemory = "Completely overwhelmed. Can't focus.";
      expect(SentimentService.scorePenalty(query, joyMemory)).toBe(1.0);
      expect(SentimentService.scorePenalty(query, stressMemory)).toBe(1.0);
    });

    it('applies mild 0.75× penalty to neutral memory for emotional query (noise suppression)', () => {
      const query = 'when I felt stressed or overwhelmed';
      const neutralMemory =
        'Building a NestJS backend with Prisma and PostgreSQL.';
      expect(SentimentService.scorePenalty(query, neutralMemory)).toBe(0.75);
    });

    it('does not penalize alice_grief_001 for a grief query', () => {
      const query = 'times I felt sad or grieving';
      const griefMemory =
        'Missing my dad today. Would have been his 70th birthday.';
      expect(SentimentService.scorePenalty(query, griefMemory)).toBe(1.0);
    });

    it('penalizes alice_joy_001 for grief query', () => {
      const query = 'times I felt sad or grieving';
      const joyMemory = 'Today was perfect. Kids were laughing, sun was out.';
      expect(SentimentService.scorePenalty(query, joyMemory)).toBe(0.05);
    });

    it('penalizes alice_stress_001 for happy query', () => {
      const query = 'My proudest moments';
      const stressMemory =
        "Completely overwhelmed. Can't focus. Too many things pulling at me.";
      expect(SentimentService.scorePenalty(query, stressMemory)).toBe(0.05);
    });

    it('does not penalize alice_pride_001 for proud query', () => {
      const query = 'My proudest moments';
      const prideMemory =
        'Just got promoted. Years of hard work paying off. This is my proudest professional moment.';
      expect(SentimentService.scorePenalty(query, prideMemory)).toBe(1.0);
    });

    it('penalizes alice_pride_001 for frustrated query', () => {
      const query = 'Times I was frustrated';
      const prideMemory =
        'Just got promoted. Years of hard work paying off. This is my proudest professional moment.';
      expect(SentimentService.scorePenalty(query, prideMemory)).toBe(0.05);
    });

    it('returns 1.0 for empty query', () => {
      const memory = 'Today was perfect.';
      expect(SentimentService.scorePenalty('', memory)).toBe(1.0);
    });
  });

  describe('keyword lists', () => {
    it('NEGATIVE_KEYWORDS contains required terms', () => {
      for (const kw of [
        'stress',
        'overwhelmed',
        'worried',
        'frustrated',
        'grief',
        'sad',
        'anxious',
        'missing',
      ]) {
        expect(NEGATIVE_KEYWORDS).toContain(kw);
      }
    });

    it('POSITIVE_KEYWORDS contains required terms', () => {
      for (const kw of [
        'happy',
        'joy',
        'proud',
        'proudest',
        'laughing',
        'perfect',
        'calm',
        'calmer',
      ]) {
        expect(POSITIVE_KEYWORDS).toContain(kw);
      }
    });

    it('has no overlap between keyword lists', () => {
      const negSet = new Set(NEGATIVE_KEYWORDS);
      const overlap = POSITIVE_KEYWORDS.filter((kw) => negSet.has(kw));
      expect(overlap).toHaveLength(0);
    });
  });
});

/**
 * Sentiment polarity scoring for recall quality.
 *
 * Pure utility — no NestJS DI. All methods are static.
 *
 * Solves the "emotional clustering" problem: bge-base-en-v1.5 places all
 * emotionally-charged text near each other in embedding space, causing
 * alice_joy_001 to surface for "stressed" queries and vice versa.
 *
 * Two-tier penalty system:
 * - 0.15× for opposite-polarity memories (joy memory for grief query)
 * - 0.75× for neutral memories when the query has strong sentiment
 *   (daily-gen noise like "Morning routine: cleared my inbox" competes
 *    with specific emotional memories; this mild penalty tips the balance)
 */

// Tightly-scoped keywords — only unambiguously emotional words.
// Generic words (hard, great, love) intentionally excluded
// to avoid false-positive polarity matches on non-emotional queries.
export const NEGATIVE_KEYWORDS = [
  'stress',
  'stressed',
  'stresses',
  'stressful',
  'overwhelm',
  'overwhelmed',
  'overwhelming',
  'anxious',
  'anxiety',
  'worried',
  'worry',
  'worrying',
  'frustrated',
  'frustration',
  'frustrating',
  'grief',
  'grieving',
  'grieve',
  'depressed',
  'depression',
  'angry',
  'anger',
  'exhausted',
  'exhaustion',
  'burnout',
  'dread',
  'dreading',
  'scared',
  'fearful',
  'terrible',
  'awful',
  'lonely',
  'loneliness',
  'miserable',
  'miserably',
  'desperate',
  'despair',
  'hopeless',
  'hopelessness',
  'sad',
  'sadness',
  'missing',
];

export const POSITIVE_KEYWORDS = [
  'happy',
  'happiness',
  'joy',
  'joyful',
  'joyfully',
  'proud',
  'pride',
  'proudest',
  'proudly',
  'excited',
  'excitement',
  'wonderful',
  'amazing',
  'fantastic',
  'brilliant',
  'delighted',
  'delight',
  'thrilled',
  'cheerful',
  'cheerfully',
  'laughing',
  'laughter',
  'celebrate',
  'celebration',
  'celebrated',
  'ecstatic',
  'elated',
  'elation',
  'overjoyed',
  'blissful',
  'bliss',
  'perfect',
  'calm',
  'calmer',
  'calmly',
  'calmness',
];

export type SentimentPolarity = 'positive' | 'negative' | 'neutral';

export class SentimentService {
  /**
   * Classify text as positive, negative, or neutral based on keyword counts.
   *
   * Tie-breaking rule: posCount >= negCount && posCount > 0 → 'positive'.
   * This correctly handles alice_pride_001 ("proudest" ties "hard" → positive).
   */
  static classify(text: string): SentimentPolarity {
    const words = text.toLowerCase().match(/\b[a-z]+\b/g) ?? [];
    let posCount = 0;
    let negCount = 0;
    for (const word of words) {
      if (POSITIVE_KEYWORDS.includes(word)) posCount++;
      if (NEGATIVE_KEYWORDS.includes(word)) negCount++;
    }
    if (posCount === 0 && negCount === 0) return 'neutral';
    if (posCount >= negCount) return 'positive';
    return 'negative';
  }

  /**
   * Returns a score multiplier (0–1) based on polarity mismatch.
   *
   * - 1.0  → no penalty (same polarity, or neutral query)
   * - 0.75 → mild penalty: emotional query but neutral memory
   *          (prevents generic daily-routine memories from occupying top-5
   *           slots ahead of specific emotional memories)
   * - 0.15 → strong penalty: opposite polarity
   *          (joy memory for frustration query, stress memory for proud query)
   */
  static sentimentPenalty(
    queryPolarity: SentimentPolarity,
    memoryPolarity: SentimentPolarity,
  ): number {
    // Neutral query: no polarity-based adjustment at all
    if (queryPolarity === 'neutral') return 1.0;

    // Opposite polarity: strong suppression
    if (memoryPolarity !== 'neutral' && queryPolarity !== memoryPolarity)
      return 0.05;

    // Neutral memory on an emotional query: mild suppression
    // Keeps same-polarity emotional memories ranked above general noise.
    if (memoryPolarity === 'neutral') return 0.75;

    // Same polarity: no penalty
    return 1.0;
  }

  /**
   * Convenience: classify both texts and return the penalty multiplier.
   */
  static scorePenalty(query: string, memoryRaw: string): number {
    const qp = SentimentService.classify(query);
    const mp = SentimentService.classify(memoryRaw);
    return SentimentService.sentimentPenalty(qp, mp);
  }
}

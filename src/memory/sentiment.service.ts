/**
 * Sentiment polarity scoring for recall quality.
 *
 * Pure utility — no NestJS DI. All methods are static.
 *
 * Solves the "emotional clustering" problem: bge-base-en-v1.5 places all
 * emotionally-charged text near each other in embedding space, causing
 * alice_joy_001 to surface for "stressed" queries and vice versa.
 * A cross-polarity penalty of 0.5× pushes mismatched memories below
 * correctly-polarised candidates.
 */

export const NEGATIVE_KEYWORDS = [
  'stress', 'stressed', 'stresses', 'stressful',
  'overwhelm', 'overwhelmed', 'overwhelming',
  'anxious', 'anxiety',
  'worried', 'worry', 'worrying',
  'frustrated', 'frustration', 'frustrating',
  'grief', 'grieving', 'grieve',
  'sad', 'sadness',
  'depression', 'depressed', 'depressing',
  'angry', 'anger',
  'exhausted', 'exhaustion',
  'burnout',
  'dread', 'dreading',
  'fear', 'fearful', 'fears',
  'scared',
  'terrible',
  'awful',
  'worst',
  'struggling', 'struggle',
  'difficult', 'difficulty',
  'hard',
  'missing', // grief-context: "Missing my dad today"
  'miss',
  'lonely', 'loneliness',
  'hurt', 'pain',
  'upset',
];

export const POSITIVE_KEYWORDS = [
  'happy', 'happiness',
  'joy', 'joyful',
  'proud', 'pride', 'proudest', 'proudly',
  'excited', 'excitement',
  'wonderful',
  'amazing',
  'great',
  'love', 'loved', 'loving',
  'fantastic',
  'excellent',
  'brilliant',
  'delighted', 'delight',
  'glad',
  'cheerful',
  'optimistic', 'optimism',
  'pleased',
  'thrilled',
  'peaceful', 'peace',
  'calm', 'calmer', 'calmness',
  'content', 'contentment',
  'satisfied', 'satisfaction',
  'laughing', 'laughter', 'laugh',
  'perfect',
  'celebrate', 'celebration',
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
   * - 1.0 → no penalty (same polarity, or either side is neutral)
   * - 0.5 → cross-polarity penalty (positive query ↔ negative memory, or vice versa)
   */
  static sentimentPenalty(
    queryPolarity: SentimentPolarity,
    memoryPolarity: SentimentPolarity,
  ): number {
    if (queryPolarity === 'neutral' || memoryPolarity === 'neutral') return 1.0;
    if (queryPolarity !== memoryPolarity) return 0.5;
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

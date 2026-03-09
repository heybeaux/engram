import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface DetectedMention {
  profileId: string;
  matchedText: string;
  matchType: 'exact' | 'alias' | 'normalized';
  confidence: number;
}

@Injectable()
export class EntityMentionService {
  private readonly logger = new Logger(EntityMentionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Detect entity mentions in a text for a given user.
   * Checks exact name, aliases, and normalized name variants.
   */
  async detectMentions(
    text: string,
    userId: string,
  ): Promise<DetectedMention[]> {
    if (!text || !text.trim()) return [];

    const profiles = await this.prisma.entityProfile.findMany({
      where: { userId, deletedAt: null },
      select: {
        id: true,
        name: true,
        normalizedName: true,
        aliases: true,
      },
    });

    if (!profiles.length) return [];

    const lowerText = text.toLowerCase();
    const results: DetectedMention[] = [];

    for (const profile of profiles) {
      let matched = false;

      // 1. Exact name match (case-insensitive)
      const lowerName = profile.name.toLowerCase();
      if (this.containsWholeWord(lowerText, lowerName)) {
        results.push({
          profileId: profile.id,
          matchedText: profile.name,
          matchType: 'exact',
          confidence: 1.0,
        });
        matched = true;
      }

      // 2. Alias matches (case-insensitive)
      if (!matched && profile.aliases && profile.aliases.length > 0) {
        for (const alias of profile.aliases) {
          const lowerAlias = alias.toLowerCase();
          if (this.containsWholeWord(lowerText, lowerAlias)) {
            results.push({
              profileId: profile.id,
              matchedText: alias,
              matchType: 'alias',
              confidence: 0.9,
            });
            matched = true;
            break;
          }
        }
      }

      // 3. Normalized name match (e.g. "john-doe" or "john_doe" normalizations)
      if (!matched && profile.normalizedName) {
        const lowerNormalized = profile.normalizedName.toLowerCase();
        // Only check if normalized differs from name (to avoid double-reporting)
        if (
          lowerNormalized !== lowerName &&
          this.containsWholeWord(lowerText, lowerNormalized)
        ) {
          results.push({
            profileId: profile.id,
            matchedText: profile.normalizedName,
            matchType: 'normalized',
            confidence: 0.8,
          });
        }
      }
    }

    return results;
  }

  /**
   * Check whether `text` contains `word` as a whole word (word boundary check).
   * Handles multi-word phrases correctly.
   */
  private containsWholeWord(text: string, word: string): boolean {
    if (!word || word.length < 2) return false;

    // For multi-word phrases, substring match is fine (less chance of false positive)
    if (word.includes(' ')) {
      return text.includes(word);
    }

    // For single words, enforce word boundaries
    try {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(?<![\\w])${escaped}(?![\\w])`, 'i');
      return regex.test(text);
    } catch {
      return text.includes(word);
    }
  }
}

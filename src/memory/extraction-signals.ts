import { MemoryType } from '@prisma/client';
import {
  CapabilitySignal,
  PreferenceSignal,
  EntityWithType,
  ExtractionResult,
} from './extraction-types';
import { basicMemoryTypeClassification } from './extraction-classifiers';

/**
 * Extract capability signals from text (HEY-169)
 */
export function extractCapabilitySignals(raw: string): CapabilitySignal[] {
  const signals: CapabilitySignal[] = [];
  const seen = new Set<string>();

  const patterns = [
    { regex: /successfully\s+(.{5,80}?)(?:\.|,|$)/i, confidence: 0.8 },
    {
      regex:
        /(?:built|created|developed|implemented|deployed|shipped|launched)\s+(.{5,80}?)(?:\.|,|$)/i,
      confidence: 0.7,
    },
    {
      regex: /(?:fixed|resolved|debugged|patched)\s+(.{5,80}?)(?:\.|,|$)/i,
      confidence: 0.7,
    },
    {
      regex: /(?:configured|set up|integrated)\s+(.{5,80}?)(?:\.|,|$)/i,
      confidence: 0.6,
    },
    {
      regex: /(?:migrated|upgraded|optimized)\s+(.{5,80}?)(?:\.|,|$)/i,
      confidence: 0.7,
    },
    {
      regex:
        /(?:proficient|skilled|experienced|expert)\s+(?:in|with|at)\s+(.{3,80}?)(?:\.|,|$)/i,
      confidence: 0.9,
    },
  ];

  for (const { regex, confidence } of patterns) {
    const match = raw.match(regex);
    if (match && match[1]) {
      const capability = match[1].trim();
      const key = capability.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        signals.push({ capability, confidence });
      }
    }
  }

  return signals;
}

/**
 * Extract preference signals from text (HEY-171)
 */
export function extractPreferenceSignals(
  raw: string,
  memoryType: MemoryType | null,
): PreferenceSignal[] {
  const signals: PreferenceSignal[] = [];
  const seen = new Set<string>();

  const patterns: Array<{
    regex: RegExp;
    strength: PreferenceSignal['strength'];
  }> = [
    { regex: /\bi\s+prefer\s+(.{3,100}?)(?:\.|,|$)/i, strength: 'strong' },
    {
      regex: /\balways\s+(?:use|uses?)\s+(.{3,80}?)(?:\.|,|$)/i,
      strength: 'strong',
    },
    {
      regex: /\bnever\s+(?:use|uses?)\s+(.{3,80}?)(?:\.|,|$)/i,
      strength: 'strong',
    },
    {
      regex: /\bi?\s*(?:don't|doesn't|do not)\s+like\s+(.{3,80}?)(?:\.|,|$)/i,
      strength: 'moderate',
    },
    {
      regex: /\bi?\s*(?:like|enjoy)\s+(.{3,80}?)(?:\.|,|$)/i,
      strength: 'moderate',
    },
    {
      regex: /\bfavorite\s+(?:\w+\s+)?is\s+(.{3,80}?)(?:\.|,|$)/i,
      strength: 'strong',
    },
    { regex: /\busually\s+(.{3,80}?)(?:\.|,|$)/i, strength: 'weak' },
  ];

  for (const { regex, strength } of patterns) {
    const match = raw.match(regex);
    if (match && match[1]) {
      const preference = match[1].trim();
      const key = preference.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        signals.push({
          category: inferPrefCategory(raw),
          preference,
          strength,
        });
      }
    }
  }

  if (memoryType === 'PREFERENCE' && signals.length === 0) {
    signals.push({
      category: inferPrefCategory(raw),
      preference: raw.substring(0, 150),
      strength: 'moderate',
    });
  }

  return signals;
}

/**
 * Infer preference category from text
 */
export function inferPrefCategory(text: string): string {
  const lower = text.toLowerCase();
  if (
    /\b(code|programming|language|framework|library|tool|editor|ide)\b/.test(
      lower,
    )
  )
    return 'tooling';
  if (/\b(ui|ux|design|theme|dark|light|color|font)\b/.test(lower))
    return 'interface';
  if (/\b(coffee|tea|food|drink|meal)\b/.test(lower)) return 'food';
  if (/\b(communicate|email|slack|message|call|meeting)\b/.test(lower))
    return 'communication';
  if (/\b(deploy|ci|cd|pipeline|workflow|process)\b/.test(lower))
    return 'workflow';
  return 'general';
}

/**
 * Fallback basic extraction when LLM is unavailable
 */
export function basicExtraction(
  raw: string,
  userName?: string,
): ExtractionResult {
  let processedRaw = raw;
  if (userName) {
    processedRaw = raw
      .replace(/\bUser\b/g, userName)
      .replace(/\buser\b/g, userName)
      .replace(/\bthe user\b/gi, userName);
  }

  const memoryType = basicMemoryTypeClassification(processedRaw);
  const who = userName || extractWho(processedRaw);
  const what =
    processedRaw.length > 200
      ? processedRaw.substring(0, 200) + '...'
      : processedRaw;

  return {
    who,
    what,
    when: null,
    where: null,
    why: null,
    how: null,
    topics: extractTopics(processedRaw),
    entities: extractEntitiesWithTypes(processedRaw, userName),
    memoryType,
    typeConfidence: 0.5,
    confidence: {
      whoConfidence: who ? 0.3 : null,
      whatConfidence: what ? 0.4 : null,
      whenConfidence: null,
      whereConfidence: null,
      whyConfidence: null,
      howConfidence: null,
    },
    lesson: null,
    capabilities: extractCapabilitySignals(processedRaw),
    preferenceSignals: extractPreferenceSignals(processedRaw, memoryType),
    factKeys: [],
  };
}

// =========================================================================
// Basic extraction helpers
// =========================================================================

const COMMON_WORDS = new Set([
  'The',
  'This',
  'That',
  'I',
  'We',
  'They',
  'It',
  'He',
  'She',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
  'User',
  'Assistant',
]);

function extractWho(raw: string): string | null {
  const namePattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g;
  const matches = raw.match(namePattern);
  if (matches && matches.length > 0) {
    const names = matches.filter((m) => !COMMON_WORDS.has(m));
    return names.length > 0 ? names[0] : null;
  }
  return null;
}

function extractTopics(raw: string): string[] {
  const topics: Set<string> = new Set();
  const lowered = raw.toLowerCase();

  const topicKeywords: Record<string, string[]> = {
    coding: [
      'code',
      'programming',
      'developer',
      'api',
      'function',
      'bug',
      'deploy',
    ],
    design: ['design', 'ui', 'ux', 'layout', 'color', 'font', 'style'],
    business: ['meeting', 'client', 'project', 'deadline', 'budget', 'pricing'],
    preferences: ['prefer', 'like', 'hate', 'favorite', 'always', 'never'],
    technical: ['database', 'server', 'api', 'integration', 'architecture'],
  };

  for (const [topic, keywords] of Object.entries(topicKeywords)) {
    if (keywords.some((kw) => lowered.includes(kw))) {
      topics.add(topic);
    }
  }

  return Array.from(topics);
}

function extractEntitiesWithTypes(
  raw: string,
  userName?: string,
): EntityWithType[] {
  const entities: EntityWithType[] = [];
  const seen = new Set<string>();

  if (userName && !seen.has(userName.toLowerCase())) {
    entities.push({ name: userName, type: 'person' });
    seen.add(userName.toLowerCase());
  }

  const pattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g;
  const matches = raw.match(pattern);

  if (matches) {
    for (const match of matches) {
      const normalized = match.toLowerCase();
      if (!COMMON_WORDS.has(match) && !seen.has(normalized)) {
        let type: EntityWithType['type'] = 'other';
        if (match.includes(' ') && match.split(' ').length === 2) {
          type = 'person';
        }
        entities.push({ name: match, type });
        seen.add(normalized);
      }
    }
  }

  return entities;
}

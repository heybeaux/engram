import { Injectable } from '@nestjs/common';

export interface LinkedInEmailParseResult {
  isLinkedIn: boolean;
  type?:
    | 'reaction'
    | 'comment'
    | 'follow'
    | 'profile_view'
    | 'connection'
    | 'unknown';
  engagerName?: string;
  action?: string;
  commentPreview?: string;
}

const LINKEDIN_SENDER_PATTERNS = [
  '@linkedin.com',
  '@e.linkedin.com',
  '@el.linkedin.com',
  '@notifications.linkedin.com',
];

const SUBJECT_PATTERNS: Array<{
  regex: RegExp;
  type: LinkedInEmailParseResult['type'];
  action: string;
}> = [
  {
    regex: /^(.+?) reacted to your post/i,
    type: 'reaction',
    action: 'reacted to your post',
  },
  {
    regex: /^(.+?) commented on your post/i,
    type: 'comment',
    action: 'commented on your post',
  },
  {
    regex: /^(.+?) commented on your article/i,
    type: 'comment',
    action: 'commented on your article',
  },
  {
    regex: /^(.+?) started following you/i,
    type: 'follow',
    action: 'started following you on LinkedIn',
  },
  {
    regex: /^(.+?) is now following you/i,
    type: 'follow',
    action: 'started following you on LinkedIn',
  },
  {
    regex: /^(.+?) viewed your profile/i,
    type: 'profile_view',
    action: 'viewed your LinkedIn profile',
  },
  {
    regex: /^(.+?) accepted your (?:connection|invitation)/i,
    type: 'connection',
    action: 'accepted your LinkedIn connection request',
  },
  {
    regex: /^You and (.+?) are now connected/i,
    type: 'connection',
    action: 'connected with you on LinkedIn',
  },
  {
    regex: /^(.+?) sent you a message/i,
    type: 'unknown',
    action: 'sent you a LinkedIn message',
  },
];

@Injectable()
export class LinkedInEmailParserService {
  /**
   * Parse an inbound email and detect if it is a LinkedIn notification.
   * Returns structured engagement data if it is.
   */
  parse(subject: string, body: string, from: string): LinkedInEmailParseResult {
    if (!this.isLinkedInEmail(from, subject)) {
      return { isLinkedIn: false };
    }

    const subjectClean = (subject || '').trim();

    for (const pattern of SUBJECT_PATTERNS) {
      const match = subjectClean.match(pattern.regex);
      if (match) {
        const engagerName = match[1]?.trim();
        const result: LinkedInEmailParseResult = {
          isLinkedIn: true,
          type: pattern.type,
          engagerName,
          action: pattern.action,
        };

        // For comments, try to extract a preview from the body
        if (pattern.type === 'comment' && body) {
          result.commentPreview = this.extractCommentPreview(body);
        }

        return result;
      }
    }

    // It's a LinkedIn email but we couldn't parse the specific action
    return {
      isLinkedIn: true,
      type: 'unknown',
      action: 'interacted with you on LinkedIn',
    };
  }

  private isLinkedInEmail(from: string, subject: string): boolean {
    const fromLower = (from || '').toLowerCase();
    const subjectLower = (subject || '').toLowerCase();

    if (
      LINKEDIN_SENDER_PATTERNS.some((pattern) => fromLower.includes(pattern))
    ) {
      return true;
    }

    // Fallback: subject strongly indicates LinkedIn
    if (
      subjectLower.includes('linkedin') &&
      (subjectLower.includes('reacted') ||
        subjectLower.includes('commented') ||
        subjectLower.includes('following') ||
        subjectLower.includes('connected') ||
        subjectLower.includes('viewed your profile') ||
        subjectLower.includes('accepted'))
    ) {
      return true;
    }

    return false;
  }

  private extractCommentPreview(body: string): string | undefined {
    // Strip HTML tags if present
    const text = body
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Look for common LinkedIn comment patterns in the body
    const patterns = [
      /commented:\s*[""]([^""]{10,200})[""]/i,
      /wrote:\s*[""]([^""]{10,200})[""]/i,
      /said:\s*[""]([^""]{10,200})[""]/i,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]) {
        return match[1].trim().slice(0, 200);
      }
    }

    return undefined;
  }
}

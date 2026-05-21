import {
  toStructuredItem,
  toStructuredQueryResult,
  wantsStructuredResponse,
} from './structured-recall.dto';
import { QueryResult } from '../memory.types';

describe('structured-recall (ENG-134)', () => {
  describe('wantsStructuredResponse', () => {
    it('returns false on plain defaults', () => {
      expect(wantsStructuredResponse(undefined, undefined)).toBe(false);
      expect(wantsStructuredResponse(undefined, 'application/json')).toBe(
        false,
      );
    });

    it('returns true on response_format=structured or json_v2', () => {
      expect(wantsStructuredResponse('structured', undefined)).toBe(true);
      expect(wantsStructuredResponse('json_v2', undefined)).toBe(true);
      expect(wantsStructuredResponse('STRUCTURED', undefined)).toBe(true);
      expect(wantsStructuredResponse('  Json_V2 ', undefined)).toBe(true);
    });

    it('returns false on response_format=legacy regardless of Accept', () => {
      expect(
        wantsStructuredResponse('legacy', 'application/vnd.engram.v2+json'),
      ).toBe(false);
    });

    it('falls back to Accept header when no query param', () => {
      expect(
        wantsStructuredResponse(undefined, 'application/vnd.engram.v2+json'),
      ).toBe(true);
      expect(
        wantsStructuredResponse(
          undefined,
          'text/html, application/vnd.engram.v2+json;q=0.9',
        ),
      ).toBe(true);
    });

    it('returns false for unknown response_format values without v2 Accept', () => {
      expect(wantsStructuredResponse('weird', undefined)).toBe(false);
    });
  });

  describe('toStructuredItem', () => {
    it('projects every required field', () => {
      const item = toStructuredItem({
        id: 'm-1',
        raw: 'fact text',
        sessionId: 'sess-1',
        score: 0.42,
        createdAt: new Date('2026-01-02T03:04:05.000Z'),
        memoryType: 'FACT',
      } as any);

      expect(item).toEqual({
        id: 'm-1',
        fact: 'fact text',
        source_session: 'sess-1',
        confidence: 0.42,
        timestamp: '2026-01-02T03:04:05.000Z',
        memory_type: 'FACT',
      });
    });

    it('does not fabricate confidence when score is missing', () => {
      const item = toStructuredItem({
        id: 'm-2',
        raw: 'no score',
        sessionId: null,
        createdAt: new Date('2026-01-02T03:04:05.000Z'),
        memoryType: null,
        // intrinsic memory.confidence must NOT be used as retrieval confidence
        confidence: 0.99,
      } as any);

      expect(item.confidence).toBeNull();
      expect(item.source_session).toBeNull();
      expect(item.memory_type).toBeNull();
    });

    it('accepts string createdAt and normalizes to ISO', () => {
      const item = toStructuredItem({
        id: 'm-3',
        raw: 'x',
        sessionId: null,
        score: 0,
        createdAt: '2026-05-21T00:00:00.000Z',
        memoryType: null,
      } as any);

      expect(item.timestamp).toBe('2026-05-21T00:00:00.000Z');
      // score=0 is a real value, not "missing" — must round-trip
      expect(item.confidence).toBe(0);
    });
  });

  describe('toStructuredQueryResult', () => {
    it('preserves envelope metadata and stamps format=json_v2', () => {
      const input: QueryResult = {
        recallId: 'r-1',
        memories: [
          {
            id: 'm-1',
            raw: 'a',
            sessionId: 's-1',
            score: 0.5,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            memoryType: 'FACT',
          } as any,
        ],
        queryTokens: 7,
        latencyMs: 42,
        multiQuery: { strategy: 'foo' } as any,
        explanations: { 'm-1': { reason: 'r' } as any },
      };

      const out = toStructuredQueryResult(input);
      expect(out.format).toBe('json_v2');
      expect(out.recallId).toBe('r-1');
      expect(out.queryTokens).toBe(7);
      expect(out.latencyMs).toBe(42);
      expect(out.multiQuery).toEqual({ strategy: 'foo' });
      expect(out.explanations).toEqual({ 'm-1': { reason: 'r' } });
      expect(out.memories).toHaveLength(1);
      expect(out.memories[0].fact).toBe('a');
    });
  });
});

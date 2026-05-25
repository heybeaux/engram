import { ingestQuestion, reuseIngestResult } from '../src/ingest';
import type { LongMemEvalQuestion } from '../src/types';

describe('reuseIngestResult', () => {
  it('reconstructs the stable LongMemEval identity without reingesting', () => {
    expect(reuseIngestResult('abc123')).toEqual({
      questionId: 'abc123',
      sessionId: 'lme-abc123',
      userId: 'lme-abc123',
      agentId: 'lme-abc123',
      memoryIds: [],
      chunks: 0,
    });
  });
});

describe('ingestQuestion', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    (global as any).fetch = fetchMock;
  });

  it('preserves per-round source timestamps when ingesting LongMemEval history', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        created: 2,
        chunks: 2,
        memoryIds: ['m1', 'm2'],
        sessionId: 'sess-123',
      }),
    });

    const question: LongMemEvalQuestion = {
      question_id: 'abc123',
      question: 'When did this happen?',
      answer: 'yesterday',
      category: 'temporal-reasoning-ability',
      session_history: [
        {
          role: 'user',
          content: 'I went to the museum yesterday.',
          timestamp: '2023-05-20T02:21:00.000Z',
        },
        {
          role: 'assistant',
          content: 'That sounds fun.',
          timestamp: '2023-05-20T02:21:00.000Z',
        },
        {
          role: 'user',
          content: 'Today I went back again.',
          timestamp: '2023-05-21T03:24:00.000Z',
        },
        {
          role: 'assistant',
          content: 'Nice.',
          timestamp: '2023-05-21T03:24:00.000Z',
        },
      ],
    };

    await ingestQuestion(question, {
      apiBase: 'http://localhost:3002',
      apiKey: 'test-key',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3002/v1/memories/bulk',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-AM-API-Key': 'test-key',
          'X-AM-User-ID': 'lme-abc123',
          'X-AM-Agent-ID': 'lme-abc123',
        }),
        body: JSON.stringify({
          memories: [
            {
              raw: 'User: I went to the museum yesterday.\n\nAssistant: That sounds fun.',
              layer: 'SESSION',
              sessionPosition: 0,
              sourceTimestamp: '2023-05-20T02:21:00.000Z',
              sourceTurnIndex: 0,
            },
            {
              raw: 'User: Today I went back again.\n\nAssistant: Nice.',
              layer: 'SESSION',
              sessionPosition: 1,
              sourceTimestamp: '2023-05-21T03:24:00.000Z',
              sourceTurnIndex: 1,
            },
          ],
          context: {
            sessionId: 'lme-abc123',
          },
          agentId: 'lme-abc123',
        }),
      }),
    );
  });
});

import { OllamaProvider } from './ollama.provider';

// ─── fetch mock ──────────────────────────────────────────────────────────────

const mockFetch = jest.fn();
global.fetch = mockFetch;

function makeOkResponse(body: unknown) {
  return {
    ok: true,
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
  };
}

function makeErrorResponse(status: number, text: string) {
  return {
    ok: false,
    status,
    text: jest.fn().mockResolvedValue(text),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('OllamaProvider', () => {
  let provider: OllamaProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new OllamaProvider({ provider: 'ollama', model: 'llama3.2' });
  });

  // =========================================================================
  // Constructor defaults
  // =========================================================================

  describe('constructor', () => {
    it('should default baseUrl to http://localhost:11434', () => {
      const p = new OllamaProvider({ provider: 'ollama', model: 'llama3.2' });
      expect((p as any).baseUrl).toBe('http://localhost:11434');
    });

    it('should default model to llama3.2', () => {
      const p = new OllamaProvider({ provider: 'ollama', model: 'llama3.2' });
      expect((p as any).defaultModel).toBe('llama3.2');
    });

    it('should use custom baseUrl when provided', () => {
      const p = new OllamaProvider({ provider: 'ollama', model: 'llama3.2', baseUrl: 'http://my-gpu-box:11434' });
      expect((p as any).baseUrl).toBe('http://my-gpu-box:11434');
    });

    it('should use custom model when provided', () => {
      const p = new OllamaProvider({ provider: 'ollama', model: 'mistral' });
      expect((p as any).defaultModel).toBe('mistral');
    });

    it('should always set embeddingModel to nomic-embed-text', () => {
      expect((provider as any).embeddingModel).toBe('nomic-embed-text');
    });

    it('should report supportsEmbeddings() as true', () => {
      expect(provider.supportsEmbeddings()).toBe(true);
    });

    it('should have name === "ollama"', () => {
      expect(provider.name).toBe('ollama');
    });
  });

  // =========================================================================
  // chat()
  // =========================================================================

  describe('chat()', () => {
    it('should call /api/chat with correct payload', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({
          message: { content: 'Hello!' },
          model: 'llama3.2',
          prompt_eval_count: 10,
          eval_count: 5,
        }),
      );

      const messages = [{ role: 'user' as const, content: 'Hi' }];
      const result = await provider.chat(messages);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:11434/api/chat',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"stream":false'),
        }),
      );

      expect(result.content).toBe('Hello!');
      expect(result.model).toBe('llama3.2');
      expect(result.usage!.promptTokens).toBe(10);
      expect(result.usage!.completionTokens).toBe(5);
      expect(result.usage!.totalTokens).toBe(15);
    });

    it('should use options.model when provided', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({ message: { content: 'ok' }, model: 'mistral', prompt_eval_count: 1, eval_count: 1 }),
      );

      await provider.chat([{ role: 'user', content: 'test' }], { model: 'mistral' });

      const bodyStr = mockFetch.mock.calls[0][1].body;
      expect(JSON.parse(bodyStr).model).toBe('mistral');
    });

    it('should use options.temperature when provided', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({ message: { content: 'ok' }, model: 'llama3.2', prompt_eval_count: 0, eval_count: 0 }),
      );

      await provider.chat([{ role: 'user', content: 'test' }], { temperature: 0.0 });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.options.temperature).toBe(0.0);
    });

    it('should default temperature to 0.7', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({ message: { content: '' }, model: 'llama3.2', prompt_eval_count: 0, eval_count: 0 }),
      );

      await provider.chat([{ role: 'user', content: 'test' }]);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.options.temperature).toBe(0.7);
    });

    it('should handle missing token counts gracefully (default to 0)', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({ message: { content: 'ok' }, model: 'llama3.2' }),
      );

      const result = await provider.chat([{ role: 'user', content: 'test' }]);
      expect(result.usage!.promptTokens).toBe(0);
      expect(result.usage!.completionTokens).toBe(0);
      expect(result.usage!.totalTokens).toBe(0);
    });

    it('should handle empty message content', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({ model: 'llama3.2', prompt_eval_count: 0, eval_count: 0 }),
      );

      const result = await provider.chat([{ role: 'user', content: 'test' }]);
      expect(result.content).toBe('');
    });

    it('should throw on HTTP error response', async () => {
      mockFetch.mockResolvedValue(makeErrorResponse(500, 'Internal Server Error'));

      await expect(
        provider.chat([{ role: 'user', content: 'test' }]),
      ).rejects.toThrow('Ollama API error: 500 - Internal Server Error');
    });

    it('should throw on 404 (model not found)', async () => {
      mockFetch.mockResolvedValue(makeErrorResponse(404, 'model not found'));

      await expect(
        provider.chat([{ role: 'user', content: 'test' }]),
      ).rejects.toThrow('Ollama API error: 404 - model not found');
    });

    it('should throw on network error', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(
        provider.chat([{ role: 'user', content: 'test' }]),
      ).rejects.toThrow('ECONNREFUSED');
    });
  });

  // =========================================================================
  // json()
  // =========================================================================

  describe('json()', () => {
    it('should parse and return JSON response', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({
          message: { content: '{"key":"value"}' },
          model: 'llama3.2',
        }),
      );

      const result = await provider.json<{ key: string }>([
        { role: 'user', content: 'Give me JSON' },
      ]);
      expect(result).toEqual({ key: 'value' });
    });

    it('should add JSON instruction to the last user message', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({ message: { content: '{}' }, model: 'llama3.2' }),
      );

      await provider.json([{ role: 'user', content: 'my prompt' }]);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const lastMsg = body.messages[body.messages.length - 1];
      expect(lastMsg.content).toContain('Respond with valid JSON only');
    });

    it('should NOT modify non-final user messages', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({ message: { content: '{}' }, model: 'llama3.2' }),
      );

      await provider.json([
        { role: 'system', content: 'You are a bot' },
        { role: 'user', content: 'my prompt' },
      ]);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      // System message should be unchanged
      expect(body.messages[0].content).toBe('You are a bot');
    });

    it('should use format:json in Ollama request', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({ message: { content: '{}' }, model: 'llama3.2' }),
      );

      await provider.json([{ role: 'user', content: 'test' }]);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.format).toBe('json');
    });

    it('should default temperature to 0.3 (stricter for JSON)', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({ message: { content: '{}' }, model: 'llama3.2' }),
      );

      await provider.json([{ role: 'user', content: 'test' }]);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.options.temperature).toBe(0.3);
    });

    it('should throw when response content is not valid JSON', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({ message: { content: 'not-json' }, model: 'llama3.2' }),
      );

      await expect(
        provider.json([{ role: 'user', content: 'test' }]),
      ).rejects.toThrow('Failed to parse JSON response: not-json');
    });

    it('should fall back to {} when no content in response', async () => {
      mockFetch.mockResolvedValue(
        makeOkResponse({ message: {}, model: 'llama3.2' }),
      );

      const result = await provider.json([{ role: 'user', content: 'test' }]);
      expect(result).toEqual({});
    });

    it('should throw on HTTP error', async () => {
      mockFetch.mockResolvedValue(makeErrorResponse(503, 'service unavailable'));

      await expect(
        provider.json([{ role: 'user', content: 'test' }]),
      ).rejects.toThrow('Ollama API error: 503 - service unavailable');
    });
  });

  // =========================================================================
  // embed()
  // =========================================================================

  describe('embed()', () => {
    it('should return embedding, model, and dimensions', async () => {
      const embedding = [0.1, 0.2, 0.3, 0.4];
      mockFetch.mockResolvedValue(
        makeOkResponse({ embedding }),
      );

      const result = await provider.embed('hello world');
      expect(result.embedding).toEqual(embedding);
      expect(result.model).toBe('nomic-embed-text');
      expect(result.dimensions).toBe(4);
    });

    it('should call /api/embeddings endpoint', async () => {
      mockFetch.mockResolvedValue(makeOkResponse({ embedding: [0.1] }));

      await provider.embed('test');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:11434/api/embeddings',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('should pass text as "prompt" in the request body', async () => {
      mockFetch.mockResolvedValue(makeOkResponse({ embedding: [0.1] }));

      await provider.embed('test text');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.prompt).toBe('test text');
      expect(body.model).toBe('nomic-embed-text');
    });

    it('should throw informative error when no embedding returned', async () => {
      mockFetch.mockResolvedValue(makeOkResponse({ embedding: null }));

      await expect(provider.embed('test')).rejects.toThrow(
        'No embedding returned',
      );
      await expect(provider.embed('test')).rejects.toThrow('nomic-embed-text');
    });

    it('should throw on HTTP error', async () => {
      mockFetch.mockResolvedValue(makeErrorResponse(404, 'model not found'));

      await expect(provider.embed('test')).rejects.toThrow(
        'Ollama Embedding API error: 404 - model not found',
      );
    });

    it('should use custom baseUrl for embeddings', async () => {
      const customProvider = new OllamaProvider({ provider: 'ollama', model: 'llama3.2', baseUrl: 'http://192.168.1.10:11434' });
      mockFetch.mockResolvedValue(makeOkResponse({ embedding: [0.1] }));

      await customProvider.embed('test');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://192.168.1.10:11434/api/embeddings',
        expect.anything(),
      );
    });
  });
});

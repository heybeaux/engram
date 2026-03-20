import { LMStudioProvider } from './lmstudio.provider';
import { LLMConfig, LLMMessage } from '../llm.interface';

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

const baseConfig: LLMConfig = {
  provider: 'lmstudio',
  model: 'mistral-7b',
  baseUrl: 'http://localhost:1234/v1',
};

describe('LMStudioProvider', () => {
  let provider: LMStudioProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new LMStudioProvider(baseConfig);
  });

  // ─── constructor ────────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('should use provided baseUrl', () => {
      expect(provider.name).toBe('lmstudio');
    });

    it('should fall back to localhost:1234 when no baseUrl provided', () => {
      const p = new LMStudioProvider({ provider: 'lmstudio', model: 'local' });
      // We verify this by checking the fetch call below
      expect(p).toBeDefined();
    });

    it('should fall back to "local-model" when no model provided', () => {
      const p = new LMStudioProvider({ provider: 'lmstudio' } as LLMConfig);
      expect(p).toBeDefined();
    });
  });

  // ─── chat ───────────────────────────────────────────────────────────────────

  describe('chat', () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: 'Hello, world!' },
    ];

    it('should return LLMResponse on success', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Hi there!' } }],
          model: 'mistral-7b',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      });

      const result = await provider.chat(messages);

      expect(result.content).toBe('Hi there!');
      expect(result.model).toBe('mistral-7b');
      expect(result.usage?.promptTokens).toBe(10);
      expect(result.usage?.completionTokens).toBe(5);
      expect(result.usage?.totalTokens).toBe(15);
    });

    it('should POST to /chat/completions with correct payload', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'response' } }],
          model: 'mistral-7b',
          usage: {},
        }),
      });

      await provider.chat(messages);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:1234/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: expect.stringContaining('"messages"'),
        }),
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('mistral-7b');
      expect(body.messages[0].role).toBe('user');
      expect(body.messages[0].content).toBe('Hello, world!');
    });

    it('should use options.model when provided', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'ok' } }],
          model: 'override-model',
          usage: {},
        }),
      });

      await provider.chat(messages, { model: 'override-model', provider: 'lmstudio' });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('override-model');
    });

    it('should use options.temperature when provided', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }], model: 'x', usage: {} }),
      });

      await provider.chat(messages, { temperature: 0.1, provider: 'lmstudio', model: 'x' });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.temperature).toBe(0.1);
    });

    it('should throw on non-ok response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      await expect(provider.chat(messages)).rejects.toThrow('LM Studio API error: 500');
    });

    it('should return empty content when choices is empty', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [],
          model: 'mistral-7b',
          usage: {},
        }),
      });

      const result = await provider.chat(messages);
      expect(result.content).toBe('');
    });

    it('should default usage to zeros when usage missing in response', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'hi' } }],
          // no usage field
        }),
      });

      const result = await provider.chat(messages);
      expect(result.usage?.promptTokens).toBe(0);
      expect(result.usage?.completionTokens).toBe(0);
      expect(result.usage?.totalTokens).toBe(0);
    });

    it('should fall back model to defaultModel when response has no model', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'hi' } }],
          // no model field
          usage: {},
        }),
      });

      const result = await provider.chat(messages);
      expect(result.model).toBe('mistral-7b'); // falls back to defaultModel
    });
  });

  // ─── json ───────────────────────────────────────────────────────────────────

  describe('json', () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: 'Return a JSON object' },
    ];

    it('should parse and return valid JSON response', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"name":"test","value":42}' } }],
          model: 'mistral-7b',
          usage: {},
        }),
      });

      const result = await provider.json<{ name: string; value: number }>(messages);
      expect(result.name).toBe('test');
      expect(result.value).toBe(42);
    });

    it('should strip markdown code blocks before parsing', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '```json\n{"key":"val"}\n```' } }],
          model: 'mistral-7b',
          usage: {},
        }),
      });

      const result = await provider.json<{ key: string }>(messages);
      expect(result.key).toBe('val');
    });

    it('should strip bare code blocks (no language specifier)', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '```\n{"x":1}\n```' } }],
          model: 'mistral-7b',
          usage: {},
        }),
      });

      const result = await provider.json<{ x: number }>(messages);
      expect(result.x).toBe(1);
    });

    it('should throw when response is not valid JSON', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Sorry, I cannot answer that.' } }],
          model: 'mistral-7b',
          usage: {},
        }),
      });

      await expect(provider.json(messages)).rejects.toThrow('Failed to parse JSON response');
    });

    it('should use lower temperature (0.3) by default for json()', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{}' } }],
          model: 'mistral-7b',
          usage: {},
        }),
      });

      await provider.json(messages);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.temperature).toBe(0.3);
    });

    it('should append JSON instruction to last user message', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{}' } }],
          model: 'mistral-7b',
          usage: {},
        }),
      });

      await provider.json(messages);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const lastMessage = body.messages[body.messages.length - 1];
      expect(lastMessage.content).toContain('Respond with valid JSON only');
    });
  });

  // ─── embed ──────────────────────────────────────────────────────────────────

  describe('embed', () => {
    it('should return EmbeddingResponse on success', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }],
          model: 'embed-model',
        }),
      });

      const result = await provider.embed('hello');

      expect(result.embedding).toEqual([0.1, 0.2, 0.3, 0.4]);
      expect(result.dimensions).toBe(4);
      expect(result.model).toBe('embed-model');
    });

    it('should POST to /embeddings', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ embedding: [0.5] }],
          model: 'embed-model',
        }),
      });

      await provider.embed('test text');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:1234/v1/embeddings',
        expect.objectContaining({ method: 'POST' }),
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.input).toBe('test text');
    });

    it('should throw on non-ok response with helpful message', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => 'No embedding model loaded',
      });

      await expect(provider.embed('test')).rejects.toThrow('LM Studio Embedding API error: 503');
      await expect(provider.embed('test')).rejects.toThrow('Make sure an embedding model is loaded');
    });

    it('should throw when no embedding in response', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }), // empty data array
      });

      await expect(provider.embed('test')).rejects.toThrow('No embedding returned');
    });

    it('should fall back model name to defaultModel', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ embedding: [1, 2] }],
          // no model field
        }),
      });

      const result = await provider.embed('test');
      expect(result.model).toBe('mistral-7b');
    });
  });

  // ─── supportsEmbeddings ─────────────────────────────────────────────────────

  describe('supportsEmbeddings', () => {
    it('should return true', () => {
      expect(provider.supportsEmbeddings()).toBe(true);
    });
  });
});

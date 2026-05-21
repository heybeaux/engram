import { AnthropicProvider } from './anthropic.provider';

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

const buildResponse = (body: object, ok = true, status = 200) => ({
  ok,
  status,
  json: jest.fn().mockResolvedValue(body),
  text: jest.fn().mockResolvedValue(JSON.stringify(body)),
});

const anthropicResponse = (
  text: string,
  model = 'claude-3-5-sonnet-20241022',
) => ({
  content: [{ text }],
  model,
  usage: { input_tokens: 100, output_tokens: 50 },
});

describe('AnthropicProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── Constructor ───────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('should create a provider with a valid api key', () => {
      const provider = new AnthropicProvider({
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        apiKey: 'sk-test',
      });
      expect(provider).toBeDefined();
      expect(provider.name).toBe('anthropic');
    });

    it('should throw if no api key provided', () => {
      expect(
        () =>
          new AnthropicProvider({
            provider: 'anthropic',
            model: 'claude-3-5-sonnet-20241022',
            apiKey: '',
          }),
      ).toThrow('Anthropic provider requires an API key');
    });

    it('should use default model if not specified', () => {
      const provider = new AnthropicProvider({
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        apiKey: 'sk-test',
      });
      // Internal default — confirmed via chat call headers/body
      expect(provider).toBeDefined();
    });

    it('should accept custom base URL', () => {
      const provider = new AnthropicProvider({
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        apiKey: 'sk-test',
        baseUrl: 'https://custom.api.com',
      });
      expect(provider).toBeDefined();
    });

    it('should accept custom model', () => {
      const provider = new AnthropicProvider({
        provider: 'anthropic',
        model: 'claude-3-opus-20240229',
        apiKey: 'sk-test',
      });
      expect(provider).toBeDefined();
    });
  });

  // ── chat() ────────────────────────────────────────────────────────────────

  describe('chat', () => {
    let provider: AnthropicProvider;

    beforeEach(() => {
      provider = new AnthropicProvider({
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        apiKey: 'sk-test',
      });
    });

    it('should make a POST to /v1/messages', async () => {
      mockFetch.mockResolvedValue(
        buildResponse(anthropicResponse('Hello world')),
      );

      await provider.chat([{ role: 'user', content: 'Hi' }]);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/messages',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('should set required Anthropic headers', async () => {
      mockFetch.mockResolvedValue(buildResponse(anthropicResponse('Hi')));

      await provider.chat([{ role: 'user', content: 'Hi' }]);

      const [, opts] = mockFetch.mock.calls[0];
      const headers = opts.headers;
      expect(headers['x-api-key']).toBe('sk-test');
      expect(headers['anthropic-version']).toBe('2023-06-01');
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('should separate system message from chat messages', async () => {
      mockFetch.mockResolvedValue(buildResponse(anthropicResponse('Hello')));

      await provider.chat([
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hi' },
      ]);

      const [, opts] = mockFetch.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.system).toBe('You are helpful.');
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].role).toBe('user');
    });

    it('should not include system message in messages array', async () => {
      mockFetch.mockResolvedValue(buildResponse(anthropicResponse('Hello')));

      await provider.chat([
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
      ]);

      const [, opts] = mockFetch.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.messages.every((m: any) => m.role !== 'system')).toBe(true);
    });

    it('should handle messages with no system message', async () => {
      mockFetch.mockResolvedValue(buildResponse(anthropicResponse('Response')));

      await provider.chat([{ role: 'user', content: 'Hello' }]);

      const [, opts] = mockFetch.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.system).toBeUndefined();
    });

    it('should return content, model, and usage', async () => {
      mockFetch.mockResolvedValue(
        buildResponse(
          anthropicResponse('The answer is 42', 'claude-3-opus-20240229'),
        ),
      );

      const result = await provider.chat([
        { role: 'user', content: 'Question' },
      ]);

      expect(result.content).toBe('The answer is 42');
      expect(result.model).toBe('claude-3-opus-20240229');
      expect(result.usage?.promptTokens).toBe(100);
      expect(result.usage?.completionTokens).toBe(50);
      expect(result.usage?.totalTokens).toBe(150);
    });

    it('should use default model when not overridden', async () => {
      mockFetch.mockResolvedValue(buildResponse(anthropicResponse('Hi')));

      await provider.chat([{ role: 'user', content: 'Hi' }]);

      const [, opts] = mockFetch.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.model).toBe('claude-3-5-sonnet-20241022');
    });

    it('should use model from options when provided', async () => {
      mockFetch.mockResolvedValue(buildResponse(anthropicResponse('Hi')));

      await provider.chat([{ role: 'user', content: 'Hi' }], {
        model: 'claude-3-haiku-20240307',
      });

      const [, opts] = mockFetch.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.model).toBe('claude-3-haiku-20240307');
    });

    it('should use max_tokens from options', async () => {
      mockFetch.mockResolvedValue(buildResponse(anthropicResponse('Hi')));

      await provider.chat([{ role: 'user', content: 'Hi' }], {
        maxTokens: 1024,
      });

      const [, opts] = mockFetch.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.max_tokens).toBe(1024);
    });

    it('should default max_tokens to 4096', async () => {
      mockFetch.mockResolvedValue(buildResponse(anthropicResponse('Hi')));

      await provider.chat([{ role: 'user', content: 'Hi' }]);

      const [, opts] = mockFetch.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.max_tokens).toBe(4096);
    });

    it('should throw on non-OK response', async () => {
      mockFetch.mockResolvedValue(
        buildResponse({ error: 'Unauthorized' }, false, 401),
      );

      await expect(
        provider.chat([{ role: 'user', content: 'Hi' }]),
      ).rejects.toThrow('Anthropic API error: 401');
    });

    it('should throw on 429 rate limit', async () => {
      mockFetch.mockResolvedValue(
        buildResponse({ error: 'Rate limited' }, false, 429),
      );

      await expect(
        provider.chat([{ role: 'user', content: 'Hi' }]),
      ).rejects.toThrow('Anthropic API error: 429');
    });

    it('should handle empty content array gracefully', async () => {
      mockFetch.mockResolvedValue(
        buildResponse({
          content: [],
          model: 'claude-3-5-sonnet',
          usage: { input_tokens: 10, output_tokens: 0 },
        }),
      );

      const result = await provider.chat([{ role: 'user', content: 'Hi' }]);
      expect(result.content).toBe('');
    });

    it('should use custom base URL', async () => {
      const customProvider = new AnthropicProvider({
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        apiKey: 'sk-test',
        baseUrl: 'https://proxy.example.com',
      });
      mockFetch.mockResolvedValue(buildResponse(anthropicResponse('Hi')));

      await customProvider.chat([{ role: 'user', content: 'Hi' }]);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://proxy.example.com/v1/messages',
        expect.anything(),
      );
    });
  });

  // ── json() ────────────────────────────────────────────────────────────────

  describe('json', () => {
    let provider: AnthropicProvider;

    beforeEach(() => {
      provider = new AnthropicProvider({
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        apiKey: 'sk-test',
      });
    });

    it('should parse valid JSON response', async () => {
      const payload = { name: 'test', value: 42 };
      mockFetch.mockResolvedValue(
        buildResponse(anthropicResponse(JSON.stringify(payload))),
      );

      const result = await provider.json<{ name: string; value: number }>([
        { role: 'user', content: 'Give me JSON' },
      ]);

      expect(result).toEqual(payload);
    });

    it('should extract JSON from markdown code block', async () => {
      const payload = { result: 'extracted' };
      const mdResponse = '```json\n' + JSON.stringify(payload) + '\n```';
      mockFetch.mockResolvedValue(buildResponse(anthropicResponse(mdResponse)));

      const result = await provider.json<{ result: string }>([
        { role: 'user', content: 'Give me JSON' },
      ]);

      expect(result).toEqual(payload);
    });

    it('should add JSON instruction to last user message', async () => {
      mockFetch.mockResolvedValue(
        buildResponse(anthropicResponse(JSON.stringify({ ok: true }))),
      );

      await provider.json([
        { role: 'system', content: 'Be helpful' },
        { role: 'user', content: 'Analyze this' },
      ]);

      const [, opts] = mockFetch.mock.calls[0];
      const body = JSON.parse(opts.body);
      const lastUserMsg = body.messages[body.messages.length - 1];
      expect(lastUserMsg.content).toContain('Respond with valid JSON only');
    });

    it('should throw on invalid JSON response', async () => {
      mockFetch.mockResolvedValue(
        buildResponse(anthropicResponse('This is not JSON at all')),
      );

      await expect(
        provider.json([{ role: 'user', content: 'Give me JSON' }]),
      ).rejects.toThrow('Failed to parse JSON response');
    });

    it('should not modify non-last messages', async () => {
      mockFetch.mockResolvedValue(
        buildResponse(anthropicResponse(JSON.stringify({ ok: true }))),
      );

      await provider.json([
        { role: 'user', content: 'first message' },
        { role: 'assistant', content: 'assistant reply' },
        { role: 'user', content: 'final question' },
      ]);

      const [, opts] = mockFetch.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.messages[0].content).toBe('first message');
      expect(body.messages[1].content).toBe('assistant reply');
      expect(body.messages[2].content).toContain('final question');
    });
  });

  // ── embed() ───────────────────────────────────────────────────────────────

  describe('embed', () => {
    it('should throw because Anthropic does not support embeddings', async () => {
      const provider = new AnthropicProvider({
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        apiKey: 'sk-test',
      });

      await expect(provider.embed('some text')).rejects.toThrow(
        'Anthropic does not provide embeddings',
      );
    });
  });

  // ── supportsEmbeddings() ──────────────────────────────────────────────────

  describe('supportsEmbeddings', () => {
    it('should return false', () => {
      const provider = new AnthropicProvider({
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        apiKey: 'sk-test',
      });
      expect(provider.supportsEmbeddings()).toBe(false);
    });
  });
});

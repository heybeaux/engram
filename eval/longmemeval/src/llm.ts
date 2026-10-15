/**
 * Anthropic model calls for the reader and judge, behind one transport switch.
 *
 * - `api` (default): POST https://api.anthropic.com/v1/messages with ANTHROPIC_API_KEY.
 * - `claude-cli`: `claude -p` with tools, settings, MCP and session persistence off and
 *   the system prompt replaced (not appended). Used when no API key is available. The
 *   model ID is passed through unchanged; max_tokens cannot be set on this path.
 *
 * Select with LONGMEMEVAL_LLM_TRANSPORT=api|claude-cli.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fetchWithRetry } from './ingest';

export type LlmTransport = 'api' | 'claude-cli';

export interface LlmCall {
  system: string;
  user: string;
  model: string;
  maxTokens: number;
  apiKey: string;
  transport?: LlmTransport;
}

export function resolveTransport(value: string | undefined): LlmTransport {
  if (!value || value === 'api') return 'api';
  if (value === 'claude-cli') return 'claude-cli';
  throw new Error(`Unknown LONGMEMEVAL_LLM_TRANSPORT: ${value}. Use api or claude-cli.`);
}

export async function callClaude(call: LlmCall): Promise<string> {
  return (call.transport ?? 'api') === 'claude-cli' ? callClaudeCli(call) : callClaudeApi(call);
}

async function callClaudeApi(call: LlmCall): Promise<string> {
  const response = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': call.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: call.model,
      max_tokens: call.maxTokens,
      system: call.system,
      messages: [{ role: 'user', content: call.user }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic API call failed: HTTP ${response.status} — ${text}`);
  }

  const data = await response.json() as { content: Array<{ type: string; text: string }> };
  return data.content?.[0]?.text ?? '';
}

/** argv for `claude -p`. Exported for unit testing. */
export function buildClaudeCliArgs(model: string, systemPromptFile: string): string[] {
  return [
    '-p',
    '--model', model,
    '--tools', '',
    '--setting-sources', '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--system-prompt-file', systemPromptFile,
    '--output-format', 'json',
  ];
}

/** Parse `claude -p --output-format json` stdout. Exported for unit testing. */
export function parseClaudeCliOutput(stdout: string): string {
  let parsed: { result?: unknown; is_error?: boolean; subtype?: string };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`claude CLI returned non-JSON output: ${stdout.slice(0, 200)}`);
  }
  if (parsed.is_error || typeof parsed.result !== 'string') {
    throw new Error(`claude CLI error (${parsed.subtype ?? 'unknown'}): ${String(parsed.result ?? '').slice(0, 200)}`);
  }
  return parsed.result;
}

async function callClaudeCli(call: LlmCall, maxAttempts = 3): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lme-llm-'));
  const systemFile = path.join(dir, 'system.txt');
  fs.writeFileSync(systemFile, call.system, 'utf-8');
  let lastError: Error | undefined;
  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const stdout = await runClaude(buildClaudeCliArgs(call.model, systemFile), call.user);
        return parseClaudeCliOutput(stdout);
      } catch (err) {
        lastError = err as Error;
        if (attempt < maxAttempts - 1) {
          await new Promise(r => setTimeout(r, 5000 * (attempt + 1)));
        }
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  throw lastError ?? new Error('claude CLI call failed');
}

function runClaude(args: string[], stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.LONGMEMEVAL_CLAUDE_BIN ?? 'claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGTERM'), 300_000);
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', e => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', code => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString('utf-8');
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`claude CLI exited ${code}: ${Buffer.concat(err).toString('utf-8').slice(0, 300)}`));
        return;
      }
      resolve(stdout);
    });
    child.stdin.end(stdin, 'utf-8');
  });
}

# TypeScript SDK Guide

The official SDK for integrating Engram into your AI agents.

---

## Installation

```bash
npm install @engram/sdk
# or
pnpm add @engram/sdk
# or
yarn add @engram/sdk
```

---

## Quick Start

```typescript
import { Engram } from '@engram/sdk';

// Initialize
const engram = new Engram({
  apiKey: 'eg_sk_your_key_here',
  userId: 'user_123',
  baseUrl: 'http://localhost:3000',  // Your Engram server
});

// Store a memory
await engram.remember("User prefers dark mode");

// Recall memories
const memories = await engram.recall("user preferences");

// Load context for system prompt
const context = await engram.loadContext({ maxTokens: 4000 });
```

---

## Configuration

### Constructor Options

```typescript
const engram = new Engram({
  // Required
  apiKey: string,      // Your API key (eg_sk_...)
  userId: string,      // The end-user's identifier
  
  // Optional
  baseUrl?: string,    // Server URL (default: https://api.engram.ai)
  timeout?: number,    // Request timeout in ms (default: 30000)
  retries?: number,    // Retry attempts (default: 3)
});
```

### Environment Variables

The SDK can also read from environment variables:

```bash
ENGRAM_API_KEY=eg_sk_...
ENGRAM_BASE_URL=http://localhost:3000
```

```typescript
// Reads from env vars automatically
const engram = new Engram({ userId: 'user_123' });
```

---

## Core Methods

### remember()

Store a single memory.

```typescript
remember(text: string, options?: RememberOptions): Promise<Memory>
```

**Basic usage:**

```typescript
const memory = await engram.remember("User is building a SaaS product");
```

**With options:**

```typescript
await engram.remember("Never deploy on Fridays", {
  layer: 'identity',          // 'identity' | 'project' | 'session' | 'task'
  importance: 'critical',     // 'low' | 'medium' | 'high' | 'critical'
  projectId: 'proj_123',
  sessionId: 'sess_456',
});
```

**Options:**

| Option | Type | Description |
|--------|------|-------------|
| `layer` | string | Memory layer |
| `importance` | string | Importance hint |
| `projectId` | string | Associate with project |
| `sessionId` | string | Associate with session |

---

### rememberAll()

Store multiple memories at once.

```typescript
rememberAll(memories: MemoryInput[], options?: BatchOptions): Promise<BatchResult>
```

**Example:**

```typescript
const result = await engram.rememberAll([
  { raw: "Working on auth system" },
  { raw: "Uses OAuth2 with Google" },
  { raw: "Meeting notes from standup" },
], {
  projectId: 'proj_auth',
});

console.log(result.created);  // 3
console.log(result.failed);   // 0
```

**Historical import example:**

When importing past notes or conversation history, pass `observedAt` (ISO 8601) so temporal recall anchors to the original event time. Also set `source` to `"HISTORICAL"`:

```typescript
const result = await engram.rememberAll([
  {
    raw: "Decided to rewrite the auth service after the OAuth2 incident",
    source: "HISTORICAL",
    observedAt: "2025-09-14T11:00:00Z",
  },
  {
    raw: "Shipped v2 dashboard to staging",
    source: "HISTORICAL",
    observedAt: "2025-10-01T16:30:00Z",
  },
], {
  projectId: 'proj_auth',
});
```

If `source` is `"HISTORICAL"` but `observedAt` is missing, the response for that item includes `warnings: [{ code: "HISTORICAL_WITHOUT_ANCHOR" }]` — temporal extraction is skipped and the ingest time is used as the fallback anchor.

**Use cases:**
- Import conversation history
- Bulk onboarding
- Migration from other systems

---

### recall()

Semantic search for memories.

```typescript
recall(query: string, options?: RecallOptions): Promise<QueryResult>
```

**Basic usage:**

```typescript
const result = await engram.recall("authentication");

for (const memory of result.memories) {
  console.log(memory.raw);
  console.log(`Score: ${memory.importanceScore}`);
}
```

**With filters:**

```typescript
const result = await engram.recall("user preferences", {
  layers: ['identity', 'project'],
  limit: 5,
  projectId: 'proj_123',
  includeChains: true,
});
```

**Options:**

| Option | Type | Description |
|--------|------|-------------|
| `layers` | string[] | Filter by memory layers |
| `limit` | number | Max results (default: 10) |
| `projectId` | string | Filter by project |
| `includeChains` | boolean | Include reasoning chains |

**Response:**

```typescript
interface QueryResult {
  memories: Memory[];
  queryTokens: number;
  latencyMs: number;
}
```

---

### loadContext()

Load formatted context for session start.

```typescript
loadContext(options?: ContextOptions): Promise<ContextResult>
```

**Example:**

```typescript
const { context, tokenCount } = await engram.loadContext({
  maxTokens: 4000,
  projectId: 'proj_dashboard',
});

// Use in system prompt
const systemPrompt = `You are a helpful assistant.

## User Context
${context}

Assist the user with their request.`;
```

**Options:**

| Option | Type | Description |
|--------|------|-------------|
| `maxTokens` | number | Token budget (default: 4000) |
| `projectId` | string | Include project memories |
| `sessionId` | string | Include session memories |

**Response:**

```typescript
interface ContextResult {
  context: string;        // Formatted markdown string
  tokenCount: number;     // Estimated tokens used
  memoriesIncluded: number;
  layers: {
    identity: number;
    project: number;
    session: number;
  };
}
```

---

### getMemory()

Get a single memory by ID.

```typescript
getMemory(id: string): Promise<Memory | null>
```

```typescript
const memory = await engram.getMemory('clx1abc123');
if (memory) {
  console.log(memory.raw);
  console.log(memory.extraction?.topics);
}
```

---

### deleteMemory()

Soft-delete a memory.

```typescript
deleteMemory(id: string): Promise<void>
```

```typescript
await engram.deleteMemory('clx1abc123');
```

---

## Feedback Methods

### used()

Mark a memory as used (implicit feedback).

```typescript
used(memoryId: string): Promise<void>
```

```typescript
// After using a memory in your response
await engram.used(memory.id);
```

This signals that the memory was relevant, boosting its importance score.

---

### helpful()

Mark a memory as helpful (explicit feedback).

```typescript
helpful(memoryId: string): Promise<void>
```

```typescript
// When user confirms memory was useful
await engram.helpful(memory.id);
```

---

### correct()

Correct an inaccurate memory.

```typescript
correct(memoryId: string, correction: string): Promise<Memory>
```

```typescript
// User says: "Actually, I prefer light mode"
const corrected = await engram.correct(
  memory.id,
  "User prefers light mode with high contrast"
);
```

This creates a new memory and marks the original as superseded.

---

## Types

### Memory

```typescript
interface Memory {
  id: string;
  userId: string;
  raw: string;
  layer: 'IDENTITY' | 'PROJECT' | 'SESSION' | 'TASK';
  source: 'EXPLICIT_STATEMENT' | 'AGENT_OBSERVATION' | 'CORRECTION' | 'PATTERN_DETECTED' | 'SYSTEM';
  importanceHint?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  importanceScore: number;
  confidence: number;
  retrievalCount: number;
  usedCount: number;
  createdAt: string;
  updatedAt: string;
  extraction?: MemoryExtraction;
}
```

### MemoryExtraction

```typescript
interface MemoryExtraction {
  who: string | null;
  what: string | null;
  when: string | null;
  whereCtx: string | null;
  why: string | null;
  how: string | null;
  topics: string[];
}
```

---

## Integration Patterns

### With OpenAI

```typescript
import OpenAI from 'openai';
import { Engram } from '@engram/sdk';

const openai = new OpenAI();
const engram = new Engram({
  apiKey: process.env.ENGRAM_API_KEY!,
  userId: 'user_123',
});

async function chat(userMessage: string) {
  // 1. Load context
  const { context } = await engram.loadContext({ maxTokens: 3000 });

  // 2. Recall relevant memories
  const { memories } = await engram.recall(userMessage, { limit: 5 });

  // 3. Build system prompt
  const systemPrompt = `You are a helpful assistant.

## User Context
${context}

## Relevant Memories
${memories.map(m => `- ${m.raw}`).join('\n')}
`;

  // 4. Call OpenAI
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
  });

  // 5. Store new facts from conversation
  await engram.remember(`User asked about: ${userMessage.slice(0, 100)}`);

  // 6. Mark used memories
  for (const memory of memories) {
    await engram.used(memory.id);
  }

  return response.choices[0].message.content;
}
```

### With LangChain

```typescript
import { ChatOpenAI } from '@langchain/openai';
import { Engram } from '@engram/sdk';

const engram = new Engram({
  apiKey: process.env.ENGRAM_API_KEY!,
  userId: 'user_123',
});

// Custom retriever using Engram
class EngramRetriever {
  async retrieve(query: string) {
    const { memories } = await engram.recall(query, { limit: 5 });
    return memories.map(m => ({
      pageContent: m.raw,
      metadata: { id: m.id, layer: m.layer },
    }));
  }
}

// Use in RAG chain
const retriever = new EngramRetriever();
const docs = await retriever.retrieve("user preferences");
```

### Session Management

```typescript
async function handleConversation(sessionId: string, messages: Message[]) {
  const engram = new Engram({
    apiKey: process.env.ENGRAM_API_KEY!,
    userId: 'user_123',
  });

  // At session start
  const { context } = await engram.loadContext({
    maxTokens: 4000,
    sessionId,
  });

  // During conversation
  for (const msg of messages) {
    // Extract facts from user messages
    if (msg.role === 'user' && containsFact(msg.content)) {
      await engram.remember(msg.content, {
        layer: 'session',
        sessionId,
      });
    }
  }

  // At session end - store important takeaways
  await engram.remember("Session summary: discussed auth implementation", {
    layer: 'project',
    importance: 'medium',
  });
}
```

---

## Error Handling

The SDK throws typed errors:

```typescript
import { Engram, EngramError, AuthenticationError, RateLimitError } from '@engram/sdk';

try {
  await engram.remember("test");
} catch (error) {
  if (error instanceof AuthenticationError) {
    console.error("Invalid API key");
  } else if (error instanceof RateLimitError) {
    console.error(`Rate limited. Retry after ${error.retryAfter}s`);
  } else if (error instanceof EngramError) {
    console.error(`Engram error: ${error.message}`);
  }
}
```

### Error Types

| Error | Description |
|-------|-------------|
| `EngramError` | Base error class |
| `AuthenticationError` | Invalid or missing API key |
| `RateLimitError` | Rate limit exceeded |
| `ValidationError` | Invalid request parameters |
| `NotFoundError` | Memory not found |

---

## Retry & Timeout

The SDK automatically retries failed requests:

```typescript
const engram = new Engram({
  apiKey: '...',
  userId: 'user_123',
  timeout: 30000,   // 30 second timeout
  retries: 3,       // Retry up to 3 times
});
```

Retries use exponential backoff and only retry on:
- Network errors
- 5xx server errors
- 429 rate limit (after waiting)

---

## Best Practices

### 1. Store Facts, Not Conversations

```typescript
// ❌ Don't store raw conversation
await engram.remember("User: What's the weather? Assistant: It's sunny!");

// ✅ Store extracted facts
await engram.remember("User asked about weather in San Francisco");
await engram.remember("User's location is San Francisco", { layer: 'identity' });
```

### 2. Use Appropriate Layers

```typescript
// Identity: permanent facts
await engram.remember("User is a software developer", { layer: 'identity' });

// Project: workstream context
await engram.remember("Dashboard v2 uses React", { layer: 'project' });

// Session: conversation context
await engram.remember("Currently debugging login issue", { layer: 'session' });

// Task: immediate, short-lived
await engram.remember("Looking at line 142 of auth.ts", { layer: 'task' });
```

### 3. Provide Feedback

```typescript
// Always mark used memories
const { memories } = await engram.recall(query);
for (const m of memories) {
  await engram.used(m.id);
}

// Mark helpful when explicitly confirmed
if (userSaysHelpful) {
  await engram.helpful(memory.id);
}
```

### 4. Handle Token Budgets

```typescript
// Calculate available tokens
const maxContextTokens = 8000;
const systemPromptTokens = 500;
const responseBuffer = 2000;

const availableForMemory = maxContextTokens - systemPromptTokens - responseBuffer;

const { context } = await engram.loadContext({
  maxTokens: availableForMemory,
});
```

### 5. Batch When Possible

```typescript
// ❌ Multiple individual calls
for (const fact of facts) {
  await engram.remember(fact);
}

// ✅ Single batch call
await engram.rememberAll(facts.map(f => ({ raw: f })));
```

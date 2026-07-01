# Agent Reflection Endpoint

## Overview

The Agent Reflection endpoint allows AI agents to create memories about themselves through introspection on recent conversations. This enables agent self-awareness, learning from mistakes, and continuity across sessions.

## Endpoint

```
POST /v1/agents/:agentId/reflect
```

### Path Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `agentId` | string | Unique identifier for the agent (e.g., "rook", "openclaw-agent") |

### Request Body

```json
{
  "recentTurns": [
    {
      "role": "user" | "assistant",
      "content": "The message content",
      "timestamp": "2026-02-03T18:00:00Z"  // Optional
    }
  ],
  "agentName": "Rook",           // Optional: Agent's name for personalized extraction
  "minImportance": 0.5,          // Optional: Threshold for memory creation (0-1, default 0.5)
  "maxMemories": 5               // Optional: Max memories to create per reflection (1-10, default 5)
}
```

### Response

```json
{
  "memoriesCreated": ["mem-abc123", "mem-def456"],
  "insightsExtracted": 3,
  "categories": {
    "identity": 1,
    "lessons": 1,
    "preferences": 1,
    "workingStyle": 0
  }
}
```

## Memory Categories

The reflection process extracts four types of self-knowledge:

### 1. Identity
Facts about who the agent is: name, role, capabilities, personality traits.

**Examples:**
- "I am Rook, an AI assistant created by Beaux"
- "I have access to web search and file management capabilities"
- "My role is to be a helpful and proactive assistant"

### 2. Lessons Learned
Mistakes made, corrections received, better approaches discovered.

**Examples:**
- "I should verify data before marking tasks as complete"
- "I learned that the Friday deploy rule is absolute - no exceptions"
- "I made an error when I assumed the API response format"

### 3. User Preferences Discovered
What the agent learned about how the user likes to work.

**Examples:**
- "Beaux prefers concise responses over verbose explanations"
- "User wants WhatsApp notifications for important updates"
- "User likes dark mode for all applications"

### 4. Working Style
Patterns in how the agent operates effectively.

**Examples:**
- "I work better when I break complex tasks into smaller steps"
- "I should ask clarifying questions before making assumptions"
- "My approach to debugging is to check logs first"

## OpenClaw Integration

### When to Call Reflect

Trigger reflection at meaningful points:

```typescript
// At the end of significant sessions
async function onSessionEnd(session: Session) {
  if (session.turns.length > 10) {
    await engramClient.post(`/v1/agents/${AGENT_ID}/reflect`, {
      recentTurns: session.turns.slice(-20),
      agentName: 'Rook',
    });
  }
}

// After receiving corrections
async function onCorrection(turn: Turn) {
  if (turn.content.includes('actually') || turn.content.includes('no,')) {
    await engramClient.post(`/v1/agents/${AGENT_ID}/reflect`, {
      recentTurns: recentTurns.slice(-10),
      minImportance: 0.7,  // Higher threshold for corrections
    });
  }
}

// Periodically during heartbeats
async function onHeartbeat() {
  const turns = await getRecentTurns(20);
  if (turns.length > 5) {
    await engramClient.post(`/v1/agents/${AGENT_ID}/reflect`, {
      recentTurns: turns,
      maxMemories: 2,  // Light reflection
    });
  }
}
```

### Retrieving Agent Context

Include agent self-knowledge in system prompts:

```typescript
// Get agent context for prompt injection
const { context } = await engramClient.get(`/v1/agents/${AGENT_ID}/context`);

const systemPrompt = `
${baseSystemPrompt}

## Agent Self-Knowledge
${context}
`;
```

## Additional Endpoints

### Get Agent Memories

```
GET /v1/agents/:agentId/memories
```

Query Parameters:
- `layer`: Filter by memory layer (IDENTITY, PROJECT, SESSION)
- `limit`: Maximum number of memories to return

### Get Agent Context

```
GET /v1/agents/:agentId/context
```

Query Parameters:
- `maxTokens`: Maximum tokens for context (default: 2000)

Returns formatted context ready for system prompt injection.

## Schema

Agent self-memories are stored with:

```typescript
{
  subjectType: 'AGENT',        // Memory is ABOUT the agent
  subjectId: agentId,          // Agent identifier
  agentId: agentId,            // Creating agent
  source: 'AGENT_REFLECTION',  // Memory source
  layer: 'IDENTITY' | 'PROJECT',  // Based on category
}
```

## Best Practices

1. **Don't over-reflect**: Call sparingly at meaningful points, not after every message
2. **Include context**: Send enough conversation turns (10-20) for meaningful extraction
3. **Set appropriate thresholds**: Use higher `minImportance` for corrections (0.7+)
4. **Limit memory creation**: Use `maxMemories` to prevent flooding
5. **Include agent name**: Helps personalize extracted insights

## Example: Full Integration

> The TypeScript client source lives in [heybeaux/engram-client](https://github.com/heybeaux/engram-client) and currently declares the package name `@openengram/client`, but npm publish is still pending registry authentication. Install it from source or adapt this example to direct REST calls until the package is released.

```typescript
import { EngramClient } from '@openengram/client';

const engram = new EngramClient({
  baseUrl: 'https://engram.example.com',
  apiKey: process.env.ENGRAM_API_KEY,
});

class AgentMemoryManager {
  private agentId: string;
  private agentName: string;
  private turnBuffer: Turn[] = [];

  constructor(agentId: string, agentName: string) {
    this.agentId = agentId;
    this.agentName = agentName;
  }

  // Add turn to buffer
  addTurn(turn: Turn) {
    this.turnBuffer.push(turn);
    if (this.turnBuffer.length > 50) {
      this.turnBuffer = this.turnBuffer.slice(-50);
    }
  }

  // Trigger reflection
  async reflect(options?: { minImportance?: number; maxMemories?: number }) {
    if (this.turnBuffer.length < 5) return;

    const result = await engram.post(`/v1/agents/${this.agentId}/reflect`, {
      recentTurns: this.turnBuffer.slice(-20),
      agentName: this.agentName,
      ...options,
    });

    console.log(`Created ${result.memoriesCreated.length} agent memories`);
    return result;
  }

  // Get context for prompt
  async getContext(maxTokens = 2000): Promise<string> {
    const { context } = await engram.get(
      `/v1/agents/${this.agentId}/context?maxTokens=${maxTokens}`
    );
    return context;
  }
}
```

## Related

- [Memory API](./memory-api.md) - Core memory storage and retrieval
- [OpenClaw Integration](./openclaw-integration.md) - Full integration guide

import { Injectable, Optional } from '@nestjs/common';
import { ServicePrismaService } from '../../prisma/service-prisma.service';
import { LLMService } from '../../llm/llm.service';
import { ConfigService } from '@nestjs/config';

export interface IdentityStageResult {
  snapshotId: string | null;
  capabilitiesExtracted: number;
  preferencesExtracted: number;
  behavioralTraits: number;
  llmCalls: number;
}

export interface IdentitySnapshotData {
  capabilities: Array<{
    name: string;
    confidence: number;
    lastSeen: string;
  }>;
  preferences: Record<string, string>;
  trustScores: Record<string, number>;
  behavioralTraits: Array<{
    trait: string;
    strength: number;
    evidence: string;
  }>;
}

/**
 * HEY-176: Dream Cycle Identity Consolidation Stage
 *
 * During the dream cycle, extracts and consolidates identity-relevant
 * information from memories to build structured identity snapshots.
 *
 * Extracts:
 * - Capability profile (what the agent/user can do)
 * - Preference summary (what they prefer)
 * - Trust score trends (reliability patterns)
 * - Behavioral patterns (how they typically act)
 *
 * Outputs IdentitySnapshot records that persist across sessions.
 */
@Injectable()
export class DreamCycleIdentityStage {
  private readonly maxSourceMemories: number;

  constructor(
    private readonly prisma: ServicePrismaService,
    private readonly llm: LLMService,
    private readonly config: ConfigService,
  ) {
    this.maxSourceMemories = parseInt(
      this.config.get('DREAM_IDENTITY_MAX_MEMORIES') ?? '100',
      10,
    );
  }

  async run(
    userId: string,
    dryRun: boolean,
    remainingLlmBudget: number,
    dreamReportId?: string,
  ): Promise<IdentityStageResult> {
    if (remainingLlmBudget < 1) {
      return this.emptyResult();
    }

    // 1. Gather identity-relevant memories
    const memories = await this.gatherIdentityMemories(userId);

    if (memories.length < 5) {
      console.log(
        `[DreamCycle:Identity] Insufficient memories (${memories.length}) for identity consolidation`,
      );
      return this.emptyResult();
    }

    // 2. Fetch previous snapshot for delta comparison
    const previousSnapshot = await this.prisma.identitySnapshot.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    // 3. Extract identity data via LLM
    const identityData = await this.extractIdentity(memories, previousSnapshot);

    if (dryRun) {
      console.log(
        `[DreamCycle:Identity] DRY RUN — would create snapshot with ` +
          `${identityData.capabilities.length} capabilities, ` +
          `${Object.keys(identityData.preferences).length} preferences, ` +
          `${identityData.behavioralTraits.length} traits`,
      );
      return {
        snapshotId: null,
        capabilitiesExtracted: identityData.capabilities.length,
        preferencesExtracted: Object.keys(identityData.preferences).length,
        behavioralTraits: identityData.behavioralTraits.length,
        llmCalls: 1,
      };
    }

    // 4. Create identity snapshot
    const snapshot = await this.prisma.identitySnapshot.create({
      data: {
        userId,
        capabilities: identityData.capabilities as any,
        preferences: identityData.preferences as any,
        trustScores: identityData.trustScores as any,
        behavioralTraits: identityData.behavioralTraits as any,
        sourceMemoryIds: memories.map((m) => m.id).slice(0, 50),
        dreamReportId,
      },
    });

    // 5. Mark source memories as processed by dream cycle
    await this.prisma.memory.updateMany({
      where: { id: { in: memories.map((m) => m.id) }, userId },
      data: { lastDreamCycleAt: new Date() },
    });

    console.log(
      `[DreamCycle:Identity] Created snapshot ${snapshot.id}: ` +
        `${identityData.capabilities.length} capabilities, ` +
        `${Object.keys(identityData.preferences).length} preferences, ` +
        `${identityData.behavioralTraits.length} traits`,
    );

    return {
      snapshotId: snapshot.id,
      capabilitiesExtracted: identityData.capabilities.length,
      preferencesExtracted: Object.keys(identityData.preferences).length,
      behavioralTraits: identityData.behavioralTraits.length,
      llmCalls: 1,
    };
  }

  /**
   * Gather memories most relevant to identity consolidation:
   * - IDENTITY layer memories
   * - CONSTRAINT and PREFERENCE type memories
   * - Agent self-memories (subjectType = AGENT)
   * - INSIGHT memories (behavioral observations)
   * - Recent high-importance memories
   */
  private async gatherIdentityMemories(userId: string) {
    const memories = await this.prisma.memory.findMany({
      where: {
        userId,
        deletedAt: null,
        OR: [
          { layer: 'IDENTITY' },
          { memoryType: { in: ['CONSTRAINT', 'PREFERENCE'] } },
          { subjectType: 'AGENT' },
          { layer: 'INSIGHT' },
          {
            effectiveScore: { gte: 0.7 },
            createdAt: {
              gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
            },
          },
        ],
      },
      orderBy: [{ effectiveScore: 'desc' }, { createdAt: 'desc' }],
      take: this.maxSourceMemories,
      select: {
        id: true,
        raw: true,
        layer: true,
        memoryType: true,
        subjectType: true,
        agentId: true,
        source: true,
        effectiveScore: true,
        createdAt: true,
        metadata: true,
      },
    });

    return memories;
  }

  private async extractIdentity(
    memories: Array<{
      id: string;
      raw: string;
      layer: string;
      memoryType: string | null;
      subjectType: string;
      agentId: string | null;
      createdAt: Date;
    }>,
    previousSnapshot: any | null,
  ): Promise<IdentitySnapshotData> {
    const memorySummary = memories
      .slice(0, 60)
      .map(
        (m) =>
          `[${m.layer}${m.memoryType ? '/' + m.memoryType : ''}${m.agentId ? ' agent:' + m.agentId : ''}] ` +
          `(${m.createdAt.toISOString().slice(0, 10)}): ${m.raw.slice(0, 200)}`,
      )
      .join('\n');

    const previousContext = previousSnapshot
      ? `\nPREVIOUS IDENTITY SNAPSHOT (${new Date(previousSnapshot.createdAt).toISOString().slice(0, 10)}):\n` +
        `Capabilities: ${JSON.stringify(previousSnapshot.capabilities)}\n` +
        `Preferences: ${JSON.stringify(previousSnapshot.preferences)}\n` +
        `Behavioral traits: ${JSON.stringify(previousSnapshot.behavioralTraits)}\n`
      : '';

    const response = await this.llm.chat(
      [
        {
          role: 'system',
          content: `You are an identity consolidation engine for Engram, an AI memory system. Your job is to extract a structured identity profile from a set of memories.

Extract:
1. **Capabilities**: What can this agent/user do? Skills, tools, domains of expertise. Include confidence (0-1) and when last demonstrated.
2. **Preferences**: Stable preferences and working style. Key-value pairs.
3. **Trust scores**: Reliability patterns by domain/source (0-1 scale).
4. **Behavioral traits**: Recurring behavioral patterns with strength (0-1) and evidence.

If a previous snapshot exists, UPDATE it — don't start from scratch. Add new capabilities, revise confidence scores, note any changes in preferences.

Respond in JSON:
{
  "capabilities": [
    { "name": "TypeScript development", "confidence": 0.9, "lastSeen": "2025-01-15" }
  ],
  "preferences": {
    "code_style": "functional with types",
    "communication": "concise and direct"
  },
  "trustScores": {
    "code_review": 0.85,
    "memory_accuracy": 0.9
  },
  "behavioralTraits": [
    { "trait": "prefers incremental PRs", "strength": 0.8, "evidence": "5 recent PRs all under 200 lines" }
  ]
}

Be specific. Use real data from the memories. Don't invent traits that aren't evidenced.`,
        },
        {
          role: 'user',
          content: `MEMORIES FOR IDENTITY CONSOLIDATION:\n${memorySummary}${previousContext}\n\nExtract the structured identity profile.`,
        },
      ],
      {
        provider: 'openai',
        model: 'gpt-4o-mini',
        temperature: 0.3,
        maxTokens: 1500,
      },
    );

    try {
      return this.parseJsonResponse(response.content);
    } catch {
      console.warn(
        '[DreamCycle:Identity] Failed to parse LLM response, returning empty snapshot',
      );
      return {
        capabilities: [],
        preferences: {},
        trustScores: {},
        behavioralTraits: [],
      };
    }
  }

  private parseJsonResponse(content: string): IdentitySnapshotData {
    try {
      return JSON.parse(content);
    } catch {
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[1]);
      }
      throw new Error('Could not parse JSON');
    }
  }

  private emptyResult(): IdentityStageResult {
    return {
      snapshotId: null,
      capabilitiesExtracted: 0,
      preferencesExtracted: 0,
      behavioralTraits: 0,
      llmCalls: 0,
    };
  }
}

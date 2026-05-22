import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LoadContextDto } from './dto/query-memory.dto';
import { Memory, MemoryLayer, SubjectType } from '@prisma/client';
import { ContextResult } from './memory.types';
import { ChainOfNoteService } from './chain-of-note.service';
import { toStructuredItem } from './dto/structured-recall.dto';

@Injectable()
export class MemoryQueryContextService {
  private readonly logger = new Logger(MemoryQueryContextService.name);

  constructor(
    private prisma: PrismaService,
    @Optional() private readonly chainOfNote?: ChainOfNoteService,
  ) {}

  /**
   * Load context for session start
   */
  async loadContext(
    userId: string,
    dto: LoadContextDto,
  ): Promise<ContextResult> {
    const layers: ContextResult['layers'] = {
      identity: 0,
      project: 0,
      session: 0,
    };
    const memories: Memory[] = [];
    const evictions: Array<{ id: string; reason: string }> = [];

    const LAYER_BUDGETS = {
      identity: dto.maxTokens ? Math.floor(dto.maxTokens * 0.44) : 800,
      project: dto.maxTokens ? Math.floor(dto.maxTokens * 0.33) : 600,
      session: dto.maxTokens ? Math.floor(dto.maxTokens * 0.22) : 400,
    };
    const CONSTRAINT_RESERVE = Math.min(
      200,
      Math.floor(LAYER_BUDGETS.identity * 0.25),
    );

    // Fire all independent layer queries in parallel for lower latency
    const identityPromise = this.prisma.memory.findMany({
      where: {
        userId,
        layer: MemoryLayer.IDENTITY,
        subjectType: SubjectType.USER,
        deletedAt: null,
        supersededById: null,
        searchable: { not: false },
        userHidden: false,
      },
      orderBy: [
        { effectiveScore: 'desc' },
        { confidence: 'desc' },
        { priority: 'asc' },
        { userPinned: 'desc' },
        { createdAt: 'desc' },
      ],
      take: 200,
    });

    const projectPromise = dto.projectId
      ? this.prisma.memory.findMany({
          where: {
            userId,
            projectId: dto.projectId,
            layer: MemoryLayer.PROJECT,
            deletedAt: null,
            supersededById: null,
            searchable: { not: false },
            userHidden: false,
          },
          orderBy: [
            { effectiveScore: 'desc' },
            { confidence: 'desc' },
            { priority: 'asc' },
            { userPinned: 'desc' },
            { createdAt: 'desc' },
          ],
          take: 100,
        })
      : Promise.resolve([]);

    const sessionPromise = this.prisma.memory.findMany({
      where: {
        userId,
        layer: MemoryLayer.SESSION,
        deletedAt: null,
        supersededById: null,
        searchable: { not: false },
        userHidden: false,
        createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      },
      orderBy: [
        { effectiveScore: 'desc' },
        { confidence: 'desc' },
        { priority: 'asc' },
        { createdAt: 'desc' },
      ],
      take: 100,
    });

    const agentPromise = dto.agentId
      ? this.prisma.memory.findMany({
          where: {
            agentId: dto.agentId,
            subjectType: SubjectType.AGENT,
            deletedAt: null,
            supersededById: null,
            searchable: { not: false },
            userHidden: false,
          },
          orderBy: [
            { effectiveScore: 'desc' },
            { priority: 'asc' },
            { createdAt: 'desc' },
          ],
          take: 20,
        })
      : Promise.resolve([]);

    const [
      identityCandidates,
      projectCandidates,
      sessionCandidates,
      agentMemories,
    ] = await Promise.all([
      identityPromise,
      projectPromise,
      sessionPromise,
      agentPromise,
    ]);

    // 1. Process IDENTITY layer
    const { selected: identityMemories, evicted: identityEvicted } =
      this.selectMemoriesForBudget(
        identityCandidates,
        LAYER_BUDGETS.identity,
        CONSTRAINT_RESERVE,
      );
    memories.push(...identityMemories);
    layers.identity = identityMemories.length;
    evictions.push(
      ...identityEvicted.map((m) => ({ id: m.id, reason: 'identity_budget' })),
    );

    // 2. Process PROJECT layer
    if (dto.projectId && projectCandidates.length > 0) {
      const { selected: projectMemories, evicted: projectEvicted } =
        this.selectMemoriesForBudget(
          projectCandidates,
          LAYER_BUDGETS.project,
          0,
        );
      memories.push(...projectMemories);
      layers.project = projectMemories.length;
      evictions.push(
        ...projectEvicted.map((m) => ({ id: m.id, reason: 'project_budget' })),
      );
    }

    // 3. Process SESSION layer
    const { selected: sessionMemories, evicted: sessionEvicted } =
      this.selectMemoriesForBudget(sessionCandidates, LAYER_BUDGETS.session, 0);
    memories.push(...sessionMemories);
    layers.session = sessionMemories.length;
    evictions.push(
      ...sessionEvicted.map((m) => ({ id: m.id, reason: 'session_budget' })),
    );

    // 4. Process agent self-memories
    if (agentMemories.length > 0) {
      memories.push(...agentMemories);
      layers.agent = agentMemories.length;
    }

    // 5. Format
    const context = this.formatContext(memories, dto.maxTokens ?? 4000);

    if (evictions.length > 0) {
      this.logger.log('[Memory] Context evictions:', {
        userId,
        totalEvicted: evictions.length,
        byReason: evictions.reduce(
          (acc, e) => {
            acc[e.reason] = (acc[e.reason] || 0) + 1;
            return acc;
          },
          {} as Record<string, number>,
        ),
      });
    }

    // HEY-576: When chainOfNote=true, replace the flat context with a CoN prompt
    let contextText = context.text;
    if (dto.chainOfNote && this.chainOfNote && memories.length > 0) {
      const structuredItems = memories.map(toStructuredItem);
      contextText = this.chainOfNote.buildPrompt(
        structuredItems,
        dto.query ?? '',
      );
    }

    return {
      context: contextText,
      tokenCount: context.tokens,
      memoriesIncluded: memories.length,
      layers,
    };
  }

  /**
   * Select memories that fit within a token budget
   */
  selectMemoriesForBudget(
    candidates: Memory[],
    budget: number,
    constraintReserve: number,
  ): { selected: Memory[]; evicted: Memory[] } {
    const selected: Memory[] = [];
    const evicted: Memory[] = [];
    let usedTokens = 0;

    const estimateTokens = (m: Memory) => Math.ceil(m.raw.length / 4);

    // Phase 0: Safety-critical
    const safetyCritical = candidates.filter((m) => m.safetyCritical);
    for (const memory of safetyCritical) {
      const tokens = estimateTokens(memory);
      selected.push(memory);
      usedTokens += tokens;
    }

    // Phase 1: CONSTRAINTS
    const constraints = candidates.filter(
      (m) => m.priority === 1 && !m.safetyCritical,
    );
    let constraintTokens = 0;

    for (const memory of constraints) {
      const tokens = estimateTokens(memory);
      if (
        constraintTokens + tokens <= constraintReserve ||
        constraintReserve === 0
      ) {
        selected.push(memory);
        constraintTokens += tokens;
        usedTokens += tokens;
      } else if (usedTokens + tokens <= budget) {
        selected.push(memory);
        usedTokens += tokens;
      } else {
        evicted.push(memory);
      }
    }

    // Phase 2: Fill remaining
    for (const memory of candidates) {
      if (selected.includes(memory)) continue;
      const tokens = estimateTokens(memory);
      if (usedTokens + tokens <= budget) {
        selected.push(memory);
        usedTokens += tokens;
      } else {
        evicted.push(memory);
      }
    }

    return { selected, evicted };
  }

  formatContext(
    memories: Memory[],
    maxTokens: number,
  ): { text: string; tokens: number } {
    const lines: string[] = [];
    let estimatedTokens = 0;

    const identity = memories.filter((m) => m.layer === MemoryLayer.IDENTITY);
    const project = memories.filter((m) => m.layer === MemoryLayer.PROJECT);
    const session = memories.filter((m) => m.layer === MemoryLayer.SESSION);

    if (identity.length > 0) {
      lines.push('## User Identity');
      for (const m of identity) {
        const line = `- ${m.raw}`;
        const tokens = line.split(/\s+/).length;
        if (estimatedTokens + tokens > maxTokens) break;
        lines.push(line);
        estimatedTokens += tokens;
      }
      lines.push('');
    }

    if (project.length > 0) {
      lines.push('## Current Project');
      for (const m of project) {
        const line = `- ${m.raw}`;
        const tokens = line.split(/\s+/).length;
        if (estimatedTokens + tokens > maxTokens) break;
        lines.push(line);
        estimatedTokens += tokens;
      }
      lines.push('');
    }

    if (session.length > 0) {
      lines.push('## Recent Context');
      for (const m of session) {
        const line = `- ${m.raw}`;
        const tokens = line.split(/\s+/).length;
        if (estimatedTokens + tokens > maxTokens) break;
        lines.push(line);
        estimatedTokens += tokens;
      }
    }

    return {
      text: lines.join('\n'),
      tokens: estimatedTokens,
    };
  }
}

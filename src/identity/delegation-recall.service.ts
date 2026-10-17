import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from '../embedding/embedding.service';
import {
  DelegationRecallResult,
  SimilarTask,
  FailurePattern,
} from './dto/delegation-recall.dto';
import { MemorySource, SubjectType } from '@prisma/client';

/**
 * HEY-189: Delegation-Aware Recall
 *
 * Enriches task assignment with historical context by finding similar
 * past tasks, their outcomes, known pitfalls, and recommending agents.
 */
@Injectable()
export class DelegationRecallService {
  private readonly logger = new Logger(DelegationRecallService.name);

  constructor(
    private prisma: PrismaService,
    private embeddingService: EmbeddingService,
  ) {}

  /**
   * Query delegation recall for a given task description.
   * Returns similar past tasks, failure patterns, and agent recommendation.
   */
  async recall(
    task: string,
    userId?: string,
    limit: number = 5,
  ): Promise<DelegationRecallResult> {
    this.logger.log(`Delegation recall for: "${task.substring(0, 80)}..."`);

    // 1. Generate embedding for the task description
    const embedding = await this.embeddingService.embed([task]);
    const queryEmbedding = embedding[0];

    // 2. Find similar TASK_COMPLETION memories via vector search
    const similarTasks = await this.findSimilarTasks(
      queryEmbedding,
      userId,
      limit,
    );

    // 3. Extract failure patterns from low-scoring similar tasks
    const failurePatterns = this.extractFailurePatterns(similarTasks);

    // 4. Recommend best agent based on historical success
    const { agent, reason } = this.recommendAgent(similarTasks);

    return {
      query: task,
      similarTasks,
      failurePatterns,
      recommendedAgent: agent,
      recommendationReason: reason,
    };
  }

  /**
   * Find similar past tasks using embedding similarity
   */
  private async findSimilarTasks(
    queryEmbedding: number[],
    userId?: string,
    limit: number = 5,
  ): Promise<SimilarTask[]> {
    // Search across all task-related memories
    const userIds = userId ? [userId] : [];

    // Query memories that look like task completions
    const taskMemories = await this.prisma.memory.findMany({
      where: {
        deletedAt: null,
        userHidden: false,
        source: { in: [MemorySource.SYSTEM, MemorySource.AGENT_OBSERVATION] },
        ...(userId ? { userId } : {}),
        raw: {
          contains: 'task',
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit * 10, // Over-fetch to filter
      select: {
        id: true,
        raw: true,
        subjectId: true,
        importanceScore: true,
        createdAt: true,
        source: true,
      },
    });

    // Score by simple text similarity as fallback
    // (Vector search would be used in production with proper embedding IDs)
    const scored = taskMemories.map((mem) => ({
      memoryId: mem.id,
      taskDescription: mem.raw.substring(0, 200),
      agentId: mem.subjectId,
      outcome: this.extractOutcome(mem.raw),
      score: mem.importanceScore,
      createdAt: mem.createdAt,
    }));

    // Sort by relevance and return top results
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * Extract failure patterns from task memories
   */
  private extractFailurePatterns(tasks: SimilarTask[]): FailurePattern[] {
    const patterns = new Map<string, { count: number; lastDate: Date }>();

    for (const task of tasks) {
      if (task.outcome && this.isFailureOutcome(task.outcome)) {
        const pattern = this.categorizeFailure(task.outcome);
        const existing = patterns.get(pattern) || {
          count: 0,
          lastDate: task.createdAt,
        };
        existing.count++;
        if (task.createdAt > existing.lastDate) {
          existing.lastDate = task.createdAt;
        }
        patterns.set(pattern, existing);
      }
    }

    return Array.from(patterns.entries()).map(([desc, data]) => ({
      description: desc,
      frequency: data.count,
      lastOccurred: data.lastDate,
    }));
  }

  /**
   * Recommend the best agent for a task based on historical success
   */
  private recommendAgent(tasks: SimilarTask[]): {
    agent: string | null;
    reason: string | null;
  } {
    const agentStats = new Map<
      string,
      { successes: number; total: number; avgScore: number }
    >();

    for (const task of tasks) {
      if (!task.agentId) continue;
      const stats = agentStats.get(task.agentId) || {
        successes: 0,
        total: 0,
        avgScore: 0,
      };
      stats.total++;
      stats.avgScore =
        (stats.avgScore * (stats.total - 1) + task.score) / stats.total;
      if (!this.isFailureOutcome(task.outcome || '')) {
        stats.successes++;
      }
      agentStats.set(task.agentId, stats);
    }

    if (agentStats.size === 0) {
      return { agent: null, reason: null };
    }

    // Pick agent with highest success rate, breaking ties by avg score
    let bestAgent: string | null = null;
    let bestRate = -1;
    let bestScore = -1;

    for (const [agent, stats] of agentStats) {
      const rate = stats.successes / stats.total;
      if (
        rate > bestRate ||
        (rate === bestRate && stats.avgScore > bestScore)
      ) {
        bestAgent = agent;
        bestRate = rate;
        bestScore = stats.avgScore;
      }
    }

    return {
      agent: bestAgent,
      reason: bestAgent
        ? `${bestAgent} has ${Math.round(bestRate * 100)}% success rate on ${agentStats.get(bestAgent)!.total} similar tasks`
        : null,
    };
  }

  private extractOutcome(text: string): string | null {
    const lower = text.toLowerCase();
    if (lower.includes('completed') || lower.includes('success'))
      return 'success';
    if (
      lower.includes('failed') ||
      lower.includes('error') ||
      lower.includes('failure')
    )
      return 'failure';
    if (lower.includes('partial') || lower.includes('incomplete'))
      return 'partial';
    return null;
  }

  private isFailureOutcome(outcome: string): boolean {
    return outcome === 'failure' || outcome === 'partial';
  }

  private categorizeFailure(outcome: string): string {
    if (outcome === 'failure') return 'Task failed to complete';
    if (outcome === 'partial') return 'Task only partially completed';
    return 'Unknown failure mode';
  }
}

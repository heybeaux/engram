import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryLayer, MemorySource, SubjectType } from '@prisma/client';
import {
  CreateTaskOutcomeDto,
  TaskOutcomeResponseDto,
} from './dto/identity.dto';

/**
 * HEY-177: Task Outcome Memory Type
 *
 * Stores structured task completion records as TASK_OUTCOME memories.
 * Metadata schema: { taskDescription, outcome, durationMs, lessonsLearned, capabilitiesUsed }
 */
@Injectable()
export class TaskOutcomeService {
  constructor(private prisma: PrismaService) {}

  /**
   * Create a task outcome memory record
   */
  async create(
    userId: string,
    agentId: string,
    dto: CreateTaskOutcomeDto,
  ): Promise<TaskOutcomeResponseDto> {
    const metadata = {
      taskDescription: dto.taskDescription,
      outcome: dto.outcome,
      durationMs: dto.durationMs ?? null,
      lessonsLearned: dto.lessonsLearned ?? [],
      capabilitiesUsed: dto.capabilitiesUsed ?? [],
    };

    const raw = `Task completed: ${dto.taskDescription} — outcome: ${dto.outcome}${
      dto.lessonsLearned?.length
        ? `. Lessons: ${dto.lessonsLearned.join('; ')}`
        : ''
    }`;

    const memory = await this.prisma.memory.create({
      data: {
        userId,
        agentId,
        raw,
        layer: MemoryLayer.TASK,
        memoryType: 'TASK_OUTCOME',
        subjectType: SubjectType.AGENT,
        subjectId: agentId,
        source: MemorySource.AGENT_REFLECTION,
        priority: 3,
        metadata,
        createdBySession: dto.agentSessionKey,
      },
    });

    return {
      id: memory.id,
      taskDescription: dto.taskDescription,
      outcome: dto.outcome,
      durationMs: dto.durationMs,
      lessonsLearned: dto.lessonsLearned,
      capabilitiesUsed: dto.capabilitiesUsed,
      createdAt: memory.createdAt,
    };
  }

  /**
   * List task outcomes for an agent
   */
  async list(
    userId: string,
    agentId: string,
    limit = 50,
  ): Promise<TaskOutcomeResponseDto[]> {
    const memories = await this.prisma.memory.findMany({
      where: {
        userId,
        agentId,
        memoryType: 'TASK_OUTCOME',
        deletedAt: null,
        userHidden: false,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return memories.map((m) => {
      const meta = (m.metadata as any) ?? {};
      return {
        id: m.id,
        taskDescription: meta.taskDescription ?? m.raw,
        outcome: meta.outcome ?? 'partial',
        durationMs: meta.durationMs,
        lessonsLearned: meta.lessonsLearned,
        capabilitiesUsed: meta.capabilitiesUsed,
        createdAt: m.createdAt,
      };
    });
  }

  /**
   * Detect task completion patterns in text (for extraction pipeline integration)
   * Returns structured outcome data if task completion language is detected.
   */
  static detectTaskCompletion(
    raw: string,
  ): Partial<CreateTaskOutcomeDto> | null {
    const completionPatterns = [
      /(?:completed|finished|done with|wrapped up)\s+(?:the\s+)?(.+?)(?:\.|$)/i,
      /task\s+(?:completed|done|finished):\s*(.+?)(?:\.|$)/i,
      /successfully\s+(?:completed|deployed|built|implemented)\s+(.+?)(?:\.|$)/i,
    ];

    for (const pattern of completionPatterns) {
      const match = raw.match(pattern);
      if (match) {
        const outcome: 'success' | 'partial' | 'failure' =
          /fail|error|broke|didn't work/i.test(raw)
            ? 'failure'
            : /partial|mostly|some issues/i.test(raw)
              ? 'partial'
              : 'success';

        return {
          taskDescription: match[1].trim(),
          outcome,
        };
      }
    }
    return null;
  }
}

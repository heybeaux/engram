import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryLayer, MemorySource, SubjectType } from '@prisma/client';
import {
  CreateSelfAssessmentDto,
  SelfAssessmentResponseDto,
} from './dto/identity.dto';

/**
 * HEY-180: Self-Assessment Memories
 *
 * Allows agents to store self-evaluations of their performance,
 * confidence levels, and growth areas as SELF_ASSESSMENT memories.
 */
@Injectable()
export class SelfAssessmentService {
  constructor(private prisma: PrismaService) {}

  /**
   * Create a self-assessment memory
   */
  async create(
    userId: string,
    agentId: string,
    dto: CreateSelfAssessmentDto,
  ): Promise<SelfAssessmentResponseDto> {
    const metadata = {
      area: dto.area,
      selfRating: dto.selfRating,
      confidence: dto.confidence,
      evidence: dto.evidence ?? [],
      goals: dto.goals ?? [],
    };

    const raw =
      `Self-assessment for ${dto.area}: rating ${dto.selfRating}/10 (confidence: ${dto.confidence}). ${
        dto.goals?.length ? `Goals: ${dto.goals.join('; ')}` : ''
      }`.trim();

    const memory = await this.prisma.memory.create({
      data: {
        userId,
        agentId,
        raw,
        layer: MemoryLayer.IDENTITY,
        memoryType: 'SELF_ASSESSMENT',
        subjectType: SubjectType.AGENT,
        subjectId: agentId,
        source: MemorySource.AGENT_REFLECTION,
        priority: 3,
        metadata,
      },
    });

    return {
      id: memory.id,
      area: dto.area,
      selfRating: dto.selfRating,
      confidence: dto.confidence ?? 0,
      evidence: dto.evidence,
      goals: dto.goals,
      createdAt: memory.createdAt,
    };
  }

  /**
   * List self-assessments, optionally filtered by area
   */
  async list(
    userId: string,
    agentId: string,
    options?: { area?: string; limit?: number },
  ): Promise<SelfAssessmentResponseDto[]> {
    const memories = await this.prisma.memory.findMany({
      where: {
        userId,
        agentId,
        memoryType: 'SELF_ASSESSMENT',
        deletedAt: null,
        userHidden: false,
      },
      orderBy: { createdAt: 'desc' },
      take: options?.limit ?? 50,
    });

    return memories
      .map((m) => {
        const meta = (m.metadata as any) ?? {};
        return {
          id: m.id,
          area: meta.area ?? 'unknown',
          selfRating: meta.selfRating ?? 0,
          confidence: meta.confidence ?? 0,
          evidence: meta.evidence,
          goals: meta.goals,
          createdAt: m.createdAt,
        };
      })
      .filter((a) => !options?.area || a.area === options.area);
  }

  /**
   * Get the latest self-assessment per area (current snapshot)
   */
  async getLatestByArea(
    userId: string,
    agentId: string,
  ): Promise<SelfAssessmentResponseDto[]> {
    const all = await this.list(userId, agentId, { limit: 500 });

    // Keep only the most recent per area
    const byArea = new Map<string, SelfAssessmentResponseDto>();
    for (const assessment of all) {
      if (!byArea.has(assessment.area)) {
        byArea.set(assessment.area, assessment);
      }
    }
    return Array.from(byArea.values());
  }
}

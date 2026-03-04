import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryLayer, MemoryType, SubjectType } from '@prisma/client';
import { TaskOutcomeService } from './task-outcome.service';
import { SelfAssessmentService } from './self-assessment.service';
import { CapabilityProfileService } from './capability-profile.service';
import { WorkStyleService } from './work-style.service';
import {
  CreateTaskOutcomeDto,
  TaskOutcomeResponseDto,
  CreateSelfAssessmentDto,
  SelfAssessmentResponseDto,
  CapabilityProfileResponseDto,
  IdentityProfileResponseDto,
  PreferenceDto,
  TrustSignalsSummaryDto,
  BehavioralPatternDto,
  ActiveProjectsResponseDto,
  ActiveProjectDto,
} from './dto/identity.dto';

// Patterns that indicate preferences (HEY-171)
const PREFERENCE_PATTERNS: Array<{
  regex: RegExp;
  strength: 'weak' | 'moderate' | 'strong';
}> = [
  { regex: /\bi\s+prefer\s+(.{3,100}?)(?:\.|,|$)/i, strength: 'strong' },
  {
    regex: /\balways\s+(?:use|uses?)\s+(.{3,80}?)(?:\.|,|$)/i,
    strength: 'strong',
  },
  {
    regex: /\bnever\s+(?:use|uses?)\s+(.{3,80}?)(?:\.|,|$)/i,
    strength: 'strong',
  },
  {
    regex: /\bi?\s*(?:don't|doesn't|do not)\s+like\s+(.{3,80}?)(?:\.|,|$)/i,
    strength: 'moderate',
  },
  {
    regex: /\bi?\s*(?:like|enjoy)\s+(.{3,80}?)(?:\.|,|$)/i,
    strength: 'moderate',
  },
  {
    regex: /\bfavorite\s+(?:\w+\s+)?is\s+(.{3,80}?)(?:\.|,|$)/i,
    strength: 'strong',
  },
  { regex: /\busually\s+(.{3,80}?)(?:\.|,|$)/i, strength: 'weak' },
];

/**
 * Orchestrates all identity profile features.
 * Coordinates between task outcomes, self-assessments, capability profiles,
 * work style tracking, preferences (HEY-171), and trust signals.
 */
@Injectable()
export class IdentityService {
  constructor(
    private prisma: PrismaService,
    private taskOutcome: TaskOutcomeService,
    private selfAssessment: SelfAssessmentService,
    private capabilityProfile: CapabilityProfileService,
    private workStyle: WorkStyleService,
  ) {}

  /**
   * Record a task outcome and cascade updates to capability profiles and work style
   */
  async recordTaskOutcome(
    userId: string,
    agentId: string,
    dto: CreateTaskOutcomeDto,
  ): Promise<TaskOutcomeResponseDto> {
    const result = await this.taskOutcome.create(userId, agentId, dto);

    if (dto.capabilitiesUsed?.length) {
      await this.capabilityProfile.updateFromTaskOutcome(agentId, userId, {
        capabilitiesUsed: dto.capabilitiesUsed,
        outcome: dto.outcome,
        durationMs: dto.durationMs,
        lessonsLearned: dto.lessonsLearned,
      });
    }

    await this.workStyle.extractFromTaskOutcome(agentId, userId, {
      durationMs: dto.durationMs,
      capabilitiesUsed: dto.capabilitiesUsed,
      outcome: dto.outcome,
    });

    return result;
  }

  /**
   * Record a self-assessment
   */
  async recordSelfAssessment(
    userId: string,
    agentId: string,
    dto: CreateSelfAssessmentDto,
  ): Promise<SelfAssessmentResponseDto> {
    return this.selfAssessment.create(userId, agentId, dto);
  }

  /**
   * Get the full identity profile for an agent (HEY-178)
   * Now includes preferences (HEY-171), trust signals, and behavioral patterns
   */
  async getIdentityProfile(
    agentId: string,
    userId: string,
  ): Promise<IdentityProfileResponseDto> {
    // Look up agent record for name/createdAt
    const agent = await this.prisma.agent.findFirst({
      where: {
        OR: [{ id: agentId }, { name: agentId }],
        deletedAt: null,
      },
    });

    const [capabilities, workStyleDims, selfAssessments, recentOutcomes] =
      await Promise.all([
        this.capabilityProfile
          .getProfile(agentId, userId)
          .catch(() => ({ agentId, capabilities: [] })),
        this.workStyle.getWorkStyle(agentId, userId).catch(() => []),
        this.selfAssessment.getLatestByArea(userId, agentId).catch(() => []),
        this.taskOutcome.list(userId, agentId, 20).catch(() => []),
      ]);

    // HEY-171: Extract preferences from memory data
    const preferences = await this.extractPreferencesFromMemories(
      agentId,
      userId,
    );

    // HEY-178: Build trust signals
    const trustSignals = await this.buildTrustSignals(agentId, userId);

    // HEY-178: Extract behavioral patterns
    const recentPatterns = await this.extractBehavioralPatterns(
      agentId,
      userId,
    );

    return {
      agentId: agent?.id ?? agentId,
      name: agent?.name,
      createdAt: agent?.createdAt?.toISOString(),
      capabilities: capabilities.capabilities,
      preferences,
      workStyle: workStyleDims,
      selfAssessments,
      recentOutcomes,
      trustSignals,
      recentPatterns,
    };
  }

  /**
   * Get capability profile only
   */
  async getCapabilities(
    agentId: string,
    userId: string,
  ): Promise<CapabilityProfileResponseDto> {
    return this.capabilityProfile.getProfile(agentId, userId);
  }

  // ── HEY-171: Preference Memory Layer ──────────────────────────────

  /**
   * Extract preferences from IDENTITY/PREFERENCE memories
   */
  private async extractPreferencesFromMemories(
    agentId: string,
    userId: string,
  ): Promise<PreferenceDto[]> {
    const memories = await this.prisma.memory.findMany({
      where: {
        OR: [
          // Agent self-memories with preference type
          {
            agentId,
            memoryType: 'PREFERENCE',
            deletedAt: null,
          },
          // IDENTITY layer memories that might contain preferences
          {
            userId,
            layer: MemoryLayer.IDENTITY,
            memoryType: 'PREFERENCE',
            deletedAt: null,
          },
        ],
      },
      include: { extraction: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    const preferences: PreferenceDto[] = [];
    const seen = new Set<string>();

    for (const memory of memories) {
      // 1. Check structured metadata first
      if (memory.metadata && typeof memory.metadata === 'object') {
        const meta = memory.metadata as any;
        if (meta.preferenceCategory && meta.preference) {
          const key =
            `${meta.preferenceCategory}:${meta.preference}`.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            preferences.push({
              category: meta.preferenceCategory,
              preference: meta.preference,
              strength: meta.preferenceStrength || 'moderate',
              source: memory.raw.substring(0, 100),
            });
          }
          continue;
        }
      }

      // 2. Pattern-based extraction
      if (!memory.raw) continue;
      for (const { regex, strength } of PREFERENCE_PATTERNS) {
        const match = memory.raw.match(regex);
        if (match && match[1]) {
          const pref = match[1].trim().substring(0, 150);
          const key = pref.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            preferences.push({
              category: this.inferPreferenceCategory(memory.raw),
              preference: pref,
              strength,
              source: memory.raw.substring(0, 100),
            });
          }
        }
      }

      // 3. Fallback: use extraction.what for PREFERENCE type memories
      if (!seen.has(memory.id) && memory.extraction?.what) {
        seen.add(memory.id);
        preferences.push({
          category: this.inferPreferenceCategory(memory.raw),
          preference: memory.extraction.what,
          strength: 'moderate',
          source: memory.raw.substring(0, 100),
        });
      }
    }

    return preferences.slice(0, 30);
  }

  /**
   * Build trust signals summary from memory data
   */
  private async buildTrustSignals(
    agentId: string,
    userId: string,
  ): Promise<TrustSignalsSummaryDto> {
    const memories = await this.prisma.memory.findMany({
      where: {
        OR: [
          { agentId, deletedAt: null },
          { userId, subjectId: agentId, deletedAt: null },
        ],
      },
      select: {
        layer: true,
        memoryType: true,
        confidence: true,
        createdAt: true,
      },
    });

    const dates = memories.map((m) => m.createdAt);
    const confidences = memories
      .map((m) => m.confidence)
      .filter((c) => c != null);

    return {
      totalMemories: memories.length,
      identityMemories: memories.filter((m) => m.layer === 'IDENTITY').length,
      lessonMemories: memories.filter((m) => m.memoryType === 'LESSON').length,
      constraintMemories: memories.filter((m) => m.memoryType === 'CONSTRAINT')
        .length,
      averageConfidence:
        confidences.length > 0
          ? Math.round(
              (confidences.reduce((a, b) => a + b, 0) / confidences.length) *
                100,
            ) / 100
          : 0,
      oldestMemory:
        dates.length > 0
          ? new Date(Math.min(...dates.map((d) => d.getTime()))).toISOString()
          : null,
      newestMemory:
        dates.length > 0
          ? new Date(Math.max(...dates.map((d) => d.getTime()))).toISOString()
          : null,
    };
  }

  /**
   * Extract recent behavioral patterns from memory creation patterns
   */
  private async extractBehavioralPatterns(
    agentId: string,
    userId: string,
  ): Promise<BehavioralPatternDto[]> {
    const recentMemories = await this.prisma.memory.findMany({
      where: {
        OR: [{ agentId }, { userId, subjectId: agentId }],
        deletedAt: null,
        createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      },
      include: { extraction: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    const patterns: BehavioralPatternDto[] = [];

    // Count topics
    const topicCounts = new Map<string, number>();
    for (const memory of recentMemories) {
      if (memory.extraction?.topics) {
        for (const topic of memory.extraction.topics) {
          topicCounts.set(topic, (topicCounts.get(topic) || 0) + 1);
        }
      }
    }

    for (const [topic, count] of topicCounts.entries()) {
      if (count >= 2) {
        patterns.push({
          pattern: `Frequently works on: ${topic}`,
          frequency: count,
          category: 'topic',
        });
      }
    }

    // Count memory types
    const typeCounts = new Map<string, number>();
    for (const memory of recentMemories) {
      if (memory.memoryType) {
        typeCounts.set(
          memory.memoryType,
          (typeCounts.get(memory.memoryType) || 0) + 1,
        );
      }
    }

    for (const [type, count] of typeCounts.entries()) {
      if (count >= 2) {
        patterns.push({
          pattern: `Creates ${type.toLowerCase()} memories frequently`,
          frequency: count,
          category: 'memory_type',
        });
      }
    }

    return patterns.sort((a, b) => b.frequency - a.frequency).slice(0, 15);
  }

  /**
   * Infer preference category from text
   */
  private inferPreferenceCategory(text: string): string {
    const lower = text.toLowerCase();
    if (
      /\b(code|programming|language|framework|library|tool|editor|ide)\b/.test(
        lower,
      )
    )
      return 'tooling';
    if (/\b(ui|ux|design|theme|dark|light|color|font)\b/.test(lower))
      return 'interface';
    if (/\b(coffee|tea|food|drink|meal)\b/.test(lower)) return 'food';
    if (/\b(communicate|email|slack|message|call|meeting)\b/.test(lower))
      return 'communication';
    if (/\b(deploy|ci|cd|pipeline|workflow|process)\b/.test(lower))
      return 'workflow';
    return 'general';
  }
}

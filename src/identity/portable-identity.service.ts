import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  PortableIdentityExport,
  CapabilityProfile,
  TrustProfile,
  WorkHistorySummary,
  CollaborationPattern,
} from './dto/portable-identity.dto';
import { SubjectType, MemorySource } from '@prisma/client';
import * as crypto from 'crypto';

const SCHEMA_VERSION = '1.0.0';

/**
 * Deterministic JSON serialization with recursive key sorting.
 * Ensures identical objects always produce the same string regardless of key order.
 */
function deterministicStringify(value: any): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return (
      '[' + value.map((item) => deterministicStringify(item)).join(',') + ']'
    );
  }
  const keys = Object.keys(value).sort();
  const pairs = keys.map(
    (key) => JSON.stringify(key) + ':' + deterministicStringify(value[key]),
  );
  return '{' + pairs.join(',') + '}';
}

/**
 * HEY-190: Portable Agent Identity
 *
 * Export and import agent identity profiles for cross-platform portability.
 * Includes capabilities, preferences, trust profile, work history, and
 * collaboration patterns with integrity verification via hash signing.
 */
@Injectable()
export class PortableIdentityService {
  private readonly logger = new Logger(PortableIdentityService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Export an agent's full identity profile
   */
  async exportIdentity(agentId: string): Promise<PortableIdentityExport> {
    this.logger.log(`Exporting identity for agent: ${agentId}`);

    const [
      capabilities,
      preferences,
      trustProfile,
      workHistory,
      collaborationPatterns,
      agentName,
    ] = await Promise.all([
      this.buildCapabilityProfile(agentId),
      this.buildPreferences(agentId),
      this.buildTrustProfile(agentId),
      this.buildWorkHistorySummary(agentId),
      this.buildCollaborationPatterns(agentId),
      this.getAgentName(agentId),
    ]);

    const exportData: Omit<PortableIdentityExport, 'integrityHash'> = {
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      agentId,
      agentName,
      capabilities,
      preferences,
      trustProfile,
      workHistorySummary: workHistory,
      collaborationPatterns,
    };

    // Sign with integrity hash
    const integrityHash = this.computeHash(exportData);

    return { ...exportData, integrityHash };
  }

  /**
   * Import an agent identity, verifying integrity
   */
  async importIdentity(
    identity: PortableIdentityExport,
    targetAgentId?: string,
  ): Promise<{ agentId: string; memoriesCreated: number }> {
    // Verify integrity hash
    const { integrityHash, ...data } = identity;
    const expectedHash = this.computeHash(data);

    if (integrityHash !== expectedHash) {
      throw new BadRequestException(
        'Identity integrity check failed — export may have been tampered with',
      );
    }

    // Verify schema version compatibility
    if (!this.isCompatibleVersion(identity.schemaVersion)) {
      throw new BadRequestException(
        `Unsupported schema version: ${identity.schemaVersion}. Current: ${SCHEMA_VERSION}`,
      );
    }

    const agentId = targetAgentId || identity.agentId;
    this.logger.log(`Importing identity for agent: ${agentId}`);

    // Create memories from the imported identity
    let memoriesCreated = 0;

    // Import capabilities as agent memories
    for (const cap of identity.capabilities) {
      await this.prisma.memory.create({
        data: {
          userId: agentId,
          raw: `Agent capability: ${cap.name} (score: ${cap.score}, evidence: ${cap.evidenceCount})`,
          layer: 'IDENTITY',
          subjectType: SubjectType.AGENT,
          subjectId: agentId,
          source: MemorySource.SYSTEM,
          importanceScore: cap.score,
          effectiveScore: cap.score,
        },
      });
      memoriesCreated++;
    }

    // Import trust profile as a summary memory
    await this.prisma.memory.create({
      data: {
        userId: agentId,
        raw: `Imported trust profile: ${identity.trustProfile.totalTasks} tasks, ${Math.round(identity.trustProfile.successRate * 100)}% success rate, specializations: ${identity.trustProfile.specializations.join(', ')}`,
        layer: 'IDENTITY',
        subjectType: SubjectType.AGENT,
        subjectId: agentId,
        source: MemorySource.SYSTEM,
        importanceScore: 0.8,
        effectiveScore: 0.8,
      },
    });
    memoriesCreated++;

    return { agentId, memoriesCreated };
  }

  /**
   * Build capability profile from structured task outcomes and persisted capability profiles.
   * Falls back to task completion domain aggregation when no capability profiles exist.
   */
  private async buildCapabilityProfile(
    agentId: string,
  ): Promise<CapabilityProfile[]> {
    // Primary: use persisted AgentCapabilityProfile records
    const profiles = await this.prisma.agentCapabilityProfile.findMany({
      where: { agentId },
      orderBy: { confidence: 'desc' },
    });

    if (profiles.length > 0) {
      return profiles.map((p) => ({
        name: p.capability,
        score: Math.round(p.confidence * 100) / 100,
        evidenceCount: p.evidenceCount,
      }));
    }

    // Fallback: aggregate from TaskCompletion domain field
    const completions = await this.prisma.taskCompletion.findMany({
      where: { delegatedTo: agentId },
      select: { domain: true, outcome: true },
    });

    const capMap = new Map<
      string,
      { successCount: number; totalCount: number }
    >();
    for (const tc of completions) {
      const domain = tc.domain || 'general';
      const existing = capMap.get(domain) || {
        successCount: 0,
        totalCount: 0,
      };
      existing.totalCount++;
      if (tc.outcome === 'success') existing.successCount++;
      capMap.set(domain, existing);
    }

    return Array.from(capMap.entries())
      .map(([name, data]) => ({
        name,
        score: Math.round((data.successCount / data.totalCount) * 100) / 100,
        evidenceCount: data.totalCount,
      }))
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Build preferences from agent memories
   */
  private async buildPreferences(
    agentId: string,
  ): Promise<Record<string, any>> {
    const memories = await this.prisma.memory.findMany({
      where: {
        subjectType: SubjectType.AGENT,
        subjectId: agentId,
        memoryType: 'PREFERENCE',
        deletedAt: null,
      },
      take: 50,
    });

    const prefs: Record<string, any> = {};
    for (const mem of memories) {
      prefs[mem.id] = mem.raw;
    }
    return prefs;
  }

  /**
   * Build trust profile from task completion history
   */
  private async buildTrustProfile(agentId: string): Promise<TrustProfile> {
    const taskMemories = await this.prisma.memory.findMany({
      where: {
        subjectId: agentId,
        source: { in: [MemorySource.SYSTEM, MemorySource.AGENT_OBSERVATION] },
        deletedAt: null,
      },
      select: { importanceScore: true, raw: true },
    });

    const totalTasks = taskMemories.length;
    const successfulTasks = taskMemories.filter(
      (m) =>
        m.raw.toLowerCase().includes('success') ||
        m.raw.toLowerCase().includes('completed'),
    ).length;

    const avgQuality =
      totalTasks > 0
        ? taskMemories.reduce((s, m) => s + m.importanceScore, 0) / totalTasks
        : 0;

    // Extract specializations from high-scoring memories
    const specializations = await this.extractSpecializations(agentId);

    return {
      totalTasks,
      successRate:
        totalTasks > 0
          ? Math.round((successfulTasks / totalTasks) * 100) / 100
          : 0,
      avgResponseQuality: Math.round(avgQuality * 100) / 100,
      specializations,
    };
  }

  /**
   * Build work history summary
   */
  private async buildWorkHistorySummary(
    agentId: string,
  ): Promise<WorkHistorySummary> {
    const [totalMemories, taskCompletions, reflections, oldest, typeCounts] =
      await Promise.all([
        this.prisma.memory.count({
          where: { subjectId: agentId, deletedAt: null },
        }),
        this.prisma.memory.count({
          where: {
            subjectId: agentId,
            source: MemorySource.SYSTEM,
            deletedAt: null,
          },
        }),
        this.prisma.memory.count({
          where: {
            subjectId: agentId,
            source: MemorySource.AGENT_REFLECTION,
            deletedAt: null,
          },
        }),
        this.prisma.memory.findFirst({
          where: { subjectId: agentId, deletedAt: null },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        }),
        this.prisma.memory.groupBy({
          by: ['memoryType'],
          where: {
            subjectId: agentId,
            deletedAt: null,
            memoryType: { not: null },
          },
          _count: true,
          orderBy: { _count: { memoryType: 'desc' } },
        }),
      ]);

    return {
      totalMemories,
      taskCompletions,
      reflections,
      activeSince: oldest?.createdAt?.toISOString() || new Date().toISOString(),
      topCategories: typeCounts.map((tc) => ({
        category: tc.memoryType || 'unknown',
        count: tc._count,
      })),
    };
  }

  /**
   * Build collaboration patterns
   */
  private async buildCollaborationPatterns(
    agentId: string,
  ): Promise<CollaborationPattern[]> {
    // Find memories that reference other agents
    const memories = await this.prisma.memory.findMany({
      where: {
        subjectId: agentId,
        deletedAt: null,
        source: MemorySource.SYSTEM,
      },
      select: { raw: true, importanceScore: true },
      take: 200,
    });

    // Extract partner agent IDs from memory text (simple heuristic)
    const partnerStats = new Map<
      string,
      { count: number; totalScore: number }
    >();

    for (const mem of memories) {
      const partners = this.extractPartnerAgents(mem.raw, agentId);
      for (const partner of partners) {
        const stats = partnerStats.get(partner) || { count: 0, totalScore: 0 };
        stats.count++;
        stats.totalScore += mem.importanceScore;
        partnerStats.set(partner, stats);
      }
    }

    return Array.from(partnerStats.entries()).map(([partnerId, stats]) => ({
      partnerAgentId: partnerId,
      interactionCount: stats.count,
      avgOutcomeScore: Math.round((stats.totalScore / stats.count) * 100) / 100,
    }));
  }

  private async getAgentName(agentId: string): Promise<string> {
    const agent = await this.prisma.agent.findFirst({
      where: { id: agentId },
      select: { name: true },
    });
    return agent?.name || agentId;
  }

  private async extractSpecializations(agentId: string): Promise<string[]> {
    // Use structured capability profiles instead of keyword matching
    const profiles = await this.prisma.agentCapabilityProfile.findMany({
      where: { agentId },
      orderBy: { confidence: 'desc' },
      take: 5,
      select: { capability: true },
    });

    if (profiles.length > 0) {
      return profiles.map((p) => p.capability);
    }

    // Fallback: derive from task completion domains
    const domains = await this.prisma.taskCompletion.groupBy({
      by: ['domain'],
      where: { delegatedTo: agentId, domain: { not: null } },
      _count: true,
      orderBy: { _count: { domain: 'desc' } },
      take: 5,
    });

    return domains.map((d) => d.domain!);
  }

  private extractPartnerAgents(text: string, selfId: string): string[] {
    // Look for agent ID patterns in text
    const agentPattern = /\b(agent[-_]\w+|\w+-agent)\b/gi;
    const matches = text.match(agentPattern) || [];
    return [...new Set(matches.filter((m) => m !== selfId))];
  }

  /**
   * Compute SHA-256 hash for integrity verification.
   * Uses deterministic JSON serialization with recursive key sorting.
   */
  computeHash(data: any): string {
    const json = deterministicStringify(data);
    return crypto.createHash('sha256').update(json).digest('hex');
  }

  /**
   * Check schema version compatibility (major version must match)
   */
  private isCompatibleVersion(version: string): boolean {
    const [major] = version.split('.');
    const [currentMajor] = SCHEMA_VERSION.split('.');
    return major === currentMajor;
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProfileDto } from './dto/create-profile.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { CreateAttributeDto } from './dto/create-attribute.dto';
import { UpdateAttributeDto } from './dto/update-attribute.dto';
import { ListProfilesDto } from './dto/list-profiles.dto';
import { AttributeType } from '@prisma/client';

@Injectable()
export class EntityProfileService {
  constructor(private readonly prisma: PrismaService) {}

  // ── helpers ──────────────────────────────────────────────────────────

  /**
   * Resolve all user IDs belonging to an account (for multi-agent scoping).
   */
  async resolveAccountUserIds(accountId: string): Promise<string[]> {
    const users = await this.prisma.user.findMany({
      where: { accountId, deletedAt: null },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  /**
   * Get or create a default user for the agent's account.
   */
  async getOrCreateUser(agentId: string): Promise<string> {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: { accountId: true },
    });
    if (!agent?.accountId) throw new NotFoundException(`Agent not found: ${agentId}`);

    const existing = await this.prisma.user.findFirst({
      where: { accountId: agent.accountId, deletedAt: null },
      select: { id: true },
    });
    if (existing) return existing.id;

    const created = await this.prisma.user.create({
      data: {
        accountId: agent.accountId,
        externalId: 'entity-profile-default',
        displayName: 'Entity Profiles',
      },
    });
    return created.id;
  }

  // ── CRUD ─────────────────────────────────────────────────────────────

  async create(agentId: string, dto: CreateProfileDto) {
    const userId = await this.getOrCreateUser(agentId);
    const { attributes: attrDtos, ...profileData } = dto;

    return this.prisma.$transaction(async (tx) => {
      const profile = await tx.entityProfile.create({
        data: {
          userId,
          name: profileData.name,
          type: profileData.type,
          normalizedName: profileData.name.toLowerCase().trim(),
          description: profileData.description,
          aliases: profileData.aliases ?? [],
          tags: profileData.tags ?? [],
          source: 'MANUAL',
          verified: true,
        },
      });

      if (attrDtos?.length) {
        await tx.entityAttribute.createMany({
          data: attrDtos.map((a) => ({
            profileId: profile.id,
            key: a.key,
            value: a.value,
            valueType: a.valueType ?? AttributeType.STRING,
            category: a.category ?? null,
            source: 'MANUAL',
            confidence: 1.0,
            verified: true,
          })),
        });
      }

      return tx.entityProfile.findUnique({
        where: { id: profile.id },
        include: { attributes: true },
      });
    });
  }

  async list(accountId: string, dto: ListProfilesDto) {
    const { type, search, page = 1, limit = 25 } = dto;
    const skip = (page - 1) * limit;
    const accountUserIds = await this.resolveAccountUserIds(accountId);

    const where: any = {
      userId: { in: accountUserIds },
      deletedAt: null,
      ...(type ? { type } : {}),
    };

    if (search) {
      const lowerSearch = search.toLowerCase();
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { normalizedName: { contains: lowerSearch } },
        { aliases: { has: search } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [profiles, total] = await this.prisma.$transaction([
      this.prisma.entityProfile.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          attributes: true,
          _count: { select: { memories: true } },
        },
      }),
      this.prisma.entityProfile.count({ where }),
    ]);

    return {
      profiles,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getById(accountId: string, id: string) {
    const accountUserIds = await this.resolveAccountUserIds(accountId);

    const profile = await this.prisma.entityProfile.findFirst({
      where: {
        id,
        userId: { in: accountUserIds },
        deletedAt: null,
      },
      include: {
        attributes: { orderBy: { createdAt: 'desc' } },
        _count: { select: { memories: true } },
        entity: {
          include: {
            _count: {
              select: {
                memories: true,
              },
            },
          },
        },
      },
    });

    if (!profile) {
      throw new NotFoundException(`Entity profile ${id} not found`);
    }
    return profile;
  }

  async update(accountId: string, id: string, dto: UpdateProfileDto) {
    // Verify ownership first
    await this.getById(accountId, id);

    const { attributes: _attrs, ...updateData } = dto;
    const data: any = { ...updateData };

    if (dto.name) {
      data.normalizedName = dto.name.toLowerCase().trim();
    }

    return this.prisma.entityProfile.update({
      where: { id },
      data,
      include: { attributes: true },
    });
  }

  async softDelete(accountId: string, id: string) {
    await this.getById(accountId, id);
    return this.prisma.entityProfile.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  // ── Attributes ───────────────────────────────────────────────────────

  async addAttribute(
    accountId: string,
    profileId: string,
    dto: CreateAttributeDto,
  ) {
    await this.getById(accountId, profileId);
    return this.prisma.entityAttribute.create({
      data: {
        profileId,
        key: dto.key,
        value: dto.value,
        valueType: dto.valueType ?? AttributeType.STRING,
        category: dto.category ?? null,
        source: dto.source ?? 'MANUAL',
        confidence: 1.0,
        verified: true,
      },
    });
  }

  async updateAttribute(
    accountId: string,
    profileId: string,
    attrId: string,
    dto: UpdateAttributeDto,
  ) {
    await this.getById(accountId, profileId);

    // Verify attribute belongs to profile
    const attr = await this.prisma.entityAttribute.findFirst({
      where: { id: attrId, profileId },
    });
    if (!attr) {
      throw new NotFoundException(
        `Attribute ${attrId} not found on profile ${profileId}`,
      );
    }

    return this.prisma.entityAttribute.update({
      where: { id: attrId },
      data: dto,
    });
  }

  async removeAttribute(
    accountId: string,
    profileId: string,
    attrId: string,
  ) {
    await this.getById(accountId, profileId);

    const attr = await this.prisma.entityAttribute.findFirst({
      where: { id: attrId, profileId },
    });
    if (!attr) {
      throw new NotFoundException(
        `Attribute ${attrId} not found on profile ${profileId}`,
      );
    }

    return this.prisma.entityAttribute.delete({ where: { id: attrId } });
  }

  // ── Memories ─────────────────────────────────────────────────────────

  async attachMemory(
    accountId: string,
    profileId: string,
    memoryId: string,
    relevanceScore = 1.0,
  ) {
    await this.getById(accountId, profileId);
    return this.prisma.entityProfileMemory.upsert({
      where: { profileId_memoryId: { profileId, memoryId } },
      create: {
        profileId,
        memoryId,
        relevanceScore,
        attachMethod: 'MANUAL',
      },
      update: { relevanceScore },
    });
  }

  async detachMemory(
    accountId: string,
    profileId: string,
    memoryId: string,
  ) {
    await this.getById(accountId, profileId);
    return this.prisma.entityProfileMemory.delete({
      where: { profileId_memoryId: { profileId, memoryId } },
    });
  }
}

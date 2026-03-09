import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateProfileDto } from "./dto/create-profile.dto";
import { UpdateProfileDto } from "./dto/update-profile.dto";
import { CreateAttributeDto } from "./dto/create-attribute.dto";
import { ListProfilesDto } from "./dto/list-profiles.dto";

@Injectable()
export class EntityProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, dto: CreateProfileDto) {
    return this.prisma.entityProfile.create({
      data: {
        ...dto,
        userId,
        normalizedName: dto.name.toLowerCase().trim(),
      },
    });
  }

  async list(userId: string, dto: ListProfilesDto) {
    const { type, search, page = 1, limit = 20 } = dto;
    const skip = (page - 1) * limit;

    const where: any = {
      userId,
      deletedAt: null,
      ...(type ? { type } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: "insensitive" } },
              { normalizedName: { contains: search.toLowerCase() } },
            ],
          }
        : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.entityProfile.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          _count: { select: { memories: true, attributes: true } },
        },
      }),
      this.prisma.entityProfile.count({ where }),
    ]);

    return { items, total, page, limit };
  }

  async getById(userId: string, id: string) {
    const profile = await this.prisma.entityProfile.findFirst({
      where: { id, userId, deletedAt: null },
      include: {
        attributes: { orderBy: { createdAt: "desc" } },
        _count: { select: { memories: true } },
      },
    });
    if (!profile) throw new NotFoundException(`EntityProfile not found`);
    return profile;
  }

  async update(userId: string, id: string, dto: UpdateProfileDto) {
    await this.getById(userId, id);
    return this.prisma.entityProfile.update({
      where: { id },
      data: {
        ...dto,
        ...(dto.name ? { normalizedName: dto.name.toLowerCase().trim() } : {}),
      },
    });
  }

  async softDelete(userId: string, id: string) {
    await this.getById(userId, id);
    return this.prisma.entityProfile.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  async addAttribute(userId: string, profileId: string, dto: CreateAttributeDto) {
    await this.getById(userId, profileId);
    return this.prisma.entityAttribute.create({
      data: { ...dto, profileId },
    });
  }

  async updateAttribute(userId: string, profileId: string, attrId: string, dto: Partial<CreateAttributeDto>) {
    await this.getById(userId, profileId);
    return this.prisma.entityAttribute.update({
      where: { id: attrId },
      data: dto,
    });
  }

  async removeAttribute(userId: string, profileId: string, attrId: string) {
    await this.getById(userId, profileId);
    return this.prisma.entityAttribute.delete({ where: { id: attrId } });
  }

  async attachMemory(userId: string, profileId: string, memoryId: string, relevanceScore = 1.0, attachMethod = "MANUAL") {
    await this.getById(userId, profileId);
    return this.prisma.entityProfileMemory.upsert({
      where: { profileId_memoryId: { profileId, memoryId } },
      create: { profileId, memoryId, relevanceScore, attachMethod: attachMethod as any },
      update: { relevanceScore },
    });
  }

  async detachMemory(userId: string, profileId: string, memoryId: string) {
    await this.getById(userId, profileId);
    return this.prisma.entityProfileMemory.delete({
      where: { profileId_memoryId: { profileId, memoryId } },
    });
  }
}

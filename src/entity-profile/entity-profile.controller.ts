import {
  Controller, Post, Get, Patch, Delete,
  Param, Body, Query, UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { EntityProfileService } from "./entity-profile.service";
import { CreateProfileDto } from "./dto/create-profile.dto";
import { UpdateProfileDto } from "./dto/update-profile.dto";
import { CreateAttributeDto } from "./dto/create-attribute.dto";
import { ListProfilesDto } from "./dto/list-profiles.dto";
import { ApiKeyOrJwtGuard } from "../common/guards/api-key-or-jwt.guard";
import { UserId, Agent } from "../common/decorators/user-id.decorator";

@ApiTags("entity-profiles")
@UseGuards(ApiKeyOrJwtGuard)
@Controller("v1/profiles")
export class EntityProfileController {
  constructor(private readonly service: EntityProfileService) {}

  @Post()
  @ApiOperation({ summary: "Create an entity profile" })
  async create(@UserId() userId: string, @Agent() agent: any, @Body() dto: CreateProfileDto) {
    return this.service.create(userId, dto);
  }

  @Get()
  @ApiOperation({ summary: "List entity profiles" })
  async list(@UserId() userId: string, @Query() query: ListProfilesDto) {
    return this.service.list(userId, query);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get entity profile detail" })
  async getById(@UserId() userId: string, @Param("id") id: string) {
    return this.service.getById(userId, id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update entity profile" })
  async update(@UserId() userId: string, @Param("id") id: string, @Body() dto: UpdateProfileDto) {
    return this.service.update(userId, id, dto);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Soft delete entity profile" })
  async remove(@UserId() userId: string, @Param("id") id: string) {
    return this.service.softDelete(userId, id);
  }

  @Post(":id/attributes")
  @ApiOperation({ summary: "Add attribute to profile" })
  async addAttribute(@UserId() userId: string, @Param("id") id: string, @Body() dto: CreateAttributeDto) {
    return this.service.addAttribute(userId, id, dto);
  }

  @Patch(":id/attributes/:attrId")
  @ApiOperation({ summary: "Update profile attribute" })
  async updateAttribute(
    @UserId() userId: string,
    @Param("id") id: string,
    @Param("attrId") attrId: string,
    @Body() dto: CreateAttributeDto,
  ) {
    return this.service.updateAttribute(userId, id, attrId, dto);
  }

  @Delete(":id/attributes/:attrId")
  @ApiOperation({ summary: "Remove profile attribute" })
  async removeAttribute(
    @UserId() userId: string,
    @Param("id") id: string,
    @Param("attrId") attrId: string,
  ) {
    return this.service.removeAttribute(userId, id, attrId);
  }

  @Post(":id/memories")
  @ApiOperation({ summary: "Attach memory to profile" })
  async attachMemory(
    @UserId() userId: string,
    @Param("id") id: string,
    @Body() body: { memoryId: string; relevanceScore?: number; attachMethod?: string },
  ) {
    return this.service.attachMemory(userId, id, body.memoryId, body.relevanceScore, body.attachMethod);
  }

  @Delete(":id/memories/:memoryId")
  @ApiOperation({ summary: "Detach memory from profile" })
  async detachMemory(
    @UserId() userId: string,
    @Param("id") id: string,
    @Param("memoryId") memoryId: string,
  ) {
    return this.service.detachMemory(userId, id, memoryId);
  }
}

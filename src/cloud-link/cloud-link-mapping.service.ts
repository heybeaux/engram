import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CloudLinkMappingService {
  private readonly logger = new Logger(CloudLinkMappingService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a SyncAgentMap entry mapping local agent ID to cloud agent ID.
   */
  async createAgentMapping(
    instanceId: string,
    localAgentId: string,
    cloudAgentId: string,
  ): Promise<void> {
    // Get agent name from the cloud agent
    const agent = await this.prisma.agent.findUnique({
      where: { id: cloudAgentId },
      select: { name: true },
    });
    const agentName = agent?.name || localAgentId;

    await this.prisma.syncAgentMap.upsert({
      where: {
        instanceId_localAgentId: { instanceId, localAgentId },
      },
      create: {
        instanceId,
        localAgentId,
        cloudAgentId,
        agentName,
      },
      update: {
        cloudAgentId,
        agentName,
      },
    });
    this.logger.log(
      `Created agent mapping: ${localAgentId} → ${cloudAgentId} (${agentName})`,
    );
  }

  /**
   * Create a SyncUserMap entry mapping local user ID to cloud user ID.
   */
  async createUserMapping(
    instanceId: string,
    localUserId: string,
    cloudUserId: string,
    externalId: string,
  ): Promise<void> {
    await this.prisma.syncUserMap.upsert({
      where: {
        instanceId_localUserId: { instanceId, localUserId },
      },
      create: {
        instanceId,
        localUserId,
        cloudUserId,
        externalId,
      },
      update: {
        cloudUserId,
        externalId,
      },
    });
    this.logger.log(`Created user mapping: ${localUserId} → ${cloudUserId}`);
  }
}

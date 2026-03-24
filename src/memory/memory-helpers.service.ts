import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class MemoryHelpersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve user IDs for account-wide search.
   * Works for all authenticated requests (instance keys, regular API keys, JWT).
   * If agentId is provided, scopes to that agent's users only.
   */
  async resolveAccountUserIds(
    req: any,
    agentId?: string,
  ): Promise<string[] | null> {
    // Derive accountId from request or from the attached agent
    const accountId = req.accountId ?? req.agent?.accountId;
    if (!accountId) return null;

    const where: any = { deletedAt: null };
    if (agentId) {
      // Scope to users from the account that owns this agent
      where.account = { agents: { some: { id: agentId, deletedAt: null } } };
    } else {
      where.accountId = accountId;
    }

    const users = await this.prisma.user.findMany({
      where,
      select: { id: true },
    });
    return users.length > 0 ? users.map((u) => u.id) : null;
  }
}

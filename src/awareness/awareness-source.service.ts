import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { randomUUID } from 'crypto';

export interface SignalSourceConfig {
  id: string;
  name: string;
  type: 'linear' | 'github' | 'memory' | 'custom';
  enabled: boolean;
  config: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

const SOURCE_PREFIX = 'source:';
const SYSTEM_ACCOUNT_ID = 'system';

/**
 * AwarenessSourceService (HEY-286, HEY-380)
 *
 * CRUD for awareness signal source configurations.
 * Persisted to AwarenessState rows (signalSource = 'source:{id}').
 * In-memory Map serves as a write-through cache loaded on init.
 */
@Injectable()
export class AwarenessSourceService implements OnModuleInit {
  private readonly logger = new Logger(AwarenessSourceService.name);
  private readonly sources = new Map<string, SignalSourceConfig>();

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.loadFromDb();
    } catch (error) {
      this.logger.warn(
        `Failed to load signal sources on init (DB may not be ready): ${error.message}`,
      );
    }
  }

  private async loadFromDb(): Promise<void> {
    const rows = await this.prisma.awarenessState.findMany({
      where: {
        accountId: SYSTEM_ACCOUNT_ID,
        signalSource: { startsWith: SOURCE_PREFIX },
      },
    });

    for (const row of rows) {
      if (row.checkpoint) {
        const source = row.checkpoint as unknown as SignalSourceConfig;
        // Restore Date objects from JSON
        source.createdAt = new Date(source.createdAt);
        source.updatedAt = new Date(source.updatedAt);
        this.sources.set(source.id, source);
      }
    }

    if (this.sources.size > 0) {
      this.logger.log(
        `Loaded ${this.sources.size} signal source config(s) from database`,
      );
    }
  }

  private async persistSource(source: SignalSourceConfig): Promise<void> {
    await this.prisma.awarenessState.upsert({
      where: {
        accountId_signalSource: {
          accountId: SYSTEM_ACCOUNT_ID,
          signalSource: `${SOURCE_PREFIX}${source.id}`,
        },
      },
      update: {
        checkpoint: source as any,
        lastCheckedAt: new Date(),
      },
      create: {
        accountId: SYSTEM_ACCOUNT_ID,
        signalSource: `${SOURCE_PREFIX}${source.id}`,
        lastCheckedAt: new Date(),
        checkpoint: source as any,
      },
    });
  }

  async create(dto: {
    name: string;
    type: 'linear' | 'github' | 'memory' | 'custom';
    enabled?: boolean;
    config?: Record<string, any>;
  }): Promise<SignalSourceConfig> {
    const source: SignalSourceConfig = {
      id: randomUUID(),
      name: dto.name,
      type: dto.type,
      enabled: dto.enabled ?? true,
      config: dto.config || {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.sources.set(source.id, source);
    await this.persistSource(source);
    this.logger.log(`Created signal source "${source.name}" (${source.type})`);
    return source;
  }

  listAll(): SignalSourceConfig[] {
    return Array.from(this.sources.values());
  }

  getById(id: string): SignalSourceConfig {
    const source = this.sources.get(id);
    if (!source) throw new NotFoundException(`Signal source ${id} not found`);
    return source;
  }

  async update(
    id: string,
    dto: { name?: string; enabled?: boolean; config?: Record<string, any> },
  ): Promise<SignalSourceConfig> {
    const source = this.getById(id);
    if (dto.name !== undefined) source.name = dto.name;
    if (dto.enabled !== undefined) source.enabled = dto.enabled;
    if (dto.config !== undefined)
      source.config = { ...source.config, ...dto.config };
    source.updatedAt = new Date();
    await this.persistSource(source);
    return source;
  }

  getStatus(id: string): {
    id: string;
    name: string;
    type: string;
    enabled: boolean;
    healthy: boolean;
    lastChecked: string;
    message: string;
  } {
    const source = this.getById(id);
    return {
      id: source.id,
      name: source.name,
      type: source.type,
      enabled: source.enabled,
      healthy: source.enabled,
      lastChecked: new Date().toISOString(),
      message: source.enabled
        ? 'Source is configured and active'
        : 'Source is disabled',
    };
  }

  async delete(id: string): Promise<{ deleted: true }> {
    const source = this.getById(id);
    this.sources.delete(id);
    await this.prisma.awarenessState.deleteMany({
      where: {
        accountId: SYSTEM_ACCOUNT_ID,
        signalSource: `${SOURCE_PREFIX}${id}`,
      },
    });
    this.logger.log(`Deleted signal source "${source.name}"`);
    return { deleted: true };
  }
}

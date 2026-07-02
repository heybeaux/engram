import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto, TaskStatus } from './dto/update-task.dto';
import { QueryTaskDto } from './dto/query-task.dto';
import { DelegationLedgerService } from './delegation-ledger.service';

@Injectable()
export class TaskService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly ledger?: DelegationLedgerService,
  ) {}

  async create(userId: string, dto: CreateTaskDto) {
    const task = await this.prisma.delegatedTask.create({
      data: {
        userId,
        assignedTo: dto.assignedTo,
        assignedBy: dto.assignedBy,
        taskDescription: dto.taskDescription,
        deadline: dto.deadline ? new Date(dto.deadline) : undefined,
        metadata: dto.metadata ?? undefined,
        templateId: dto.templateId,
        contractId: dto.contractId,
      },
    });
    await this.ledger?.recordEvent(userId, {
      eventType: 'TASK_ASSIGNED',
      source: 'ENGRAM',
      contractId: task.contractId ?? undefined,
      taskId: task.id,
      agentId: task.assignedTo,
      payload: {
        assignedBy: task.assignedBy,
        assignedTo: task.assignedTo,
        taskDescription: task.taskDescription,
        deadline: task.deadline?.toISOString?.() ?? task.deadline,
      },
    });
    return task;
  }

  async update(userId: string, id: string, dto: UpdateTaskDto) {
    const task = await this.prisma.delegatedTask.findFirst({
      where: { id, userId },
    });
    if (!task) throw new NotFoundException('Task not found');

    const data: any = {};
    if (dto.status) {
      data.status = dto.status;
      if (dto.status === 'COMPLETED' || dto.status === 'FAILED') {
        data.completedAt = new Date();
      }
    }
    if (dto.result !== undefined) data.result = dto.result;

    const updated = await this.prisma.delegatedTask.update({
      where: { id },
      data,
    });
    if (dto.status) {
      await this.ledger?.recordEvent(userId, {
        eventType: this.eventTypeForStatus(dto.status),
        source: 'ENGRAM',
        contractId: updated.contractId ?? task.contractId ?? undefined,
        taskId: id,
        agentId: updated.assignedTo ?? task.assignedTo,
        payload: {
          previousStatus: task.status,
          status: dto.status,
          result: dto.result,
        },
      });
    }
    return updated;
  }

  async findAll(userId: string, query: QueryTaskDto) {
    const where: any = { userId };
    if (query.status) where.status = query.status;
    if (query.assignedTo) where.assignedTo = query.assignedTo;
    if (query.assignedBy) where.assignedBy = query.assignedBy;
    if (query.contractId) where.contractId = query.contractId;

    return this.prisma.delegatedTask.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { template: true, contract: true },
    });
  }

  async findOne(userId: string, id: string) {
    const task = await this.prisma.delegatedTask.findFirst({
      where: { id, userId },
      include: { template: true, contract: true },
    });
    if (!task) throw new NotFoundException('Task not found');
    return task;
  }

  private eventTypeForStatus(status: TaskStatus) {
    switch (status) {
      case 'IN_PROGRESS':
        return 'TASK_STARTED' as const;
      case 'COMPLETED':
        return 'TASK_COMPLETED' as const;
      case 'FAILED':
        return 'TASK_FAILED' as const;
      default:
        return 'TASK_ASSIGNED' as const;
    }
  }
}

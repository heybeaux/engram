import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RecordValidationDto } from './dto/record-validation.dto';
import { AttachReceiptDto } from './dto/attach-receipt.dto';
import {
  DelegationEventSource,
  DelegationEventType,
  RecordEventDto,
} from './dto/record-event.dto';

type EvidenceSignal = {
  signalType: 'SUCCESS' | 'FAILURE' | 'CORRECTION';
  weight: number;
  reason: string;
};

@Injectable()
export class DelegationLedgerService {
  constructor(private readonly prisma: PrismaService) {}

  async recordEvent(
    userId: string,
    dto: RecordEventDto & {
      eventType: DelegationEventType;
      source?: DelegationEventSource;
    },
  ) {
    if (dto.contractId) await this.assertContract(userId, dto.contractId);
    if (dto.taskId) await this.assertTask(userId, dto.taskId);

    return this.prisma.delegationEvent.create({
      data: {
        userId,
        contractId: dto.contractId ?? null,
        taskId: dto.taskId ?? null,
        agentSessionKey: dto.agentSessionKey ?? null,
        eventType: dto.eventType,
        agentId: dto.agentId ?? null,
        parentEventId: dto.parentEventId ?? null,
        traceId: dto.traceId ?? null,
        source: dto.source ?? 'ENGRAM',
        payload: dto.payload ?? {},
      },
    });
  }

  async recordValidation(
    userId: string,
    contractId: string,
    dto: RecordValidationDto,
  ) {
    const contract = await this.assertContract(userId, contractId);
    if (dto.taskId) await this.assertTask(userId, dto.taskId);

    const stateContract = dto.stateContract ?? {};
    const validationResult = dto.validationResult ?? {};
    const metadata = this.asRecord(stateContract.metadata);
    const l0 = this.asRecord(metadata.l0);

    const latticeContractId =
      dto.latticeContractId ?? this.stringField(stateContract.id);
    const traceId = dto.traceId ?? this.stringField(stateContract.traceId);
    const passed = dto.passed ?? Boolean(validationResult.passed);
    const tier =
      dto.tier ?? this.stringField(validationResult.tier) ?? 'unknown';
    const tiersRun =
      dto.tiersRun ?? this.stringArray(validationResult.tiersRun);
    const durationMs =
      dto.durationMs ?? this.numberField(validationResult.durationMs);
    const reason = dto.reason ?? this.stringField(validationResult.reason);
    const confidence =
      dto.confidence ?? this.numberField(validationResult.confidence);
    const providerFailure =
      dto.providerFailure ?? Boolean(validationResult.providerFailure);
    const evidence =
      dto.evidence ??
      this.arrayField(validationResult.evidence) ??
      this.arrayField(l0.evidence) ??
      [];

    const validation = await this.prisma.delegationValidation.create({
      data: {
        userId,
        contractId,
        taskId: dto.taskId ?? null,
        latticeContractId: latticeContractId ?? null,
        traceId: traceId ?? null,
        passed,
        tier,
        tiersRun,
        durationMs: durationMs ?? null,
        reason: reason ?? null,
        confidence: confidence ?? null,
        providerFailure,
        evidence,
        stateContract,
        validationResult,
      },
    });

    await this.recordEvent(userId, {
      eventType: 'HANDOFF_VALIDATED',
      source: 'LATTICE',
      contractId,
      taskId: dto.taskId,
      agentId: contract.delegate,
      traceId: validation.traceId ?? undefined,
      payload: {
        validationId: validation.id,
        latticeContractId: validation.latticeContractId,
        passed: validation.passed,
        tier: validation.tier,
        tiersRun: validation.tiersRun,
        reason: validation.reason,
        confidence: validation.confidence,
        providerFailure: validation.providerFailure,
      },
    });

    await this.recordTrustFromValidation(userId, contract, validation);
    return validation;
  }

  async attachReceipt(userId: string, taskId: string, dto: AttachReceiptDto) {
    const task = await this.assertTask(userId, taskId);
    const contractId = dto.contractId ?? task.contractId ?? undefined;
    if (contractId) await this.assertContract(userId, contractId);

    const receipt = dto.receipt ?? {};
    const receiptId = this.stringField(receipt.id);
    if (!receiptId) throw new BadRequestException('receipt.id is required');

    const claim = this.asRecord(receipt.claim);
    const actor = this.asRecord(receipt.actor);
    const verification = this.asRecord(receipt.verification);
    const risk = this.asRecord(receipt.risk);
    const integrity = this.asRecord(receipt.integrity);
    const checks = this.arrayField(verification.checks) ?? [];
    const artifactHashes = this.arrayField(integrity.artifacts) ?? [];
    const payloadHash = this.stringField(integrity.receipt_payload_sha256);
    const integrityStatus = payloadHash
      ? this.computeReceiptPayloadHash(receipt) === payloadHash
        ? 'clean'
        : 'payload_mismatch'
      : 'missing_integrity';

    const row = await this.prisma.delegationReceipt.upsert({
      where: { userId_receiptId: { userId, receiptId } },
      create: {
        userId,
        contractId: contractId ?? null,
        taskId,
        receiptId,
        status: this.stringField(receipt.status) ?? 'needs-review',
        claimSummary: this.stringField(claim.summary) ?? 'Delegation receipt',
        actorId: this.stringField(actor.id),
        actorModel: this.stringField(actor.model),
        verificationSummary: this.stringField(verification.summary),
        checks,
        riskLevel: this.stringField(risk.level),
        artifactUri: dto.artifactUri ?? null,
        payloadHash,
        artifactHashes,
        receipt,
        integrityStatus,
      },
      update: {
        contractId: contractId ?? null,
        taskId,
        status: this.stringField(receipt.status) ?? 'needs-review',
        claimSummary: this.stringField(claim.summary) ?? 'Delegation receipt',
        actorId: this.stringField(actor.id),
        actorModel: this.stringField(actor.model),
        verificationSummary: this.stringField(verification.summary),
        checks,
        riskLevel: this.stringField(risk.level),
        artifactUri: dto.artifactUri ?? null,
        payloadHash,
        artifactHashes,
        receipt,
        integrityStatus,
      },
    });

    await this.recordEvent(userId, {
      eventType: 'RECEIPT_ATTACHED',
      source: 'RECEIPTS',
      contractId,
      taskId,
      agentId: task.assignedTo,
      payload: {
        delegationReceiptId: row.id,
        receiptId: row.receiptId,
        status: row.status,
        claimSummary: row.claimSummary,
        integrityStatus: row.integrityStatus,
        verificationSummary: row.verificationSummary,
        checks,
        riskLevel: row.riskLevel,
      },
    });

    await this.recordTrustFromReceipt(userId, task, row);
    return row;
  }

  async getTaskTrustReport(userId: string, taskId: string) {
    const task = await this.prisma.delegatedTask.findFirst({
      where: { id: taskId, userId },
      include: {
        contract: true,
        validations: { orderBy: { createdAt: 'desc' } },
        receipts: { orderBy: { createdAt: 'desc' } },
        events: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!task) throw new NotFoundException('Task not found');

    const trustSignals = await this.prisma.trustSignal.findMany({
      where: {
        userId,
        metadata: { path: ['delegationTaskId'], equals: taskId },
      } as any,
      orderBy: { createdAt: 'desc' },
    });

    const latestValidation = task.validations[0] ?? null;
    const latestReceipt = task.receipts[0] ?? null;
    return {
      task,
      contract: task.contract,
      status: task.status,
      currentBlocker: this.currentBlocker(latestValidation, latestReceipt),
      latestValidation,
      latestReceipt,
      events: task.events,
      trustSignals,
      trustSummary: this.summarizeTrustSignals(trustSignals),
      evidenceSummary: {
        validationCount: task.validations.length,
        receiptCount: task.receipts.length,
        eventCount: task.events.length,
        hasCleanValidation: task.validations.some(
          (v) => v.passed && !v.providerFailure,
        ),
        hasSelfVerifiedReceipt: task.receipts.some(
          (r) => r.status === 'self-verified' && r.integrityStatus === 'clean',
        ),
      },
    };
  }

  async getAgentTrustReports(userId: string, agentId: string) {
    const tasks = await this.prisma.delegatedTask.findMany({
      where: { userId, assignedTo: agentId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        contract: true,
        validations: { orderBy: { createdAt: 'desc' }, take: 1 },
        receipts: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });

    const trustSignals = await this.prisma.trustSignal.findMany({
      where: { userId, agentId },
      orderBy: { createdAt: 'desc' },
      take: 250,
    });

    return {
      agentId,
      tasks: tasks.map((task) => ({
        id: task.id,
        taskDescription: task.taskDescription,
        status: task.status,
        assignedBy: task.assignedBy,
        contractId: task.contractId,
        contractStatus: task.contract?.status ?? null,
        latestValidation: task.validations[0] ?? null,
        latestReceipt: task.receipts[0] ?? null,
        currentBlocker: this.currentBlocker(
          task.validations[0] ?? null,
          task.receipts[0] ?? null,
        ),
      })),
      trustSummary: this.summarizeTrustSignals(trustSignals),
      trustSignals,
    };
  }

  private async recordTrustFromValidation(
    userId: string,
    contract: { id: string; delegate: string; taskDescription: string },
    validation: {
      id: string;
      taskId: string | null;
      passed: boolean;
      providerFailure: boolean;
      tier: string;
      reason: string | null;
      confidence: number | null;
    },
  ) {
    let signal: EvidenceSignal | null = null;
    if (validation.passed && !validation.providerFailure) {
      signal = {
        signalType: 'SUCCESS',
        weight: 0.7,
        reason: `Lattice validation passed at ${validation.tier}`,
      };
    } else if (!validation.passed) {
      signal = {
        signalType: 'FAILURE',
        weight: 1.0,
        reason: `Lattice validation failed at ${validation.tier}${
          validation.reason ? `: ${validation.reason}` : ''
        }`,
      };
    }
    if (!signal) return;

    await this.prisma.trustSignal.create({
      data: {
        userId,
        agentId: contract.delegate,
        signalType: signal.signalType,
        context: signal.reason,
        category: 'delegation',
        weight: signal.weight,
        metadata: {
          source: 'delegation_validation',
          contractId: contract.id,
          delegationTaskId: validation.taskId,
          validationId: validation.id,
          confidence: validation.confidence,
          providerFailure: validation.providerFailure,
        },
      },
    });

    await this.recordEvent(userId, {
      eventType: 'TRUST_SCORED',
      source: 'ENGRAM',
      contractId: contract.id,
      taskId: validation.taskId ?? undefined,
      agentId: contract.delegate,
      payload: { ...signal, validationId: validation.id },
    });
  }

  private async recordTrustFromReceipt(
    userId: string,
    task: { id: string; assignedTo: string; taskDescription: string },
    receipt: {
      id: string;
      receiptId: string;
      status: string;
      integrityStatus: string | null;
      checks: any;
    },
  ) {
    const checks = this.arrayField(receipt.checks) ?? [];
    const failed = checks.filter(
      (c) => this.asRecord(c).status === 'failed',
    ).length;
    const pending = checks.filter(
      (c) => this.asRecord(c).status === 'pending',
    ).length;
    const notRun = checks.filter(
      (c) => this.asRecord(c).status === 'not-run',
    ).length;
    const passed = checks.filter(
      (c) => this.asRecord(c).status === 'passed',
    ).length;

    let signal: EvidenceSignal | null = null;
    if (failed > 0 || receipt.status === 'rejected') {
      signal = {
        signalType: 'FAILURE',
        weight: 1.2,
        reason: `Receipt ${receipt.receiptId} recorded ${failed} failed check(s)`,
      };
    } else if (
      receipt.status === 'self-verified' &&
      receipt.integrityStatus === 'clean' &&
      passed > 0 &&
      pending === 0 &&
      notRun === 0
    ) {
      signal = {
        signalType: 'SUCCESS',
        weight: 1.3,
        reason: `Receipt ${receipt.receiptId} self-verified with ${passed} passed check(s)`,
      };
    }
    if (!signal) return;

    await this.prisma.trustSignal.create({
      data: {
        userId,
        agentId: task.assignedTo,
        signalType: signal.signalType,
        context: signal.reason,
        category: 'delegation',
        weight: signal.weight,
        metadata: {
          source: 'delegation_receipt',
          delegationTaskId: task.id,
          delegationReceiptId: receipt.id,
          receiptId: receipt.receiptId,
          receiptStatus: receipt.status,
          integrityStatus: receipt.integrityStatus,
          checks: { passed, failed, pending, notRun },
        },
      },
    });

    await this.recordEvent(userId, {
      eventType: 'TRUST_SCORED',
      source: 'ENGRAM',
      taskId: task.id,
      agentId: task.assignedTo,
      payload: { ...signal, receiptId: receipt.receiptId },
    });
  }

  private async assertContract(userId: string, contractId: string) {
    const contract = await this.prisma.delegationContract.findFirst({
      where: { id: contractId, userId },
    });
    if (!contract) throw new NotFoundException('Contract not found');
    return contract;
  }

  private async assertTask(userId: string, taskId: string) {
    const task = await this.prisma.delegatedTask.findFirst({
      where: { id: taskId, userId },
    });
    if (!task) throw new NotFoundException('Task not found');
    return task;
  }

  private computeReceiptPayloadHash(receipt: Record<string, any>): string {
    return createHash('sha256')
      .update(JSON.stringify({ ...receipt, integrity: undefined }))
      .digest('hex');
  }

  private currentBlocker(validation: any, receipt: any): string | null {
    if (validation && !validation.passed) return 'validation_failed';
    if (validation?.providerFailure) return 'validation_provider_degraded';
    if (receipt?.status === 'rejected') return 'receipt_rejected';
    if (receipt?.integrityStatus === 'payload_mismatch')
      return 'receipt_integrity_mismatch';
    const checks = this.arrayField(receipt?.checks) ?? [];
    if (checks.some((c) => this.asRecord(c).status === 'failed')) {
      return 'receipt_check_failed';
    }
    if (
      checks.some((c) =>
        ['pending', 'not-run'].includes(String(this.asRecord(c).status)),
      )
    ) {
      return 'receipt_checks_incomplete';
    }
    return null;
  }

  private summarizeTrustSignals(signals: any[]) {
    const successCount = signals.filter(
      (s) => s.signalType === 'SUCCESS',
    ).length;
    const failureCount = signals.filter(
      (s) => s.signalType === 'FAILURE',
    ).length;
    const correctionCount = signals.filter(
      (s) => s.signalType === 'CORRECTION',
    ).length;
    const weightedTotal = signals.reduce((sum, s) => {
      const direction = s.signalType === 'SUCCESS' ? 1 : -1;
      return sum + direction * Math.abs(Number(s.weight ?? 1));
    }, 0);
    return {
      signalCount: signals.length,
      successCount,
      failureCount,
      correctionCount,
      weightedTotal,
    };
  }

  private asRecord(value: any): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : {};
  }

  private stringField(value: any): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private numberField(value: any): number | undefined {
    return typeof value === 'number' && Number.isFinite(value)
      ? value
      : undefined;
  }

  private arrayField(value: any): any[] | undefined {
    return Array.isArray(value) ? value : undefined;
  }

  private stringArray(value: any): string[] {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  }
}

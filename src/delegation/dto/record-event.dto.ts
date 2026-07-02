import { IsIn, IsObject, IsOptional, IsString } from 'class-validator';

export const DELEGATION_EVENT_TYPES = [
  'CONTRACT_CREATED',
  'CONTRACT_ACCEPTED',
  'CONTRACT_STARTED',
  'CONTRACT_COMPLETED',
  'CONTRACT_VERIFIED',
  'CONTRACT_REJECTED',
  'TASK_ASSIGNED',
  'TASK_STARTED',
  'TASK_COMPLETED',
  'TASK_FAILED',
  'HANDOFF_VALIDATED',
  'RECEIPT_ATTACHED',
  'TRUST_SCORED',
  'CHALLENGE_RAISED',
  'AOP_EVENT_RECORDED',
] as const;

export const DELEGATION_EVENT_SOURCES = [
  'ENGRAM',
  'SONDER',
  'LATTICE',
  'RECEIPTS',
  'OPENCLAW',
] as const;

export type DelegationEventType = (typeof DELEGATION_EVENT_TYPES)[number];
export type DelegationEventSource = (typeof DELEGATION_EVENT_SOURCES)[number];

export class RecordEventDto {
  @IsIn(DELEGATION_EVENT_TYPES)
  eventType: DelegationEventType;

  @IsOptional()
  @IsIn(DELEGATION_EVENT_SOURCES)
  source?: DelegationEventSource;

  @IsOptional()
  @IsString()
  contractId?: string;

  @IsOptional()
  @IsString()
  taskId?: string;

  @IsOptional()
  @IsString()
  agentSessionKey?: string;

  @IsOptional()
  @IsString()
  agentId?: string;

  @IsOptional()
  @IsString()
  parentEventId?: string;

  @IsOptional()
  @IsString()
  traceId?: string;

  @IsOptional()
  @IsObject()
  payload?: Record<string, any>;
}

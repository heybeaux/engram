import {
  IsString,
  IsOptional,
  IsNumber,
  IsIn,
  IsArray,
  Min,
  Max,
} from 'class-validator';

// ── Trust Signals (existing) ──────────────────────────────────────────

export class RecordTrustSignalDto {
  @IsIn(['SUCCESS', 'FAILURE', 'CORRECTION'])
  signalType: 'SUCCESS' | 'FAILURE' | 'CORRECTION';

  @IsString()
  context: string;

  @IsOptional()
  @IsString()
  agentId?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  weight?: number;

  @IsOptional()
  @IsString()
  sourceMemoryId?: string;
}

export class ComputeScoreDto {
  @IsOptional()
  @IsString()
  agentId?: string;

  @IsOptional()
  @IsString()
  category?: string;
}

// ── HEY-177: Task Outcomes ────────────────────────────────────────────

export class CreateTaskOutcomeDto {
  @IsString()
  taskDescription: string;

  @IsIn(['success', 'partial', 'failure'])
  outcome: 'success' | 'partial' | 'failure';

  @IsOptional()
  @IsNumber()
  durationMs?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  lessonsLearned?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  capabilitiesUsed?: string[];

  @IsOptional()
  @IsString()
  agentSessionKey?: string;
}

export class TaskOutcomeResponseDto {
  id: string;
  taskDescription: string;
  outcome: string;
  durationMs?: number;
  lessonsLearned?: string[];
  capabilitiesUsed?: string[];
  createdAt: Date;
}

// ── HEY-180: Self-Assessments ─────────────────────────────────────────

export class CreateSelfAssessmentDto {
  @IsString()
  area: string;

  @IsNumber()
  @Min(0)
  @Max(10)
  selfRating: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  confidence?: number;

  @IsOptional()
  @IsString()
  reasoning?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  evidence?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  goals?: string[];
}

export class SelfAssessmentResponseDto {
  id: string;
  area: string;
  selfRating: number;
  confidence: number;
  reasoning?: string;
  evidence?: string[];
  goals?: string[];
  createdAt: Date;
}

// ── HEY-179: Capability Profiles ──────────────────────────────────────

export class CapabilityProfileDto {
  capability: string;
  confidence: number;
  evidenceCount: number;
  successRate: number;
  firstSeen?: string;
  lastSeen?: string;
}

export class CapabilityProfileResponseDto {
  agentId: string;
  capabilities: CapabilityProfileDto[];
  updatedAt?: Date;
}

// ── HEY-169: Capability Signals (extraction pipeline) ─────────────────

export class CapabilitySignalDto {
  capability: string;
  evidence: string;
  confidence: number;
  firstSeen?: string;
  lastSeen?: string;
  occurrences: number;
}

// ── HEY-171: Preference Layer ─────────────────────────────────────────

export class PreferenceDto {
  category: string;
  preference: string;
  strength: 'weak' | 'moderate' | 'strong';
  source?: string;
}

// ── Work Style ────────────────────────────────────────────────────────

export class WorkStyleDimensionDto {
  dimension: string;
  value: Record<string, any>;
  sampleCount: number;
}

// ── HEY-178: Full Identity Profile ───────────────────────────────────

export class TrustSignalsSummaryDto {
  totalMemories: number;
  identityMemories: number;
  lessonMemories: number;
  constraintMemories: number;
  averageConfidence: number;
  oldestMemory: string | null;
  newestMemory: string | null;
}

export class BehavioralPatternDto {
  pattern: string;
  frequency: number;
  category?: string;
}

export class IdentityProfileResponseDto {
  agentId: string;
  name?: string;
  description?: string;
  createdAt?: string;
  capabilities: CapabilityProfileDto[];
  preferences?: PreferenceDto[];
  workStyle: WorkStyleDimensionDto[];
  selfAssessments: SelfAssessmentResponseDto[];
  recentOutcomes: TaskOutcomeResponseDto[];
  trustSignals?: TrustSignalsSummaryDto;
  recentPatterns?: BehavioralPatternDto[];
}

// ── Active Projects Query ─────────────────────────────────────────────

export class ActiveProjectDto {
  project: string;
  memoryCount: number;
  latestActivity: Date;
  earliestActivity: Date;
  memoryTypes: string[];
  agents: string[];
}

export class ActiveProjectsResponseDto {
  projects: ActiveProjectDto[];
  totalProjects: number;
}

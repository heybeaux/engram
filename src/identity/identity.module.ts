import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EmbeddingModule } from '../embedding/embedding.module';
import { IdentityController } from './identity.controller';
import { AgentsAliasController } from './agents-alias.controller';
import { DelegationContractController } from './delegation-contract.controller';
import {
  ChallengeController,
  MemoryChallengeController,
} from './challenge.controller';
import { TeamController } from './team.controller';
import { DelegationContractService } from './delegation-contract.service';
import { ChallengeService } from './challenge.service';
import { FailurePatternService } from './failure-pattern.service';
import { TeamProfileService } from './team-profile.service';
import { DelegationRecallService } from './delegation-recall.service';
import { PortableIdentityService } from './portable-identity.service';
import { TaskCompletionService } from './task-completion.service';
import { DelegationTemplateService } from './delegation-template.service';
import { TrustProfileService } from './trust-profile.service';
import { DelegationTaskService } from './delegation-task.service';
import { DelegationController } from './delegation.controller';
import { IdentityService } from './identity.service';
import { TaskOutcomeService } from './task-outcome.service';
import { SelfAssessmentService } from './self-assessment.service';
import { CapabilityProfileService } from './capability-profile.service';
import { WorkStyleService } from './work-style.service';

@Module({
  imports: [PrismaModule, EmbeddingModule],
  controllers: [
    IdentityController,
    AgentsAliasController,
    DelegationContractController,
    ChallengeController,
    MemoryChallengeController,
    TeamController,
    DelegationController,
  ],
  providers: [
    IdentityController,
    IdentityService,
    TaskOutcomeService,
    SelfAssessmentService,
    CapabilityProfileService,
    WorkStyleService,
    DelegationContractService,
    ChallengeService,
    FailurePatternService,
    TeamProfileService,
    DelegationRecallService,
    PortableIdentityService,
    TaskCompletionService,
    DelegationTemplateService,
    TrustProfileService,
    DelegationTaskService,
    TaskOutcomeService,
    SelfAssessmentService,
    CapabilityProfileService,
    WorkStyleService,
  ],
  exports: [
    IdentityService,
    DelegationContractService,
    ChallengeService,
    FailurePatternService,
    TeamProfileService,
    DelegationRecallService,
    PortableIdentityService,
    TaskCompletionService,
    DelegationTemplateService,
    TrustProfileService,
    DelegationTaskService,
    TaskOutcomeService,
    SelfAssessmentService,
    CapabilityProfileService,
    WorkStyleService,
  ],
})
export class IdentityModule implements OnModuleInit {
  private readonly logger = new Logger(IdentityModule.name);

  constructor(
    private readonly contractService: DelegationContractService,
    private readonly challengeService: ChallengeService,
  ) {}

  onModuleInit() {
    this.contractService.setChallengeService(this.challengeService);
    this.logger.log(
      'Identity module initialized — all identity services active',
    );
  }
}

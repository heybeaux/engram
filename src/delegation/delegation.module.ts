import { Module } from '@nestjs/common';
import { TaskController } from './task.controller';
import { TemplateController } from './template.controller';
import { ContractController } from './contract.controller';
import { DelegationLedgerController } from './delegation-ledger.controller';
import { TaskService } from './task.service';
import { TemplateService } from './template.service';
import { ContractService } from './contract.service';
import { DelegationLedgerService } from './delegation-ledger.service';

@Module({
  controllers: [
    TaskController,
    TemplateController,
    ContractController,
    DelegationLedgerController,
  ],
  providers: [
    TaskService,
    TemplateService,
    ContractService,
    DelegationLedgerService,
  ],
  exports: [
    TaskService,
    TemplateService,
    ContractService,
    DelegationLedgerService,
  ],
})
export class DelegationModule {}

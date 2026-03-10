import { Global, Module } from '@nestjs/common';
import { PlanService } from './plan.service';
import { PlanGuard } from './plan.guard';
import { BillingController } from './billing.controller';

/**
 * BillingModule — global module providing plan enforcement infrastructure.
 *
 * Exported providers (PlanService, PlanGuard) are available everywhere
 * without needing to import BillingModule explicitly.
 */
@Global()
@Module({
  controllers: [BillingController],
  providers: [PlanService, PlanGuard],
  exports: [PlanService, PlanGuard],
})
export class BillingModule {}

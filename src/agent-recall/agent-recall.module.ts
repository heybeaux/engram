import { Module } from '@nestjs/common';
import { AgentRecallController } from './agent-recall.controller';
import { AgentRecallService } from './agent-recall.service';
import { AccountModule } from '../account/account.module';

@Module({
  imports: [AccountModule],
  controllers: [AgentRecallController],
  providers: [AgentRecallService],
  exports: [AgentRecallService],
})
export class AgentRecallModule {}

import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MemoryAccessLogService } from './memory-access-log.service';
import { MemoryAccessLogController } from './memory-access-log.controller';
import { QueryLogService } from './query-log.service';
import { AccountModule } from '../account/account.module';

@Module({
  imports: [AccountModule, PrismaModule],
  controllers: [MemoryAccessLogController],
  providers: [MemoryAccessLogService, QueryLogService],
  exports: [MemoryAccessLogService, QueryLogService],
})
export class MemoryAccessLogModule {}

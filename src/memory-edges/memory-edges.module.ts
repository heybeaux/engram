import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AccountModule } from '../account/account.module';
import { MemoryEdgesController } from './memory-edges.controller';
import { MemoryEdgesService } from './memory-edges.service';

@Module({
  imports: [PrismaModule, AccountModule],
  controllers: [MemoryEdgesController],
  providers: [MemoryEdgesService],
  exports: [MemoryEdgesService],
})
export class MemoryEdgesModule {}

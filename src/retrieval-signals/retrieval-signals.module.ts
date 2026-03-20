import { Module } from '@nestjs/common';
import { RetrievalSignalsService } from './retrieval-signals.service';
import { RetrievalSignalsController } from './retrieval-signals.controller';
import { ServicePrismaModule } from '../prisma/service-prisma.module';

@Module({
  imports: [ServicePrismaModule],
  controllers: [RetrievalSignalsController],
  providers: [RetrievalSignalsService],
  exports: [RetrievalSignalsService],
})
export class RetrievalSignalsModule {}

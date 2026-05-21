import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from '../prisma/prisma.module';
import { MemoryModule } from '../memory/memory.module';
import { InboundEmailController } from './inbound-email.controller';
import { InboundEmailService } from './inbound-email.service';
import { LinkedInEmailParserService } from './linkedin-email-parser.service';

@Module({
  imports: [
    PrismaModule,
    MemoryModule,
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 100,
      },
    ]),
  ],
  controllers: [InboundEmailController],
  providers: [InboundEmailService, LinkedInEmailParserService],
})
export class InboundEmailModule {}

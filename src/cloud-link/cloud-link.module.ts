import { Module } from '@nestjs/common';
import { CloudLinkController } from './cloud-link.controller';
import { CloudLinkService } from './cloud-link.service';
import { CloudLinkAuthService } from './cloud-link-auth.service';
import { CloudLinkMappingService } from './cloud-link-mapping.service';
import { AccountModule } from '../account/account.module';

@Module({
  imports: [AccountModule],
  controllers: [CloudLinkController],
  providers: [CloudLinkService, CloudLinkAuthService, CloudLinkMappingService],
  exports: [CloudLinkService],
})
export class CloudLinkModule {}

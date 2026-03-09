import { Module } from '@nestjs/common';
import { EntityProfileController } from './entity-profile.controller';
import { EntityProfileService } from './entity-profile.service';
import { AccountModule } from '../account/account.module';

@Module({
  imports: [AccountModule],
  controllers: [EntityProfileController],
  providers: [EntityProfileService],
  exports: [EntityProfileService],
})
export class EntityProfileModule {}

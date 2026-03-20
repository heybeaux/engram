import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EntityProfileController } from './entity-profile.controller';
import { EntityProfileService } from './entity-profile.service';
import { EntityMentionService } from './entity-mention.service';
import { EntitySemanticService } from './entity-semantic.service';
import { AttachmentPipelineService } from './attachment-pipeline.service';
import { AccountModule } from '../account/account.module';

@Module({
  imports: [AccountModule, ConfigModule],
  controllers: [EntityProfileController],
  providers: [
    EntityProfileService,
    EntityMentionService,
    EntitySemanticService,
    AttachmentPipelineService,
  ],
  exports: [
    EntityProfileService,
    EntityMentionService,
    EntitySemanticService,
    AttachmentPipelineService,
  ],
})
export class EntityProfileModule {}

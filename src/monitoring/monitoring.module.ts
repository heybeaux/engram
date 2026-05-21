import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MonitoringService } from './monitoring.service';
import { MonitoringController } from './monitoring.controller';
import { MonitoringInterceptor } from './monitoring.interceptor';
import { AccountModule } from '../account/account.module';
import { AuditLogWatcherService } from './audit-log-watcher.service';

@Global()
@Module({
  imports: [AccountModule, PrismaModule],
  controllers: [MonitoringController],
  providers: [
    MonitoringService,
    MonitoringInterceptor,
    AuditLogWatcherService,
    { provide: 'MONITORING_SERVICE', useExisting: MonitoringService },
  ],
  exports: [
    MonitoringService,
    MonitoringInterceptor,
    AuditLogWatcherService,
    'MONITORING_SERVICE',
  ],
})
export class MonitoringModule {}

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { PrismaModule } from './prisma/prisma.module';
import { LLMModule } from './llm/llm.module';
import { VectorModule } from './vector/vector.module';
import { MemoryModule } from './memory/memory.module';
import { AutoModule } from './auto/auto.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { AgentModule } from './agent/agent.module';
import { HierarchyModule } from './hierarchy/hierarchy.module';
import { GraphModule } from './graph/graph.module';
import { ReembeddingModule } from './reembedding/reembedding.module';
import { EnsembleModule } from './ensemble/ensemble.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { DeduplicationModule } from './deduplication/deduplication.module';
import { MultiQueryModule } from './multi-query/multi-query.module';
import { ConsolidationModule } from './consolidation/consolidation.module';
import { ClusteringModule } from './clustering/clustering.module';
import { HealthModule } from './health/health.module';
import { SummarizationModule } from './summarization/summarization.module';
import { CorrectionModule } from './correction/correction.module';
import { AgentSessionModule } from './agent-session/agent-session.module';
import { MemoryPoolModule } from './memory-pool/memory-pool.module';
import { MemoryAccessLogModule } from './memory-access-log/memory-access-log.module';
import { ScopedContextModule } from './scoped-context/scoped-context.module';
import { RateLimitModule } from './rate-limit/rate-limit.module';
import { MonitoringModule } from './monitoring/monitoring.module';
import { FogIndexModule } from './fog-index/fog-index.module';
import { EvalModule } from './eval/eval.module';
import { EmbeddingModule } from './embedding/embedding.module';
import { EventModule } from './events/event.module';
import { WebhookModule } from './webhooks/webhook.module';
import { AccountModule } from './account/account.module';
import { StripeModule } from './stripe/stripe.module';
import { FeedbackModule } from './feedback/feedback.module';
import { InstanceModule } from './instance/instance.module';
import { CloudLinkModule } from './cloud-link/cloud-link.module';
import { CloudSyncModule } from './cloud-sync/cloud-sync.module';
import { AwarenessModule } from './awareness/awareness.module';
import { AnticipatoryModule } from './anticipatory/anticipatory.module';
import { IdentityModule } from './identity/identity.module';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { UsageTrackingInterceptor } from './common/interceptors/usage-tracking.interceptor';
import { ChallengeModule } from './challenge/challenge.module';
import { TeamsModule } from './teams/teams.module';
import { DelegationModule } from './delegation/delegation.module';
import { SessionIndexingModule } from './session-indexing/session-indexing.module';
import { InboundEmailModule } from './inbound-email/inbound-email.module';
import { UsageLimitMiddleware } from './common/middleware/usage-limit.middleware';
import { AuthModule } from './common/auth.module';
import { PersistenceModule } from './common/persistence/persistence.module';

const EDITION = process.env.EDITION || 'local';

const coreModules = [
  ConfigModule.forRoot({
    isGlobal: true,
  }),
  AuthModule,
  PersistenceModule,
  ScheduleModule.forRoot(),
  LoggerModule.forRoot({
    pinoHttp: {
      level: process.env.LOG_LEVEL || 'info',
      transport:
        process.env.NODE_ENV !== 'production'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
      customProps: (req: any) => ({
        accountId: req.headers?.['x-am-api-key']
          ? req.headers['x-am-api-key'].slice(0, 8) + '...'
          : undefined,
        userId: req.headers?.['x-am-user-id'] || undefined,
      }),
      autoLogging: {
        ignore: (req: any) => req.url === '/v1/health',
      },
      serializers: {
        req: (req: any) => ({
          method: req.method,
          url: req.url,
        }),
        res: (res: any) => ({
          statusCode: res.statusCode,
        }),
      },
    },
  }),
  ServeStaticModule.forRoot({
    rootPath: join(process.cwd(), 'public'),
    serveRoot: '/',
    serveStaticOptions: {
      index: false,
    },
  }),
  EventModule,
  EmbeddingModule,
  PrismaModule,
  PersistenceModule,
  LLMModule,
  VectorModule,
  MemoryModule,
  AutoModule,
  DashboardModule,
  AgentModule,
  HierarchyModule,
  GraphModule,
  MultiQueryModule,
  DeduplicationModule,
  ConsolidationModule,
  ClusteringModule,
  HealthModule,
  CorrectionModule,
  SummarizationModule,
  MemoryAccessLogModule,
  AgentSessionModule,
  MemoryPoolModule,
  ScopedContextModule,
  FogIndexModule,
  RateLimitModule,
  AccountModule,
  CloudLinkModule,
  CloudSyncModule,
  AwarenessModule,
  AnticipatoryModule,
  IdentityModule,
  ChallengeModule,
  TeamsModule,
  DelegationModule,
  SessionIndexingModule,
  InboundEmailModule,
];

const cloudModules = [
  ReembeddingModule,
  EnsembleModule,
  AnalyticsModule,
  MonitoringModule,
  EvalModule,
  WebhookModule,
  StripeModule,
  FeedbackModule,
  InstanceModule,
];

@Module({
  imports: [...coreModules, ...(EDITION === 'cloud' ? cloudModules : [])],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: UsageTrackingInterceptor,
    },
  ],
})
export class AppModule {}
